use serde::Serialize;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::profile::profile_models_root_path;

#[derive(Serialize, Clone)]
pub struct HardwareInfo {
    pub arch: String,
    pub ram_gb: u64,
    pub apple_silicon: bool,
    pub gpu_vendor: Option<String>,
    /// "metal" | "cuda" | "vulkan" | "cpu"
    pub gpu_accel: String,
    pub disk_available_gb: u64,
}

#[derive(Serialize, Clone)]
pub struct AccelInfo {
    /// Known values include "macos-arm64", "macos-x64", "windows-x64",
    /// "windows-arm64", and "linux". Unrecognized targets stay generic.
    pub platform: &'static str,
    /// "metal" | "cuda" | "vulkan" | "cpu"
    pub gpu: String,
    pub vendor: String,
}

/// Cached AccelInfo — GPU detection shells out to wmic/PowerShell on Windows
/// which is expensive; the hardware does not change at runtime so once is enough.
static ACCEL_INFO: OnceLock<AccelInfo> = OnceLock::new();

pub(crate) fn cached_accel() -> AccelInfo {
    ACCEL_INFO
        .get_or_init(|| {
            let hw = detect_hardware(None);
            AccelInfo {
                platform: platform_id(std::env::consts::OS, std::env::consts::ARCH),
                gpu: hw.gpu_accel,
                vendor: hw.gpu_vendor.unwrap_or_else(|| "Unknown".to_string()),
            }
        })
        .clone()
}

fn platform_id(os: &str, arch: &str) -> &'static str {
    match (os, arch) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        ("macos", _) => "macos",
        ("windows", "aarch64") => "windows-arm64",
        ("windows", "x86_64") => "windows-x64",
        ("windows", _) => "windows",
        ("linux", _) => "linux",
        _ => "unknown",
    }
}

#[cfg(target_os = "windows")]
fn parse_wmic_name(output: String) -> String {
    // wmic /value output: lines like `Name=NVIDIA GeForce RTX 4070`
    output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Name="))
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn detect_hardware(model_dir: Option<String>) -> HardwareInfo {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let ram_gb = sys.total_memory() / 1024 / 1024 / 1024;
    let arch = std::env::consts::ARCH.to_string();
    let apple_silicon = cfg!(target_os = "macos") && arch == "aarch64";
    let path = model_dir
        .map(std::path::PathBuf::from)
        .or_else(|| profile_models_root_path().ok())
        .unwrap_or_default();
    let disk_available_gb =
        crate::download::available_disk_bytes(&path).unwrap_or(0) / 1024 / 1024 / 1024;

    // GPU detection — platform-gated. Results are cached at the AccelInfo layer
    // since this can shell out on Windows.
    #[allow(unused_assignments)]
    let (gpu_vendor, gpu_accel) = {
        #[cfg(target_os = "macos")]
        {
            if apple_silicon {
                (Some("Apple Silicon".to_string()), "metal".to_string())
            } else {
                (Some("Apple (Intel)".to_string()), "cpu".to_string())
            }
        }
        #[cfg(target_os = "windows")]
        {
            // wmic first (fast, present on Win10+), fallback PowerShell CIM
            // (Win11 23H2+ may not ship wmic by default).
            let gpu_name = Command::new("wmic")
                .args(["path", "Win32_VideoController", "get", "Name", "/value"])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(parse_wmic_name)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    Command::new("powershell")
                        .args([
                            "-NoProfile",
                            "-Command",
                            "Get-CimInstance Win32_VideoController | \
                             Select-Object -ExpandProperty Name",
                        ])
                        .output()
                        .ok()
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .map(|s| {
                            s.lines()
                                .map(|l| l.trim())
                                .find(|l| !l.is_empty())
                                .unwrap_or("")
                                .to_string()
                        })
                        .filter(|s| !s.is_empty())
                });

            let accel = match gpu_name.as_deref() {
                Some(n) if n.to_ascii_lowercase().contains("nvidia") => {
                    let cuda_ok = Command::new("nvidia-smi")
                        .arg("-L")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if cuda_ok {
                        "cuda"
                    } else {
                        "vulkan"
                    }
                }
                Some(n)
                    if n.to_ascii_lowercase().contains("amd")
                        || n.to_ascii_lowercase().contains("radeon") =>
                {
                    "vulkan"
                }
                Some(n) if n.to_ascii_lowercase().contains("intel arc") => "vulkan",
                Some(n) if n.to_ascii_lowercase().contains("intel") => "cpu",
                _ => "cpu",
            };
            (gpu_name, accel.to_string())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            (None, "cpu".to_string())
        }
    };

    HardwareInfo {
        arch,
        ram_gb,
        apple_silicon,
        gpu_vendor,
        gpu_accel,
        disk_available_gb,
    }
}

#[derive(Serialize)]
pub(crate) struct RuntimeProbeResult {
    endpoint: String,
    reachable: bool,
    latency_ms: u64,
}

#[tauri::command]
pub(crate) fn probe_local_runtime(endpoint: String) -> RuntimeProbeResult {
    let started = Instant::now();
    let addr = loopback_socket_addr(&endpoint);
    let reachable = addr
        .map(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok())
        .unwrap_or(false);
    RuntimeProbeResult {
        endpoint,
        reachable,
        latency_ms: started.elapsed().as_millis() as u64,
    }
}

pub(crate) fn loopback_socket_addr(endpoint: &str) -> Option<SocketAddr> {
    let parsed = reqwest::Url::parse(endpoint).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    let port = parsed.port_or_known_default().unwrap_or_else(|| {
        if parsed.scheme() == "https" {
            443
        } else {
            80
        }
    });
    (host, port)
        .to_socket_addrs()
        .ok()?
        .find(|addr| addr.ip().is_loopback())
}

#[cfg(test)]
mod tests {
    use super::platform_id;

    #[test]
    fn platform_id_distinguishes_intel_and_apple_silicon_macs() {
        assert_eq!(platform_id("macos", "aarch64"), "macos-arm64");
        assert_eq!(platform_id("macos", "x86_64"), "macos-x64");
    }

    #[test]
    fn platform_id_distinguishes_windows_architectures() {
        assert_eq!(platform_id("windows", "x86_64"), "windows-x64");
        assert_eq!(platform_id("windows", "aarch64"), "windows-arm64");
        assert_eq!(platform_id("linux", "aarch64"), "linux");
        assert_eq!(platform_id("freebsd", "x86_64"), "unknown");
    }
}
