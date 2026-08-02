use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::model_residency::PersistentRegistration;
use crate::profile::profile_runtime_root_path;
use crate::write_pid_lockfile;

/// Shared ownership for one resident native engine process.
///
/// Engine modules still own command construction, identity, memory estimates,
/// readiness, progress, and public status. This type owns only the lifecycle
/// invariants that must be identical for llama and MLX: serialized starts,
/// generation identity, child/reap, PID lock, residency registration, stale
/// rollback, and exit monitoring.
pub(crate) struct EngineLifecycle {
    epoch: AtomicU64,
    child: Mutex<Option<Child>>,
    start: Mutex<()>,
    residency: Mutex<Option<PersistentRegistration>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    pid_filename: &'static str,
}

impl EngineLifecycle {
    pub(crate) const fn new(pid_filename: &'static str) -> Self {
        Self {
            epoch: AtomicU64::new(0),
            child: Mutex::new(None),
            start: Mutex::new(()),
            residency: Mutex::new(None),
            workers: Mutex::new(Vec::new()),
            pid_filename,
        }
    }

    pub(crate) fn current_epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub(crate) fn next_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn invalidate_if_current(&self, expected: u64) -> bool {
        self.epoch
            .compare_exchange(
                expected,
                expected.wrapping_add(1),
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    pub(crate) fn start_guard(&self) -> MutexGuard<'_, ()> {
        self.start
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn child_slot(&self) -> &Mutex<Option<Child>> {
        &self.child
    }

    #[cfg(test)]
    pub(crate) fn residency_slot(&self) -> &Mutex<Option<PersistentRegistration>> {
        &self.residency
    }

    #[cfg(test)]
    pub(crate) fn worker_count(&self) -> usize {
        self.workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub(crate) fn pid_lockfile_path(&self) -> Option<PathBuf> {
        profile_runtime_root_path()
            .ok()
            .map(|runtime| runtime.join(self.pid_filename))
    }

    pub(crate) fn child_is_alive(&self) -> Result<bool, String> {
        self.child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
            .map(|child| child.try_wait().map(|status| status.is_none()))
            .transpose()
            .map_err(|error| error.to_string())
            .map(|alive| alive.unwrap_or(false))
    }

    /// Invalidate stale work, reap the previous child, and return the generation
    /// identity that owns the next start.
    pub(crate) fn prepare_start(&self) -> u64 {
        let epoch = self.next_epoch();
        self.stop_owned_process();
        self.join_workers();
        epoch
    }

    /// Invalidate in-flight work and synchronously reap the owned child.
    pub(crate) fn stop(&self) {
        self.next_epoch();
        self.stop_owned_process();
        self.join_workers();
    }

    /// Spawn an engine-owned monitor. Finished workers are reaped before a new
    /// one is registered; stop/restart invalidates their epoch, reaps the child
    /// that may be holding a pipe open, then synchronously joins every worker.
    pub(crate) fn spawn_worker(
        &'static self,
        epoch: u64,
        name: &str,
        work: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.current_epoch() != epoch {
            return Err("Engine monitor was superseded".to_string());
        }
        let mut active = Vec::with_capacity(workers.len() + 1);
        for worker in workers.drain(..) {
            if worker.is_finished() {
                let _ = worker.join();
            } else {
                active.push(worker);
            }
        }
        let worker = thread::Builder::new()
            .name(name.to_string())
            .spawn(work)
            .map_err(|error| format!("Could not start {name}: {error}"))?;
        active.push(worker);
        *workers = active;
        Ok(())
    }

    fn join_workers(&self) {
        let workers = {
            let mut slot = self
                .workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *slot)
        };
        for worker in workers {
            let _ = worker.join();
        }
    }

    fn stop_owned_process(&self) {
        // Hold the registration until the process is fully reaped. Dropping it
        // earlier would release residency budget while the old model is live.
        let registration = self
            .residency
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = None;
        self.remove_pid_lockfile();
        drop(child);
        drop(registration);
    }

    pub(crate) fn install_child(
        &self,
        epoch: u64,
        mut child: Child,
        executable: &std::path::Path,
    ) -> Result<(), String> {
        let mut slot = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.current_epoch() != epoch {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Engine start was superseded".to_string());
        }
        if let Some(lockfile) = self.pid_lockfile_path() {
            write_pid_lockfile(&lockfile, child.id(), executable);
        }
        *slot = Some(child);
        Ok(())
    }

    pub(crate) fn commit_registration(
        &self,
        epoch: u64,
        registration: PersistentRegistration,
    ) -> Result<(), String> {
        let mut slot = self
            .residency
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.current_epoch() != epoch {
            return Err("Engine start was superseded".to_string());
        }
        *slot = Some(registration);
        Ok(())
    }

    /// Roll back only the generation that owns the current child. A stale
    /// timeout/completion cannot kill a replacement process.
    pub(crate) fn rollback_if_current(&self, epoch: u64, registration_id: Option<&str>) -> bool {
        if self.current_epoch() != epoch {
            return false;
        }
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.current_epoch() != epoch {
            return false;
        }
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = None;
        drop(child);

        if let Some(registration_id) = registration_id {
            let registration = {
                let mut slot = self
                    .residency
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if slot
                    .as_ref()
                    .is_some_and(|registration| registration.id() == registration_id)
                {
                    slot.take()
                } else {
                    None
                }
            };
            drop(registration);
        }
        self.remove_pid_lockfile();
        true
    }

    pub(crate) fn cleanup_exit_if_current(&self, epoch: u64, registration_id: &str) -> bool {
        if !self.invalidate_if_current(epoch) {
            return false;
        }
        let registration = {
            let mut slot = self
                .residency
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if slot
                .as_ref()
                .is_some_and(|registration| registration.id() == registration_id)
            {
                slot.take()
            } else {
                None
            }
        };
        drop(registration);
        self.remove_pid_lockfile();
        true
    }

    pub(crate) fn monitor_exit(
        &'static self,
        epoch: u64,
        registration_id: String,
        on_current_exit: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        self.spawn_worker(epoch, "lunery-engine-exit", move || loop {
            thread::sleep(Duration::from_millis(250));
            if self.current_epoch() != epoch {
                return;
            }
            let exited = {
                let mut slot = self
                    .child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(child) = slot.as_mut() else {
                    return;
                };
                match child.try_wait() {
                    Ok(Some(_)) => {
                        *slot = None;
                        true
                    }
                    Ok(None) => false,
                    Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        *slot = None;
                        true
                    }
                }
            };
            if !exited {
                continue;
            }
            if self.cleanup_exit_if_current(epoch, &registration_id) {
                on_current_exit();
            }
            return;
        })
    }

    fn remove_pid_lockfile(&self) {
        if let Some(lockfile) = self.pid_lockfile_path() {
            let _ = std::fs::remove_file(lockfile);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EngineLifecycle;
    use crate::test_global_lock;

    static LIFECYCLE: EngineLifecycle = EngineLifecycle::new("lifecycle-test.pid");

    #[test]
    fn generations_are_monotonic_and_stale_invalidation_loses() {
        let _guard = test_global_lock();
        let first = LIFECYCLE.next_epoch();
        let second = LIFECYCLE.next_epoch();
        assert!(second > first);
        assert!(!LIFECYCLE.invalidate_if_current(first));
        assert!(LIFECYCLE.invalidate_if_current(second));
    }

    #[cfg(unix)]
    #[test]
    fn stale_rollback_preserves_replacement_child() {
        let _guard = test_global_lock();
        let stale = LIFECYCLE.next_epoch();
        let current = LIFECYCLE.next_epoch();
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn replacement child");
        *LIFECYCLE.child_slot().lock().unwrap() = Some(child);

        assert!(!LIFECYCLE.rollback_if_current(stale, None));
        assert!(LIFECYCLE.child_slot().lock().unwrap().is_some());
        assert!(LIFECYCLE.rollback_if_current(current, None));
        assert!(LIFECYCLE.child_slot().lock().unwrap().is_none());
    }
}
