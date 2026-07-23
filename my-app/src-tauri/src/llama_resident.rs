//! `ResidentModel` impl for the embedded llama.cpp server.
//!
//! Why a separate file: the lib.rs llama-server lifecycle code is already
//! ~400 lines of spawn / wait_for_port / PID lockfile / cancel plumbing.
//! Wrapping that in a trait object here keeps lib.rs free of residency
//! bookkeeping, and lets the ResidencyManager evict the model without
//! needing to know anything about Tauri State or bridge globals.
//!
//! Shutdown contract: ResidencyManager calls `shutdown()` when this model is
//! the LRU pick during a register-time eviction. It delegates to
//! `bridge_stop_llama()` which is idempotent (safe to call twice, safe to
//! call on a model that already exited).

use std::sync::Arc;

use crate::model_residency::ResidentModel;

/// Wraps the bridge-side llama-server lifecycle, the single product control
/// surface for embedded llama.cpp.
pub struct LlamaResident {
    /// Stable identity used as the ResidencyManager key. Currently the GGUF
    /// file basename (e.g. "Llama-3.2-3B-Instruct-Q4_K_M.gguf"); kept as a
    /// String so the manager can show it in the VRAM usage UI.
    id: String,
    /// VRAM cost (megabytes). Set at construction from the GGUF file size
    /// plus a KV-cache headroom factor — see `LlamaResident::new`.
    estimated_mb: u32,
    /// Captured at construction so shutdown is `fn(&self)`, no closures
    /// flowing through trait objects. We point at the real bridge stop.
    shutdown_fn: ShutdownFn,
}

type ShutdownFn = fn();

impl LlamaResident {
    /// Build from a GGUF model path. The id is the file basename; VRAM cost
    /// is the file size on disk multiplied by 1.2 to account for the KV
    /// cache and llama-server's own working memory.
    ///
    /// Returns a shared resident that coerces to the manager's trait object.
    pub fn new(model_path: &str, shutdown: ShutdownFn) -> Arc<Self> {
        let identity = std::path::Path::new(model_path)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(model_path));
        let id = format!("llama:{}", identity.to_string_lossy());

        // GGUF on-disk size ≈ weights in memory once mmapped. KV cache grows
        // with context length; 20 % padding covers the default 4 K context
        // for the model sizes we ship (3 B – 8 B). Larger models or larger
        // contexts can blow this; the manager errors at register time, which
        // surfaces as a friendly UI error instead of a silent OOM kill.
        let metadata_bytes = std::fs::metadata(model_path)
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        let Some(bytes) = metadata_bytes else {
            return Arc::new(LlamaResident {
                id,
                // Fail closed against every finite residency budget. A missing
                // or unreadable GGUF has no defensible zero-cost estimate.
                estimated_mb: u32::MAX,
                shutdown_fn: shutdown,
            });
        };
        let mb = bytes.saturating_add(1024 * 1024 - 1) / 1024 / 1024;
        let with_kv = (mb.saturating_mul(12) / 10).max(1);
        let estimated_mb = u32::try_from(with_kv).unwrap_or(u32::MAX);

        Arc::new(LlamaResident {
            id,
            estimated_mb,
            shutdown_fn: shutdown,
        })
    }
}

impl ResidentModel for LlamaResident {
    fn id(&self) -> &str {
        &self.id
    }
    fn estimated_vram_mb(&self) -> u32 {
        self.estimated_mb
    }
    fn shutdown(&self) {
        // bridge_stop_llama is idempotent; safe to call when the child is
        // already gone (e.g. user manually hit Stop while we were evicting).
        (self.shutdown_fn)();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_residency::ResidencyManager;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Module-level counter — `ShutdownFn` is a bare `fn()` (no captures), so
    // we test the wiring by pointing at a static counter.
    static SHUT_COUNT: AtomicUsize = AtomicUsize::new(0);
    fn fake_shutdown() {
        SHUT_COUNT.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn id_is_namespaced_canonical_identity() {
        let m = LlamaResident::new("/tmp/Llama-3-8B-Q4_K_M.gguf", fake_shutdown);
        assert_eq!(m.id(), "llama:/tmp/Llama-3-8B-Q4_K_M.gguf");
    }

    #[test]
    fn shutdown_delegates_to_bridge_fn() {
        let before = SHUT_COUNT.load(Ordering::SeqCst);
        let m = LlamaResident::new("/tmp/whatever.gguf", fake_shutdown);
        m.shutdown();
        assert_eq!(SHUT_COUNT.load(Ordering::SeqCst), before + 1);
    }

    #[test]
    fn missing_file_fails_closed_instead_of_registering_zero_cost() {
        let m = LlamaResident::new("/does/not/exist.gguf", fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), u32::MAX);
        assert!(ResidencyManager::new(8 * 1024).register(m).is_err());
    }

    #[test]
    fn file_size_uses_ceil_megabytes_plus_headroom() {
        let path = std::env::temp_dir().join(format!(
            "lunery-llama-resident-{}-{}.gguf",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let file = std::fs::File::create(&path).expect("create fixture");
        file.set_len(10 * 1024 * 1024 + 1).expect("size fixture");

        let m = LlamaResident::new(path.to_str().expect("utf8 path"), fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), 13);

        std::fs::remove_file(path).expect("remove fixture");
    }
}
