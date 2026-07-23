//! `ResidentModel` impl for stable-diffusion.cpp.
//!
//! sd-cpp currently runs PER-SPAWN — every generation reloads the 17 GB FLUX
//! checkpoint. The trait impl here is the bookkeeping half of the future
//! "resident sd server" rewrite: it lets the ResidencyManager already
//! account for an SD model's VRAM footprint when budgeting other backends
//! (llama / MLX), even though we haven't yet rebuilt sd-cli into a daemon.
//!
//! Once we land a resident sd server, only `shutdown` needs to gain teeth
//! (kill the daemon); the rest of this file does not change.

use std::sync::Arc;

use crate::model_residency::ResidentModel;

/// Coarse classifier we use to pick a default VRAM estimate when the caller
/// passes 0 (i.e. catalog row has no explicit minRamGb). Detected from the
/// model id / filename, which the Studio catalog already disambiguates.
#[derive(Debug, Clone, Copy)]
pub enum SdFamily {
    Flux,
    Sdxl,
    Sd15,
    Unknown,
}

impl SdFamily {
    pub fn from_id(id: &str) -> Self {
        let lower = id.to_ascii_lowercase();
        if lower.contains("flux") {
            SdFamily::Flux
        } else if lower.contains("sdxl") || lower.contains("xl") {
            SdFamily::Sdxl
        } else if lower.contains("sd-1.5") || lower.contains("sd15") || lower.contains("1.5") {
            SdFamily::Sd15
        } else {
            SdFamily::Unknown
        }
    }

    /// Defensible defaults for the in-product catalog (Q4 quants where
    /// applicable). Numbers are intentionally pessimistic; the eviction
    /// path errs on the side of evicting too aggressively rather than
    /// crashing the GPU.
    pub fn default_vram_mb(self) -> u32 {
        match self {
            SdFamily::Flux => 12_000,
            SdFamily::Sdxl => 8_000,
            SdFamily::Sd15 => 4_000,
            // 6 GB lands between SDXL and SD15 — safe for whatever the user
            // dropped into the model store.
            SdFamily::Unknown => 6_000,
        }
    }
}

pub struct SdCppResident {
    id: String,
    estimated_mb: u32,
    shutdown_fn: fn(),
}

impl SdCppResident {
    /// Build from the model id (filename or catalog id) and an explicit MB
    /// override. Pass `Some(mb)` when the catalog row carries an exact size,
    /// `None` to fall back to the family default.
    pub fn new(id: &str, explicit_mb: Option<u32>, shutdown: fn()) -> Arc<Self> {
        let estimated_mb = explicit_mb.unwrap_or_else(|| SdFamily::from_id(id).default_vram_mb());
        Arc::new(SdCppResident {
            id: id.to_string(),
            estimated_mb,
            shutdown_fn: shutdown,
        })
    }
}

impl ResidentModel for SdCppResident {
    fn id(&self) -> &str {
        &self.id
    }
    fn estimated_vram_mb(&self) -> u32 {
        self.estimated_mb
    }
    fn shutdown(&self) {
        // Until sd-cpp is resident, `bridge_stop_sd` only kills an in-flight
        // child — there's no daemon to tear down. We still call it so a
        // mid-generation eviction cancels the running sd-cli, which is the
        // intended behavior (frees the GPU for the higher-priority new
        // model the scheduler is making room for).
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
    fn family_detection_from_id() {
        assert!(matches!(
            SdFamily::from_id("FLUX.1-dev-Q4_0.gguf"),
            SdFamily::Flux
        ));
        assert!(matches!(
            SdFamily::from_id("sd_xl_base_1.0.safetensors"),
            SdFamily::Sdxl
        ));
        assert!(matches!(
            SdFamily::from_id("sd-1.5-pruned.safetensors"),
            SdFamily::Sd15
        ));
        assert!(matches!(
            SdFamily::from_id("custom-finetune.safetensors"),
            SdFamily::Unknown
        ));
    }

    #[test]
    fn explicit_mb_wins_over_family_default() {
        let m = SdCppResident::new("flux-q4.gguf", Some(9_000), fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), 9_000);
    }

    #[test]
    fn unknown_falls_back_to_family_default() {
        let m = SdCppResident::new("FLUX.1-dev-Q4_0.gguf", None, fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), 12_000);
    }

    #[test]
    fn shutdown_delegates() {
        let before = SHUT_COUNT.load(Ordering::SeqCst);
        let m = SdCppResident::new("sd15.safetensors", None, fake_shutdown);
        m.shutdown();
        assert_eq!(SHUT_COUNT.load(Ordering::SeqCst), before + 1);
    }
}
