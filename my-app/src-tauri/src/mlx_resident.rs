//! `ResidentModel` impl for the embedded SwiftLM (MLX) text engine.
//!
//! MLX uses unified memory on Apple Silicon — there is no separate VRAM —
//! but for the scheduler's purposes the cost is the same: a resident MLX
//! server holds N GB that other models cannot use. The id is the HF repo id
//! the user activated (SwiftLM takes a repo id, not a file path), so a
//! user-switched-model maps to a new `register()` call.

use std::sync::Arc;

use crate::model_residency::{ModelKind, ResidentModel};

pub struct MlxResident {
    /// HF repo id (e.g. "mlx-community/Llama-3.2-3B-Instruct-4bit"). Used as
    /// the ResidencyManager key — registering the same repo id twice is a
    /// no-op refresh, registering a new id triggers normal LRU eviction.
    id: String,
    estimated_mb: u32,
    shutdown_fn: fn(),
}

impl MlxResident {
    /// Build from the HF repo id and a min-RAM-GB hint coming from the model
    /// catalog row (the Settings UI already tracks `minRamGb` per curated
    /// model). We multiply by 1024 to land in MB, then add nothing else —
    /// SwiftLM's working memory is small compared to the weights.
    ///
    /// `min_ram_gb` of 0 means "unknown": we fall back to 6 GB as a safe
    /// floor for 4-bit 3B-class models we ship.
    pub fn new(repo_id: &str, min_ram_gb: u32, shutdown: fn()) -> Arc<dyn ResidentModel> {
        let gb = if min_ram_gb == 0 { 6 } else { min_ram_gb };
        let estimated_mb = gb.saturating_mul(1024);
        Arc::new(MlxResident {
            id: repo_id.to_string(),
            estimated_mb,
            shutdown_fn: shutdown,
        })
    }
}

impl ResidentModel for MlxResident {
    fn id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> ModelKind {
        // MLX is text-only today (SwiftLM), so it stays in the LLM bucket.
        ModelKind::Llm
    }
    fn estimated_vram_mb(&self) -> u32 {
        self.estimated_mb
    }
    fn shutdown(&self) {
        (self.shutdown_fn)();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SHUT_COUNT: AtomicUsize = AtomicUsize::new(0);
    fn fake_shutdown() {
        SHUT_COUNT.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn id_is_repo_id_and_estimate_uses_min_ram() {
        let m = MlxResident::new("mlx-community/Llama-3.2-3B-4bit", 4, fake_shutdown);
        assert_eq!(m.id(), "mlx-community/Llama-3.2-3B-4bit");
        assert_eq!(m.estimated_vram_mb(), 4 * 1024);
    }

    #[test]
    fn unknown_min_ram_falls_back_to_six_gb() {
        let m = MlxResident::new("mlx-community/whatever", 0, fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), 6 * 1024);
    }

    #[test]
    fn shutdown_delegates() {
        let before = SHUT_COUNT.load(Ordering::SeqCst);
        let m = MlxResident::new("mlx-community/whatever", 4, fake_shutdown);
        m.shutdown();
        assert_eq!(SHUT_COUNT.load(Ordering::SeqCst), before + 1);
    }
}
