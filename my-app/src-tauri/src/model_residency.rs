//! ModelResidency — VRAM-aware LRU scheduler for resident model processes.
//!
//! The legacy bridge spawns a fresh `sd-cli` per generation request and holds
//! a global `sd_generate_lock`, so a 17 GB FLUX checkpoint is reloaded into
//! VRAM on every job (8–15 s of cold start). This module is the foundation
//! for "resident server + hot swap" — models stay loaded between requests,
//! and when VRAM runs low the least-recently-used one is evicted.
//!
//! v0 scope intentionally small:
//!   - Trait that any backend (llama-server, sd-cpp resident, MLX, ComfyUI
//!     sidecar) can implement.
//!   - In-memory registry + LRU eviction under a per-process VRAM budget.
//!   - Registration can atomically return a guard the caller holds for the
//!     duration of its request — eviction never reclaims an active model.
//!
//! Out of scope for v0 (deliberate, follow-up tickets):
//!   - Cross-platform VRAM probing (nvml on CUDA, Metal on macOS).
//!     v0 takes the user-configured budget; auto-probe later.
//!   - Actually wiring `bridge_sd_generate` to go through this scheduler.
//!     The trait + tests are landed first; caller swap is a separate change
//!     so the residency layer can be reviewed without touching live paths.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Instant;

/// One resident model — implementations wrap the OS process (or a remote HTTP
/// server they brought up) and know how to release the resources.
pub trait ResidentModel: Send + Sync {
    fn id(&self) -> &str;
    /// Estimated VRAM (or unified-memory) cost in megabytes. Drives the LRU
    /// eviction budget. Implementations are responsible for honest numbers —
    /// underestimating leads to OOM crashes the scheduler can't recover from.
    fn estimated_vram_mb(&self) -> u32;
    /// Best-effort shutdown. Called by the scheduler when this model is being
    /// evicted to free room for another. Implementations should be idempotent.
    fn shutdown(&self);
}

fn lock_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        eprintln!("recovering poisoned residency mutex: {label}");
        poisoned.into_inner()
    })
}

/// A lease handle the caller holds for the duration of its request. While at
/// least one lease exists, the scheduler will not evict the underlying model.
pub struct ModelLease {
    inner: Arc<dyn ResidentModel>,
    counter: Arc<Mutex<HashMap<String, usize>>>,
}

/// Lifecycle-scoped reservation for a persistent engine process. Unlike a
/// request lease, this handle represents the loaded server itself and lives in
/// that engine's lifecycle slot until stop, switch, rollback, or process exit.
pub struct PersistentRegistration {
    manager: Weak<ResidencyManager>,
    id: String,
    generation: u64,
    lease: Option<ModelLease>,
}

impl PersistentRegistration {
    pub fn id(&self) -> &str {
        &self.id
    }
}

impl Drop for PersistentRegistration {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.upgrade() {
            manager.unregister_generation(&self.id, self.generation);
        }
        // The slot is removed while it is still protected from eviction. Only
        // then release the active count associated with this lifecycle.
        drop(self.lease.take());
    }
}

impl ModelLease {
    pub fn model(&self) -> &dyn ResidentModel {
        self.inner.as_ref()
    }
}

impl Drop for ModelLease {
    fn drop(&mut self) {
        let mut map = lock_recover(&self.counter, "active lease drop");
        let id = self.inner.id().to_string();
        if let Some(count) = map.get_mut(&id) {
            if *count > 0 {
                *count -= 1;
            }
        }
    }
}

struct Slot {
    model: Arc<dyn ResidentModel>,
    last_used: Instant,
    generation: u64,
}

/// VRAM-budgeted LRU registry. Single instance is held by the app state
/// (`tauri::State<ResidencyManager>`).
pub struct ResidencyManager {
    inner: Mutex<ResidencyState>,
    /// Active-lease counts per model id — read by eviction to skip pinned
    /// models. A separate Arc<Mutex<_>> so `ModelLease::drop` doesn't need
    /// re-entrant access to `inner`.
    active: Arc<Mutex<HashMap<String, usize>>>,
}

struct ResidencyState {
    slots: HashMap<String, Slot>,
    next_generation: u64,
    /// Per-process VRAM budget in megabytes. Configurable at startup; 0 means
    /// "unlimited" (useful in tests and for users with abundant memory).
    budget_mb: u32,
}

impl ResidencyManager {
    pub fn new(budget_mb: u32) -> Self {
        Self {
            inner: Mutex::new(ResidencyState {
                slots: HashMap::new(),
                next_generation: 0,
                budget_mb,
            }),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a model that has *just been brought up* by the caller. The
    /// scheduler immediately checks the budget and evicts older models if
    /// necessary to make room. Returns Err if even after evicting every
    /// non-active model there's still not enough headroom for the new one.
    #[cfg(test)]
    pub(crate) fn register(&self, model: Arc<dyn ResidentModel>) -> Result<(), String> {
        let evicted = {
            let mut state = lock_recover(&self.inner, "register");
            let (_, _, evicted) = register_locked(&mut state, &self.active, model)?;
            evicted
        };
        shutdown_evicted(evicted);
        Ok(())
    }

    /// Register a model and pin it for immediate use without exposing an
    /// eviction window between those operations. Callers that bring up a
    /// process and use it in the same request should prefer this method.
    pub fn register_and_activate(
        &self,
        model: Arc<dyn ResidentModel>,
    ) -> Result<ModelLease, String> {
        let (lease, evicted) = {
            let mut state = lock_recover(&self.inner, "register and activate");
            let (id, _, evicted) = register_locked(&mut state, &self.active, model)?;
            let slot = state
                .slots
                .get_mut(&id)
                .ok_or_else(|| format!("model {id} disappeared during activation"))?;
            slot.last_used = Instant::now();
            let inner = Arc::clone(&slot.model);
            let mut active = lock_recover(&self.active, "register and activate active map");
            *active.entry(id).or_insert(0) += 1;
            (
                ModelLease {
                    inner,
                    counter: Arc::clone(&self.active),
                },
                evicted,
            )
        };
        shutdown_evicted(evicted);
        Ok(lease)
    }

    /// Reserve budget for a persistent engine before it spawns or loads. A
    /// live registration is never eviction-eligible and duplicate identities
    /// are rejected instead of silently refreshing an unrelated lifecycle.
    pub fn register_persistent(
        self: &Arc<Self>,
        model: Arc<dyn ResidentModel>,
    ) -> Result<PersistentRegistration, String> {
        let (registration, evicted) = {
            let mut state = lock_recover(&self.inner, "register persistent");
            if state.slots.contains_key(model.id()) {
                return Err(format!(
                    "persistent model {} is already registered",
                    model.id()
                ));
            }
            let (id, generation, evicted) = register_locked(&mut state, &self.active, model)?;
            let slot = state
                .slots
                .get_mut(&id)
                .ok_or_else(|| format!("model {id} disappeared during registration"))?;
            slot.last_used = Instant::now();
            let inner = Arc::clone(&slot.model);
            let mut active = lock_recover(&self.active, "register persistent active map");
            *active.entry(id.clone()).or_insert(0) += 1;
            (
                PersistentRegistration {
                    manager: Arc::downgrade(self),
                    id,
                    generation,
                    lease: Some(ModelLease {
                        inner,
                        counter: Arc::clone(&self.active),
                    }),
                },
                evicted,
            )
        };
        shutdown_evicted(evicted);
        Ok(registration)
    }

    /// Remove residency bookkeeping without shutting the model down. Callers
    /// use this when the tracked process has already exited normally and
    /// there is no resident resource left to evict.
    pub fn unregister(&self, id: &str) {
        let mut state = lock_recover(&self.inner, "unregister");
        state.slots.remove(id);
    }

    fn unregister_generation(&self, id: &str, generation: u64) {
        let mut state = lock_recover(&self.inner, "unregister generation");
        if state
            .slots
            .get(id)
            .map(|slot| slot.generation == generation)
            .unwrap_or(false)
        {
            state.slots.remove(id);
        }
    }
}

fn total_usage_mb(slots: &HashMap<String, Slot>) -> u32 {
    slots.values().fold(0_u32, |used, slot| {
        used.saturating_add(slot.model.estimated_vram_mb())
    })
}

type RegistrationPlan = (String, u64, Vec<Arc<dyn ResidentModel>>);

fn register_locked(
    state: &mut ResidencyState,
    active: &Arc<Mutex<HashMap<String, usize>>>,
    model: Arc<dyn ResidentModel>,
) -> Result<RegistrationPlan, String> {
    let id = model.id().to_string();
    let cost = model.estimated_vram_mb();
    if cost == u32::MAX {
        return Err(format!(
            "model {} has no trustworthy memory estimate",
            model.id()
        ));
    }

    // Already present — refresh the LRU timestamp and return.
    if let Some(slot) = state.slots.get_mut(&id) {
        slot.last_used = Instant::now();
        return Ok((id, slot.generation, Vec::new()));
    }

    let mut evict_ids = Vec::new();
    if state.budget_mb > 0 {
        let mut used = total_usage_mb(&state.slots);
        let active_map = lock_recover(active, "plan eviction active map");
        let mut candidates = state
            .slots
            .iter()
            .filter(|(slot_id, _)| active_map.get(*slot_id).copied().unwrap_or(0) == 0)
            .map(|(slot_id, slot)| {
                (
                    slot_id.clone(),
                    slot.last_used,
                    slot.model.estimated_vram_mb(),
                )
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(_, last_used, _)| *last_used);
        for (evict_id, _, evict_cost) in candidates {
            if used.saturating_add(cost) <= state.budget_mb {
                break;
            }
            evict_ids.push(evict_id);
            used = used.saturating_sub(evict_cost);
        }
        if used.saturating_add(cost) > state.budget_mb {
            return Err(format!(
                "no room for model {} (cost {} MB, used {} MB, budget {} MB)",
                model.id(),
                cost,
                used,
                state.budget_mb
            ));
        }
    }

    let evicted = evict_ids
        .into_iter()
        .filter_map(|evict_id| state.slots.remove(&evict_id).map(|slot| slot.model))
        .collect();
    state.next_generation = state.next_generation.wrapping_add(1).max(1);
    let generation = state.next_generation;
    state.slots.insert(
        id.clone(),
        Slot {
            model,
            last_used: Instant::now(),
            generation,
        },
    );
    Ok((id, generation, evicted))
}

fn shutdown_evicted(evicted: Vec<Arc<dyn ResidentModel>>) {
    for model in evicted {
        model.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FakeModel {
        id: String,
        vram_mb: u32,
        shutdown_called: Arc<AtomicBool>,
    }

    impl ResidentModel for FakeModel {
        fn id(&self) -> &str {
            &self.id
        }
        fn estimated_vram_mb(&self) -> u32 {
            self.vram_mb
        }
        fn shutdown(&self) {
            self.shutdown_called.store(true, Ordering::SeqCst);
        }
    }

    fn fake(id: &str, vram: u32) -> (Arc<FakeModel>, Arc<AtomicBool>) {
        let flag = Arc::new(AtomicBool::new(false));
        let m = Arc::new(FakeModel {
            id: id.to_string(),
            vram_mb: vram,
            shutdown_called: Arc::clone(&flag),
        });
        (m, flag)
    }

    fn usage(r: &ResidencyManager) -> u32 {
        let state = lock_recover(&r.inner, "test usage");
        total_usage_mb(&state.slots)
    }

    #[test]
    fn registers_under_budget() {
        let r = ResidencyManager::new(1000);
        let (m, _) = fake("a", 400);
        r.register(m).unwrap();
        assert_eq!(usage(&r), 400);
    }

    #[test]
    fn evicts_lru_when_over_budget() {
        let r = ResidencyManager::new(1000);
        let (m_a, a_shut) = fake("a", 400);
        let (m_b, _b_shut) = fake("b", 400);
        let (m_c, _c_shut) = fake("c", 400);
        r.register(m_a).unwrap();
        r.register(m_b).unwrap();
        // c doesn't fit alongside a + b (1200 > 1000), so a (oldest) is evicted.
        r.register(m_c).unwrap();
        assert!(a_shut.load(Ordering::SeqCst));
        assert!(usage(&r) <= 1000);
    }

    #[test]
    fn unregister_forgets_model_without_shutdown() {
        let r = ResidencyManager::new(1000);
        let (model, shutdown_called) = fake("finished", 400);
        r.register(model).unwrap();

        r.unregister("finished");

        assert_eq!(usage(&r), 0);
        assert!(!shutdown_called.load(Ordering::SeqCst));
    }

    #[test]
    fn does_not_evict_active_models() {
        let r = ResidencyManager::new(1000);
        let (m_a, a_shut) = fake("a", 400);
        let (m_b, _) = fake("b", 400);
        let (m_c, _) = fake("c", 400);
        r.register(m_b).unwrap();
        let _lease = r.register_and_activate(m_a).unwrap();
        // a is pinned; eviction must fall to b.
        r.register(m_c).unwrap();
        assert!(!a_shut.load(Ordering::SeqCst), "active model evicted");
    }

    #[test]
    fn refuses_register_when_all_pinned_and_no_room() {
        let r = ResidencyManager::new(1000);
        let (m_a, _) = fake("a", 600);
        let (m_b, _) = fake("b", 600);
        let _lease = r.register_and_activate(m_a).unwrap();
        let err = r.register(m_b).unwrap_err();
        assert!(err.contains("no room"));
    }

    #[test]
    fn unlimited_budget_never_evicts() {
        let r = ResidencyManager::new(0);
        let (m_a, a_shut) = fake("a", 50_000);
        let (m_b, _) = fake("b", 50_000);
        r.register(m_a).unwrap();
        r.register(m_b).unwrap();
        assert!(!a_shut.load(Ordering::SeqCst));
    }

    #[test]
    fn usage_saturates_instead_of_wrapping() {
        let r = ResidencyManager::new(0);
        let (large, _) = fake("large", u32::MAX - 10);
        let (small, _) = fake("small", 100);
        r.register(large).unwrap();
        r.register(small).unwrap();
        assert_eq!(usage(&r), u32::MAX);
    }

    #[test]
    fn unknown_memory_cost_is_rejected_even_with_unlimited_budget() {
        let r = ResidencyManager::new(0);
        let (unknown, _) = fake("unknown", u32::MAX);
        let err = r.register(unknown).unwrap_err();
        assert!(err.contains("no trustworthy memory estimate"));
        assert_eq!(usage(&r), 0);
    }

    #[test]
    fn atomic_registration_lease_blocks_concurrent_eviction() {
        let r = Arc::new(ResidencyManager::new(1000));
        let (first, first_shut) = fake("first", 700);
        let (second, _) = fake("second", 700);
        let lease = r.register_and_activate(first).unwrap();

        let contender = Arc::clone(&r);
        let result = std::thread::spawn(move || contender.register(second))
            .join()
            .expect("contender thread should finish");
        assert!(result.is_err());
        assert!(!first_shut.load(Ordering::SeqCst));

        drop(lease);
        let (second_retry, _) = fake("second", 700);
        r.register(second_retry).unwrap();
        assert!(first_shut.load(Ordering::SeqCst));
    }

    #[test]
    fn eviction_shutdown_runs_after_residency_lock_is_released() {
        struct LockCheckingModel {
            manager: Arc<ResidencyManager>,
            saw_unlocked: Arc<AtomicBool>,
        }

        impl ResidentModel for LockCheckingModel {
            fn id(&self) -> &str {
                "lock-check"
            }
            fn estimated_vram_mb(&self) -> u32 {
                700
            }
            fn shutdown(&self) {
                self.saw_unlocked
                    .store(self.manager.inner.try_lock().is_ok(), Ordering::SeqCst);
            }
        }

        let manager = Arc::new(ResidencyManager::new(1000));
        let saw_unlocked = Arc::new(AtomicBool::new(false));
        manager
            .register(Arc::new(LockCheckingModel {
                manager: Arc::clone(&manager),
                saw_unlocked: Arc::clone(&saw_unlocked),
            }))
            .unwrap();
        let (replacement, _) = fake("replacement", 700);
        manager.register(replacement).unwrap();
        assert!(saw_unlocked.load(Ordering::SeqCst));
    }

    #[test]
    fn persistent_registration_reserves_budget_and_rejects_duplicate_identity() {
        let manager = Arc::new(ResidencyManager::new(1000));
        let (persistent, persistent_shutdown) = fake("persistent", 700);
        let handle = manager.register_persistent(persistent).unwrap();
        let (duplicate, _) = fake("persistent", 700);
        assert!(manager.register_persistent(duplicate).is_err());
        let (contender, _) = fake("contender", 700);
        assert!(manager.register(contender).is_err());
        assert!(!persistent_shutdown.load(Ordering::SeqCst));

        drop(handle);
        let (contender, _) = fake("contender", 700);
        manager.register(contender).unwrap();
        assert!(!persistent_shutdown.load(Ordering::SeqCst));
    }

    #[test]
    fn stale_persistent_handle_cannot_unregister_new_generation() {
        let manager = Arc::new(ResidencyManager::new(0));
        let (old, _) = fake("same-id", 100);
        let old_handle = manager.register_persistent(old).unwrap();
        manager.unregister("same-id");
        let (replacement, _) = fake("same-id", 200);
        manager.register(replacement).unwrap();

        drop(old_handle);
        assert_eq!(usage(&manager), 200);
    }
}
