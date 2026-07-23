//! VRAM budget auto-detection.
//!
//! The ResidencyManager treats `budget_mb = 0` as unlimited. Auto-detection
//! must therefore always return a finite value, including when a GPU probe is
//! unavailable, so an unknown machine never silently becomes unlimited.
//!
//! Rationale:
//!   - macOS (Apple Silicon): unified memory. We can't ask for "VRAM" per se;
//!     we take total RAM and reserve a third of it for the OS + Next + WebView
//!     and the user's other apps. A 32 GB machine gets about 21 GB for models.
//!   - Discrete-GPU Windows / Linux: use the largest VRAM value actually
//!     reported by `nvidia-smi`. Multiple cards are not summed because one
//!     model is not automatically sharded across them.
//!   - CPU-only / probe failure: use two thirds of measured system RAM. This
//!     is a real capacity signal, not a fabricated GPU tier.

use sysinfo::System;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GpuMemoryProbe {
    SharedOrAbsent,
    Dedicated(u32),
    DedicatedUnknown,
}

/// Return a finite starting memory budget in megabytes for the residency
/// manager. `1` is the fail-closed sentinel when no capacity can be measured;
/// `0` is never returned because the manager interprets it as unlimited.
pub fn detect_budget_mb() -> u32 {
    let total_mb = total_ram_mb();
    budget_from_probes(total_mb, detect_gpu_memory())
}

#[cfg(target_os = "macos")]
fn detect_gpu_memory() -> GpuMemoryProbe {
    macos_gpu_memory_probe()
}

#[cfg(target_os = "windows")]
fn detect_gpu_memory() -> GpuMemoryProbe {
    nvidia_smi_total_memory_mb()
        .map(GpuMemoryProbe::Dedicated)
        .unwrap_or_else(windows_gpu_memory_probe)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn detect_gpu_memory() -> GpuMemoryProbe {
    nvidia_smi_total_memory_mb()
        .map(GpuMemoryProbe::Dedicated)
        .unwrap_or_else(linux_drm_gpu_memory_probe)
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    all(target_os = "linux", target_arch = "x86_64")
)))]
fn detect_gpu_memory() -> GpuMemoryProbe {
    GpuMemoryProbe::SharedOrAbsent
}

fn total_ram_mb() -> u32 {
    let mut sys = System::new();
    sys.refresh_memory();
    // sysinfo reports bytes; convert and clamp to u32 (>4 TB unified memory
    // is not a thing we need to plan for).
    let bytes = sys.total_memory();
    u32::try_from(bytes / 1024 / 1024).unwrap_or(u32::MAX)
}

fn budget_from_probes(total_ram_mb: u32, gpu: GpuMemoryProbe) -> u32 {
    let system_budget = round_down_to((total_ram_mb / 3).saturating_mul(2), 256);
    match (system_budget, gpu) {
        (_, GpuMemoryProbe::DedicatedUnknown) => 1,
        (0, GpuMemoryProbe::SharedOrAbsent) => 1,
        (0, GpuMemoryProbe::Dedicated(gpu_mb)) => gpu_mb.max(1),
        (ram, GpuMemoryProbe::SharedOrAbsent) => ram,
        // A model needs both host RAM and device VRAM. The smaller measured
        // ceiling is the defensible process budget.
        (ram, GpuMemoryProbe::Dedicated(gpu_mb)) => ram.min(gpu_mb.max(1)),
    }
}

#[cfg(target_os = "macos")]
fn macos_gpu_memory_probe() -> GpuMemoryProbe {
    let output = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output();
    match output {
        Ok(output) if output.status.success() => parse_macos_gpu_memory(&output.stdout),
        _ => GpuMemoryProbe::DedicatedUnknown,
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_gpu_memory(stdout: &[u8]) -> GpuMemoryProbe {
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return GpuMemoryProbe::DedicatedUnknown;
    };
    let Some(gpus) = payload
        .get("SPDisplaysDataType")
        .and_then(serde_json::Value::as_array)
    else {
        return GpuMemoryProbe::DedicatedUnknown;
    };
    let mut saw_discrete = false;
    let mut largest_mb = 0_u32;
    for gpu in gpus {
        let vendor = gpu
            .get("spdisplays_vendor")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let model = gpu
            .get("sppci_model")
            .or_else(|| gpu.get("_name"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if vendor.contains("apple") || vendor.contains("intel") || model.contains("apple") {
            continue;
        }
        saw_discrete = true;
        for key in ["spdisplays_vram", "spdisplays_vram_shared"] {
            if let Some(value) = gpu
                .get(key)
                .and_then(serde_json::Value::as_str)
                .and_then(parse_memory_label_mb)
            {
                largest_mb = largest_mb.max(value);
            }
        }
    }
    if largest_mb > 0 {
        GpuMemoryProbe::Dedicated(largest_mb)
    } else if saw_discrete {
        GpuMemoryProbe::DedicatedUnknown
    } else {
        GpuMemoryProbe::SharedOrAbsent
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_memory_label_mb(value: &str) -> Option<u32> {
    let mut parts = value.split_whitespace();
    let amount = parts.next()?.parse::<f64>().ok()?;
    let unit = parts.next()?.to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "gb" | "gib" => 1024_f64,
        "mb" | "mib" => 1_f64,
        _ => return None,
    };
    Some((amount * multiplier).floor().min(u32::MAX as f64) as u32)
}

#[cfg(target_os = "windows")]
fn windows_gpu_memory_probe() -> GpuMemoryProbe {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.AdapterCompatibility)|$($_.Name)|$($_.AdapterRAM)\" }",
        ])
        .output();
    match output {
        Ok(output) if output.status.success() => parse_windows_gpu_memory(&output.stdout),
        _ => GpuMemoryProbe::DedicatedUnknown,
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_gpu_memory(stdout: &[u8]) -> GpuMemoryProbe {
    let text = String::from_utf8_lossy(stdout);
    let mut saw_discrete = false;
    let mut largest_mb = 0_u32;
    for line in text.lines() {
        let parts = line.split('|').collect::<Vec<_>>();
        if parts.len() != 3 {
            continue;
        }
        let identity = format!("{} {}", parts[0], parts[1]).to_ascii_lowercase();
        let discrete = identity.contains("nvidia")
            || identity.contains("amd")
            || identity.contains("advanced micro devices")
            || identity.contains("intel(r) arc")
            || identity.contains("intel arc");
        if !discrete {
            continue;
        }
        saw_discrete = true;
        if let Ok(bytes) = parts[2].trim().parse::<u64>() {
            largest_mb = largest_mb.max(
                u32::try_from(bytes / 1024 / 1024)
                    .unwrap_or(u32::MAX)
                    .max(1),
            );
        }
    }
    if largest_mb > 0 {
        GpuMemoryProbe::Dedicated(largest_mb)
    } else if saw_discrete {
        GpuMemoryProbe::DedicatedUnknown
    } else {
        GpuMemoryProbe::SharedOrAbsent
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn linux_drm_gpu_memory_probe() -> GpuMemoryProbe {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return GpuMemoryProbe::SharedOrAbsent;
    };
    let mut saw_discrete = false;
    let mut largest_mb = 0_u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device = entry.path().join("device");
        let vendor = std::fs::read_to_string(device.join("vendor")).unwrap_or_default();
        let vram_bytes = std::fs::read_to_string(device.join("mem_info_vram_total"))
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0);
        if let Some(bytes) = vram_bytes {
            saw_discrete = true;
            largest_mb = largest_mb.max(u32::try_from(bytes / 1024 / 1024).unwrap_or(u32::MAX));
        } else if matches!(vendor.trim(), "0x1002" | "0x10de") {
            saw_discrete = true;
        }
    }
    if largest_mb > 0 {
        GpuMemoryProbe::Dedicated(largest_mb)
    } else if saw_discrete {
        GpuMemoryProbe::DedicatedUnknown
    } else {
        GpuMemoryProbe::SharedOrAbsent
    }
}

/// Best-effort NVIDIA VRAM probe. `nvidia-smi --query-gpu=memory.total
/// --format=csv,noheader,nounits` prints one integer per GPU. We use the
/// largest single device rather than summing because
/// the local engines do not promise automatic multi-GPU sharding. `None` on
/// any failure (binary missing, non-zero exit, parse error, no GPUs reported).
#[cfg(any(
    target_os = "windows",
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
    parse_largest_gpu_memory_mb(&stdout)
}

#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", target_arch = "x86_64"),
    test
))]
fn parse_largest_gpu_memory_mb(stdout: &str) -> Option<u32> {
    stdout
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .max()
}

fn round_down_to(value: u32, step: u32) -> u32 {
    if step == 0 {
        return value;
    }
    (value / step) * step
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_budget_is_always_finite() {
        let mb = detect_budget_mb();
        assert!(mb > 0, "auto-detected budget must never mean unlimited");
    }

    #[test]
    fn round_down_aligns_to_step() {
        assert_eq!(round_down_to(10_500, 256), 10_496);
        assert_eq!(round_down_to(256, 256), 256);
        assert_eq!(round_down_to(255, 256), 0);
        assert_eq!(round_down_to(100, 0), 100); // step=0 = no rounding
    }

    #[test]
    fn probe_failure_uses_measured_system_ram_not_a_fake_gpu_tier() {
        assert_eq!(
            budget_from_probes(16 * 1024, GpuMemoryProbe::SharedOrAbsent),
            10_752
        );
        assert_eq!(
            budget_from_probes(32 * 1024, GpuMemoryProbe::SharedOrAbsent),
            21_760
        );
        assert_eq!(budget_from_probes(0, GpuMemoryProbe::SharedOrAbsent), 1);
    }

    #[test]
    fn dedicated_gpu_budget_uses_the_smaller_measured_ceiling() {
        assert_eq!(
            budget_from_probes(32 * 1024, GpuMemoryProbe::Dedicated(12 * 1024)),
            12 * 1024
        );
        assert_eq!(
            budget_from_probes(8 * 1024, GpuMemoryProbe::Dedicated(24 * 1024)),
            5_376
        );
        assert_eq!(
            budget_from_probes(64 * 1024, GpuMemoryProbe::DedicatedUnknown),
            1
        );
    }

    #[test]
    fn nvidia_fixture_uses_largest_single_gpu_and_rejects_bad_output() {
        assert_eq!(parse_largest_gpu_memory_mb("8192\n24576\n"), Some(24576));
        assert_eq!(parse_largest_gpu_memory_mb("N/A\n0\n"), None);
    }

    #[test]
    fn macos_discrete_gpu_fixture_uses_reported_vram() {
        let payload = br#"{
            "SPDisplaysDataType": [
                {"spdisplays_vendor":"sppci_vendor_Apple","sppci_model":"Apple M2 Max"},
                {"spdisplays_vendor":"sppci_vendor_AMD","sppci_model":"Radeon Pro", "spdisplays_vram":"8 GB"}
            ]
        }"#;
        assert_eq!(
            parse_macos_gpu_memory(payload),
            GpuMemoryProbe::Dedicated(8 * 1024)
        );
    }

    #[test]
    fn discrete_gpu_without_vram_fails_closed() {
        let mac = br#"{"SPDisplaysDataType":[{"spdisplays_vendor":"sppci_vendor_AMD","sppci_model":"Radeon Pro"}]}"#;
        assert_eq!(
            parse_macos_gpu_memory(mac),
            GpuMemoryProbe::DedicatedUnknown
        );
        assert_eq!(
            parse_windows_gpu_memory(b"Advanced Micro Devices|Radeon Pro|\n"),
            GpuMemoryProbe::DedicatedUnknown
        );
    }
}
