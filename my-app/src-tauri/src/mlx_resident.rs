//! `ResidentModel` impl for the embedded SwiftLM (MLX) text engine.
//!
//! MLX uses unified memory on Apple Silicon — there is no separate VRAM —
//! but for the scheduler's purposes the cost is the same: a resident MLX
//! server holds N GB that other models cannot use. The id is the HF repo id
//! the user activated (SwiftLM takes a repo id, not a file path), so a
//! user-switched-model maps to a new `register()` call.

use std::sync::Arc;

use crate::model_residency::ResidentModel;

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
    /// `min_ram_gb` of 0 means the caller has no catalog fact. Local paths are
    /// estimated from their real files; HF repo ids are conservatively derived
    /// from the parameter count and quantization encoded in the repo name. If
    /// neither source exists, use `u32::MAX` so any finite budget fails closed.
    pub fn new(repo_id: &str, min_ram_gb: u32, shutdown: fn()) -> Arc<Self> {
        let estimated_mb = if min_ram_gb > 0 {
            min_ram_gb.saturating_mul(1024)
        } else {
            estimate_mlx_memory_mb(repo_id).unwrap_or(u32::MAX)
        };
        let path = std::path::Path::new(repo_id);
        let identity = if path.exists() {
            path.canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .to_string()
        } else {
            repo_id.to_string()
        };
        Arc::new(MlxResident {
            id: format!("mlx:{identity}"),
            estimated_mb,
            shutdown_fn: shutdown,
        })
    }
}

fn estimate_mlx_memory_mb(model: &str) -> Option<u32> {
    let path = std::path::Path::new(model);
    if path.exists() {
        let bytes = path_size_bytes(path)?;
        let mb = bytes.saturating_add(1024 * 1024 - 1) / 1024 / 1024;
        let with_headroom = mb.saturating_mul(5) / 4;
        return Some(u32::try_from(with_headroom).unwrap_or(u32::MAX).max(1));
    }

    let params_b = parameter_billions(model)?;
    let lower = model.to_ascii_lowercase();
    let mb_per_billion = if lower.contains("4bit")
        || lower.contains("4-bit")
        || lower.contains("q4")
        || lower.contains("optiq")
    {
        // Deliberately conservative versus raw 4-bit weights: one GiB per
        // billion parameters plus 25% working-memory headroom.
        1_280_f64
    } else if lower.contains("8bit") || lower.contains("8-bit") || lower.contains("q8") {
        1_536_f64
    } else {
        // No quantization fact: assume 16-bit weights plus 25% headroom.
        2_560_f64
    };
    Some((params_b * mb_per_billion).ceil().min(u32::MAX as f64) as u32)
}

fn parameter_billions(model: &str) -> Option<f64> {
    let bytes = model.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if !matches!(byte, b'b' | b'B') || index == 0 {
            continue;
        }
        let mut start = index;
        while start > 0 && (bytes[start - 1].is_ascii_digit() || bytes[start - 1] == b'.') {
            start -= 1;
        }
        if start < index {
            if let Ok(value) = model[start..index].parse::<f64>() {
                if value.is_finite() && value > 0.0 {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn path_size_bytes(path: &std::path::Path) -> Option<u64> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    if metadata.is_file() {
        return Some(metadata.len());
    }
    if !metadata.is_dir() {
        return None;
    }
    let mut total = 0_u64;
    for entry in std::fs::read_dir(path).ok()? {
        let entry = entry.ok()?;
        total = total.saturating_add(path_size_bytes(&entry.path())?);
    }
    Some(total)
}

impl ResidentModel for MlxResident {
    fn id(&self) -> &str {
        &self.id
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
    use crate::model_residency::ResidencyManager;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SHUT_COUNT: AtomicUsize = AtomicUsize::new(0);
    fn fake_shutdown() {
        SHUT_COUNT.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn id_is_repo_id_and_estimate_uses_min_ram() {
        let m = MlxResident::new("mlx-community/Llama-3.2-3B-4bit", 4, fake_shutdown);
        assert_eq!(m.id(), "mlx:mlx-community/Llama-3.2-3B-4bit");
        assert_eq!(m.estimated_vram_mb(), 4 * 1024);
    }

    #[test]
    fn unknown_catalog_hint_uses_repo_scale_instead_of_a_fixed_default() {
        let small = MlxResident::new("mlx-community/Qwen2.5-7B-Instruct-4bit", 0, fake_shutdown);
        let large = MlxResident::new("mlx-community/Qwen3.6-27B-OptiQ-4bit", 0, fake_shutdown);
        assert_eq!(small.estimated_vram_mb(), 7 * 1_280);
        assert_eq!(large.estimated_vram_mb(), 27 * 1_280);
        assert!(large.estimated_vram_mb() > 16 * 1024);
        assert!(ResidencyManager::new(16 * 1024).register(large).is_err());
    }

    #[test]
    fn unknown_repo_scale_fails_closed() {
        let m = MlxResident::new("mlx-community/whatever", 0, fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), u32::MAX);
    }

    #[test]
    fn local_model_uses_file_size_plus_headroom() {
        let path = std::env::temp_dir().join(format!(
            "lunery-mlx-resident-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir(&path).expect("create fixture dir");
        let shard = std::fs::File::create(path.join("weights.safetensors")).expect("create shard");
        shard.set_len(8 * 1024 * 1024 + 1).expect("size shard");

        let m = MlxResident::new(path.to_str().expect("utf8 path"), 0, fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), 11);

        std::fs::remove_dir_all(path).expect("remove fixture dir");
    }

    #[cfg(unix)]
    #[test]
    fn local_model_symlink_loop_fails_closed() {
        let path = std::env::temp_dir().join(format!(
            "lunery-mlx-resident-loop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir(&path).expect("create fixture dir");
        std::os::unix::fs::symlink(".", path.join("loop")).expect("create symlink loop");

        let m = MlxResident::new(path.to_str().expect("utf8 path"), 0, fake_shutdown);
        assert_eq!(m.estimated_vram_mb(), u32::MAX);

        std::fs::remove_dir_all(path).expect("remove fixture dir");
    }

    #[test]
    fn shutdown_delegates() {
        let before = SHUT_COUNT.load(Ordering::SeqCst);
        let m = MlxResident::new("mlx-community/whatever", 4, fake_shutdown);
        m.shutdown();
        assert_eq!(SHUT_COUNT.load(Ordering::SeqCst), before + 1);
    }
}
