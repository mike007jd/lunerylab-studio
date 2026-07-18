export interface AccelInfo {
  platform: "macos-arm64" | "windows-x64" | "linux" | string;
  gpu: "metal" | "cuda" | "vulkan" | "cpu" | string;
  vendor: string;
}

export interface HardwareInfo {
  arch: string;
  ram_gb: number;
  apple_silicon: boolean;
  gpu_vendor: string | null;
  /** "metal" | "cuda" | "vulkan" | "cpu" — primary acceleration tier. */
  gpu_accel: string;
  disk_available_gb: number;
}

export interface RuntimeProbeResult {
  endpoint: string;
  reachable: boolean;
  models: string[];
  latency_ms: number;
}

export const DESKTOP_ENV_VALUE = "1";

// Browser-deny list: workspace and retired account/monetization routes redirect
// to the standalone website when served outside the desktop runtime.
export const WEB_WORKSPACE_ROUTES = [
  "/studio",
  "/projects",
  "/library",
  "/settings",
  "/canvas",
  "/tools",
  "/workflow-kits",
  "/billing",
  "/license",
] as const;

export function isDesktopRuntime() {
  return process.env.LUNERY_DESKTOP === DESKTOP_ENV_VALUE;
}

export function isDesktopOnlyRoute(pathname: string): boolean {
  return WEB_WORKSPACE_ROUTES.some((route) => pathname === route || pathname.startsWith(route + "/"));
}
