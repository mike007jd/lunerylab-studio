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
//!   - `activate(id)` returns a guard the caller holds for the duration of
//!     its request — eviction never reclaims an active model.
//!
//! Out of scope for v0 (deliberate, follow-up tickets):
//!   - Cross-platform VRAM probing (nvml on CUDA, Metal on macOS).
//!     v0 takes the user-configured budget; auto-probe later.
//!   - Actually wiring `bridge_sd_generate` to go through this scheduler.
//!     The trait + tests are landed first; caller swap is a separate change
//!     so the residency layer can be reviewed without touching live paths.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

/// Categories a model belongs to. Used both as a display hint and to let the
/// scheduler bias eviction (e.g. prefer evicting an image model when the
/// next-needed model is also an image model, so a hot LLM session stays warm).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModelKind {
    Llm,
    ImageDiffusion,
}

/// One resident model — implementations wrap the OS process (or a remote HTTP
/// server they brought up) and know how to release the resources.
pub trait ResidentModel: Send + Sync {
    fn id(&self) -> &str;
    fn kind(&self) -> ModelKind;
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
    /// Per-process VRAM budget in megabytes. Configurable at startup; 0 means
    /// "unlimited" (useful in tests and for users with abundant memory).
    budget_mb: u32,
}

impl ResidencyManager {
    pub fn new(budget_mb: u32) -> Self {
        Self {
            inner: Mutex::new(ResidencyState {
                slots: HashMap::new(),
                budget_mb,
            }),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Sum of all resident models' estimated VRAM. O(n) — n is small
    /// (typically < 10).
    pub fn current_usage_mb(&self) -> u32 {
        let state = lock_recover(&self.inner, "current usage");
        state
            .slots
            .values()
            .map(|slot| slot.model.estimated_vram_mb())
            .sum()
    }

    /// Register a model that has *just been brought up* by the caller. The
    /// scheduler immediately checks the budget and evicts older models if
    /// necessary to make room. Returns Err if even after evicting every
    /// non-active model there's still not enough headroom for the new one.
    pub fn register(&self, model: Arc<dyn ResidentModel>) -> Result<(), String> {
        let id = model.id().to_string();
        let cost = model.estimated_vram_mb();
        let mut state = lock_recover(&self.inner, "register");

        // Already present — refresh the LRU timestamp and return.
        if let Some(slot) = state.slots.get_mut(&id) {
            slot.last_used = Instant::now();
            return Ok(());
        }

        if state.budget_mb > 0 {
            let mut used = state
                .slots
                .values()
                .map(|slot| slot.model.estimated_vram_mb())
                .sum::<u32>();
            while used.saturating_add(cost) > state.budget_mb {
                let evict_id = pick_lru_evictable(&state.slots, &self.active);
                let Some(id) = evict_id else {
                    return Err(format!(
                        "no room for model {} (cost {} MB, used {} MB, budget {} MB)",
                        model.id(),
                        cost,
                        used,
                        state.budget_mb
                    ));
                };
                if let Some(slot) = state.slots.remove(&id) {
                    slot.model.shutdown();
                    used = used.saturating_sub(slot.model.estimated_vram_mb());
                }
            }
        }

        state.slots.insert(
            id,
            Slot {
                model,
                last_used: Instant::now(),
            },
        );
        Ok(())
    }

    /// Try to acquire a lease on a registered model. Returns None if it's not
    /// resident (caller must `register` first). Holding the lease prevents
    /// eviction.
    pub fn activate(&self, id: &str) -> Option<ModelLease> {
        let mut state = lock_recover(&self.inner, "activate");
        let slot = state.slots.get_mut(id)?;
        slot.last_used = Instant::now();
        let inner = Arc::clone(&slot.model);
        drop(state);
        let mut active = lock_recover(&self.active, "activate active map");
        *active.entry(id.to_string()).or_insert(0) += 1;
        Some(ModelLease {
            inner,
            counter: Arc::clone(&self.active),
        })
    }

    /// Forcefully drop a model from the registry. Used by callers that know
    /// the underlying process died (e.g. crash recovery).
    pub fn drop_model(&self, id: &str) {
        let mut state = lock_recover(&self.inner, "drop model");
        if let Some(slot) = state.slots.remove(id) {
            slot.model.shutdown();
        }
    }

    /// Tunable at runtime — the user may move the VRAM slider in Settings.
    pub fn set_budget_mb(&self, budget_mb: u32) {
        let mut state = lock_recover(&self.inner, "set budget");
        state.budget_mb = budget_mb;
    }

    /// Current budget in MB (0 = unlimited). Exposed so the Settings UI can
    /// reflect the auto-detected starting value without us routing it
    /// through a separate `manage()` slot.
    pub fn budget_mb(&self) -> u32 {
        let state = lock_recover(&self.inner, "budget");
        state.budget_mb
    }

    /// Snapshot of every resident model — used by the Settings VRAM panel.
    /// `last_used_secs_ago` is seconds since `last_used` (saturating at u64
    /// max). `is_active` reflects whether any caller currently holds a lease.
    pub fn active_models(&self) -> Vec<ResidentModelSnapshot> {
        let state = lock_recover(&self.inner, "active models");
        let active = lock_recover(&self.active, "active models map");
        let now = Instant::now();
        state
            .slots
            .iter()
            .map(|(id, slot)| ResidentModelSnapshot {
                id: id.clone(),
                kind: slot.model.kind(),
                vram_mb: slot.model.estimated_vram_mb(),
                last_used_secs_ago: now.saturating_duration_since(slot.last_used).as_secs(),
                is_active: active.get(id).copied().unwrap_or(0) > 0,
            })
            .collect()
    }
}

/// Plain-data snapshot of one resident model. Lives outside the Mutex so the
/// caller can hand it to serde without holding the residency lock.
#[derive(Debug, Clone)]
pub struct ResidentModelSnapshot {
    pub id: String,
    pub kind: ModelKind,
    pub vram_mb: u32,
    pub last_used_secs_ago: u64,
    pub is_active: bool,
}

fn pick_lru_evictable(
    slots: &HashMap<String, Slot>,
    active: &Arc<Mutex<HashMap<String, usize>>>,
) -> Option<String> {
    let active_map = lock_recover(active, "pick lru active map");
    slots
        .iter()
        .filter(|(id, _)| active_map.get(*id).copied().unwrap_or(0) == 0)
        .min_by_key(|(_, slot)| slot.last_used)
        .map(|(id, _)| id.clone())
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
        kind: ModelKind,
        vram_mb: u32,
        shutdown_called: Arc<AtomicBool>,
    }

    impl ResidentModel for FakeModel {
        fn id(&self) -> &str {
            &self.id
        }
        fn kind(&self) -> ModelKind {
            self.kind
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
            kind: ModelKind::ImageDiffusion,
            vram_mb: vram,
            shutdown_called: Arc::clone(&flag),
        });
        (m, flag)
    }

    #[test]
    fn registers_under_budget() {
        let r = ResidencyManager::new(1000);
        let (m, _) = fake("a", 400);
        r.register(m).unwrap();
        assert_eq!(r.current_usage_mb(), 400);
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
        assert!(r.current_usage_mb() <= 1000);
    }

    #[test]
    fn does_not_evict_active_models() {
        let r = ResidencyManager::new(1000);
        let (m_a, a_shut) = fake("a", 400);
        let (m_b, _) = fake("b", 400);
        let (m_c, _) = fake("c", 400);
        r.register(m_a).unwrap();
        r.register(m_b).unwrap();
        let _lease = r.activate("a").expect("a should be registered");
        // a is pinned; eviction must fall to b.
        r.register(m_c).unwrap();
        assert!(!a_shut.load(Ordering::SeqCst), "active model evicted");
    }

    #[test]
    fn refuses_register_when_all_pinned_and_no_room() {
        let r = ResidencyManager::new(1000);
        let (m_a, _) = fake("a", 600);
        let (m_b, _) = fake("b", 600);
        r.register(m_a).unwrap();
        let _lease = r.activate("a").expect("a registered");
        let err = r.register(m_b).unwrap_err();
        assert!(err.contains("no room"));
    }

    #[test]
    fn active_models_reports_lease_state() {
        let r = ResidencyManager::new(0);
        let (m_a, _) = fake("a", 100);
        let (m_b, _) = fake("b", 200);
        r.register(m_a).unwrap();
        r.register(m_b).unwrap();
        let _lease = r.activate("a").unwrap();
        let snap = r.active_models();
        assert_eq!(snap.len(), 2);
        let a = snap.iter().find(|s| s.id == "a").unwrap();
        let b = snap.iter().find(|s| s.id == "b").unwrap();
        assert!(a.is_active, "a should be active (lease held)");
        assert!(!b.is_active, "b should not be active");
        assert_eq!(a.vram_mb, 100);
        assert_eq!(b.vram_mb, 200);
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
}
