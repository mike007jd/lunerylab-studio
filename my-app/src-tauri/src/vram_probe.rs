//! VRAM budget auto-detection.
//!
//! The ResidencyManager defaults to "unlimited" (budget_mb = 0) when nothing
//! tells it otherwise. That works for development but is dangerous on a real
//! 16 GB MacBook where two FLUX checkpoints would happily OOM. This module
//! returns a defensible default the manager can adopt at startup.
//!
//! Rationale:
//!   - macOS (Apple Silicon): unified memory. We can't ask for "VRAM" per se;
//!     we take total RAM and reserve a third of it for the OS + Next + WebView
//!     + the user's other apps. The shipping FLUX-Q4 footprint (~12 GB) plus
//!     a 4 GB SD15 still comfortably fits inside a 16 GB / 3 * 2 = ~10 GB cap.
//!     A 32 GB machine gets ~21 GB which lets FLUX + SDXL stay hot.
//!   - Discrete-GPU Windows / Linux: dedicated VRAM matters. Without
//!     nvml-wrapper we can't query it cleanly, so we fall back to a
//!     conservative 8 GB cap — the most common consumer NVIDIA tier
//!     (RTX 3060 8GB / 4060 8GB) — and let the user override via the
//!     Settings slider (`residency_set_budget`).
//!   - CPU-only / unknown: zero (unlimited). The bottleneck there is RAM
//!     swap, not eviction, and we don't want to surprise users with churn.

use sysinfo::System;

/// Return a starting VRAM budget in megabytes for the residency manager.
/// `0` means "no limit" — the manager will never evict anything.
pub fn detect_budget_mb() -> u32 {
    // macOS Apple Silicon: unified memory. Reserve ~1/3 for the OS + app +
    // user apps; round to 256 MB so the slider lands on a clean number.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let total_mb = total_ram_mb();
        if total_mb == 0 {
            return 0;
        }
        let budget = (total_mb / 3) * 2;
        return round_down_to(budget, 256);
    }

    // Windows / Linux with potential NVIDIA discrete GPU. Try `nvidia-smi`
    // first — it's installed alongside any modern NVIDIA driver and reports
    // the actual VRAM ceiling, so a 24 GB 3090 user doesn't get stuck on the
    // 8 GB safety cap. If the probe fails (no NVIDIA, driver mismatch, PATH
    // weirdness) we fall back to the conservative 8 GB cap that matches the
    // most common consumer tier (3060/4060/5060 8GB) and let the user override
    // via Settings → Residency slider.
    #[cfg(any(
        all(target_os = "windows"),
        all(target_os = "linux", target_arch = "x86_64"),
    ))]
    {
        if let Some(real_mb) = nvidia_smi_total_memory_mb() {
            return real_mb;
        }
        return 8 * 1024;
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    {
        return 0;
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn total_ram_mb() -> u32 {
    let mut sys = System::new();
    sys.refresh_memory();
    // sysinfo reports bytes; convert and clamp to u32 (>4 TB unified memory
    // is not a thing we need to plan for).
    let bytes = sys.total_memory();
    u32::try_from(bytes / 1024 / 1024).unwrap_or(u32::MAX)
}

/// Best-effort NVIDIA VRAM probe. `nvidia-smi --query-gpu=memory.total
/// --format=csv,noheader,nounits` prints one integer per GPU; we sum if there
/// are multiple. `None` on any failure (binary missing, non-zero exit, parse
/// error, no GPUs reported) — caller falls back to the static cap.
#[cfg(any(
    all(target_os = "windows"),
    all(target_os = "linux", target_arch = "x86_64"),
))]
fn nvidia_smi_total_memory_mb() -> Option<u32> {
    use std::process::Command;
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let total: u32 = stdout
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .sum();
    if total == 0 {
        return None;
    }
    Some(total)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn round_down_to(value: u32, step: u32) -> u32 {
    if step == 0 {
        return value;
    }
    (value / step) * step
}

// Suppress the unused-import warning on platforms where total_ram_mb isn't
// compiled (Windows / Linux take the constant branch).
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
#[allow(dead_code)]
fn _sysinfo_unused_marker() {
    let _ = std::marker::PhantomData::<System>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_budget_is_either_unlimited_or_at_least_two_gigs() {
        // We can't pin a value (different CI hosts have different RAM), but
        // any sane outcome is either "0 = unlimited" or "enough to hold one
        // mid-sized model". This guards against accidental tiny budgets that
        // would refuse every register() call.
        let mb = detect_budget_mb();
        assert!(
            mb == 0 || mb >= 2048,
            "VRAM budget should be 0 or >= 2 GB, got {mb}",
        );
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn round_down_aligns_to_step() {
        assert_eq!(round_down_to(10_500, 256), 10_496);
        assert_eq!(round_down_to(256, 256), 256);
        assert_eq!(round_down_to(255, 256), 0);
        assert_eq!(round_down_to(100, 0), 100); // step=0 = no rounding
    }
}
