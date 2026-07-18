"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchLlamaStatus,
  fetchMlxStatus,
  fetchRuntimeProbe,
  invalidateDesktopStatusCache,
  useDesktopAccel,
  useDesktopAvailable,
  useDesktopLocalRuntimes,
} from "@/hooks/use-desktop-available";
import { HF_MODEL_CATALOG, type ModelCapability, type ModelRuntimeTarget } from "@/lib/hf-model-catalog";
import type { AccelInfo, RuntimeProbeResult } from "@/lib/desktop-runtime";

interface InstalledModelStatus {
  id: string;
  label?: string;
  imported?: boolean;
  runtimeTarget?: ModelRuntimeTarget;
  capability?: ModelCapability;
  modelPath?: string;
  installed: boolean;
}

interface LlamaStatus {
  running: boolean;
  modelPath: string | null;
}

interface MlxStatus {
  running: boolean;
  model: string | null;
}

export interface LocalModelSummary {
  desktop: boolean | null;
  /** True only until the first capability probe settles. Refreshes keep the last known truth visible. */
  isChecking: boolean;
  installedCount: number;
  currentTextModel: string | null;
  currentImageModel: string | null;
  hasReadyText: boolean;
  hasReadyImage: boolean;
  hasAnyReadyLocal: boolean;
  accel: AccelInfo | null;
  externalTextProbes: Partial<Record<ExternalTextRuntimeId, RuntimeProbeResult | null>>;
}

// Trailing-debounce window for `load()` triggers (Tauri event, visibility,
// 30s interval). Burst events within this window collapse into one fetch.
const REFRESH_DEBOUNCE_MS = 500;
const EXTERNAL_TEXT_RUNTIMES = [
  { id: "ollama", endpoint: "http://127.0.0.1:11434" },
  { id: "lm-studio", endpoint: "http://127.0.0.1:1234" },
] as const;
export type ExternalTextRuntimeId = (typeof EXTERNAL_TEXT_RUNTIMES)[number]["id"];

export function firstDiscoveredExternalTextModel(
  probes: Array<Pick<RuntimeProbeResult, "models" | "reachable"> | null>,
): string | null {
  for (const probe of probes) {
    if (!probe?.reachable) continue;
    const model = probe?.models.find((candidate) => candidate.trim())?.trim();
    if (model) return model;
  }
  return null;
}

export function isLocalModelSummaryChecking(
  desktop: boolean | null,
  hasLoadedRuntimeDetails: boolean,
): boolean {
  return desktop === null || (desktop === true && !hasLoadedRuntimeDetails);
}

export function isTextCapabilityReady({
  llamaModel,
  mlxModel,
  externalTextModel,
  llamaRunning,
  mlxRunning,
}: {
  llamaModel: string | null;
  mlxModel: string | null;
  externalTextModel: string | null;
  llamaRunning: boolean;
  mlxRunning: boolean;
}): boolean {
  return Boolean(
    (llamaRunning && llamaModel) ||
    (mlxRunning && mlxModel) ||
    externalTextModel,
  );
}

// Detect Tauri WebView without import-time side effects (SSR-safe).
function isTauriWebView(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function shallowEqInstalled(
  a: Record<string, InstalledModelStatus>,
  b: Record<string, InstalledModelStatus>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = b[key];
    if (!av || !bv) return false;
    if (
      av.installed !== bv.installed ||
      av.imported !== bv.imported ||
      av.modelPath !== bv.modelPath ||
      av.runtimeTarget !== bv.runtimeTarget ||
      av.capability !== bv.capability ||
      av.label !== bv.label
    ) {
      return false;
    }
  }
  return true;
}

export function useLocalModelSummary(): LocalModelSummary {
  const desktop = useDesktopAvailable();
  const runtimes = useDesktopLocalRuntimes();
  const accel = useDesktopAccel();
  const [installed, setInstalled] = useState<Record<string, InstalledModelStatus>>({});
  const [llama, setLlama] = useState<LlamaStatus | null>(null);
  const [mlx, setMlx] = useState<MlxStatus | null>(null);
  const [externalTextModel, setExternalTextModel] = useState<string | null>(null);
  const [externalTextProbes, setExternalTextProbes] = useState<
    Partial<Record<ExternalTextRuntimeId, RuntimeProbeResult | null>>
  >({});
  const [hasLoadedRuntimeDetails, setHasLoadedRuntimeDetails] = useState(false);

  // Skip-if-in-flight: prevents the three triggers (event, visibility, interval)
  // from stacking up parallel /api/desktop-runtime/* fetches.
  const inflightRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const [modelsRes, llamaRes, mlxRes, externalProbeResults] = await Promise.all([
        fetch("/api/desktop-runtime/models/status", { cache: "no-store" }).catch(() => null),
        fetchLlamaStatus(),
        fetchMlxStatus(),
        Promise.all(
          EXTERNAL_TEXT_RUNTIMES.map(({ endpoint }) => fetchRuntimeProbe(endpoint)),
        ),
      ]);
      if (modelsRes?.ok) {
        const payload = (await modelsRes.json()) as { models?: InstalledModelStatus[] };
        const next = Object.fromEntries((payload.models ?? []).map((item) => [item.id, item]));
        setInstalled((prev) => (shallowEqInstalled(prev, next) ? prev : next));
      }
      if (llamaRes) {
        const next = llamaRes as LlamaStatus;
        setLlama((prev) =>
          prev && prev.running === next.running && prev.modelPath === next.modelPath ? prev : next,
        );
      }
      if (mlxRes) {
        const next = mlxRes as MlxStatus;
        setMlx((prev) =>
          prev && prev.running === next.running && prev.model === next.model ? prev : next,
        );
      }
      setExternalTextModel(firstDiscoveredExternalTextModel(externalProbeResults));
      setExternalTextProbes(
        Object.fromEntries(
          EXTERNAL_TEXT_RUNTIMES.map((runtime, index) => [runtime.id, externalProbeResults[index]]),
        ),
      );
    } finally {
      setHasLoadedRuntimeDetails(true);
      inflightRef.current = false;
    }
  }, []);

  // Trailing-debounce wrapper so a Tauri event + visibility + interval firing
  // in the same window collapse into one fetch.
  const scheduleLoad = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      invalidateDesktopStatusCache();
      void load();
    }, REFRESH_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    if (desktop !== true) return;
    // First load runs immediately — debounce only governs re-triggers.
    void load();

    // Tauri event subscription — Rust watcher emits "local-runtime-changed" on
    // llama/mlx running flag flips and MLX phase transitions. Dynamic import
    // keeps the SSR build clean (the module fails outside the WebView).
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    if (isTauriWebView()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen("local-runtime-changed", () => {
          scheduleLoad();
        }))
        .then((fn) => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        })
        .catch(() => {
          // Plugin missing or webview mismatch — fall through to polling fallback.
        });
    }

    // 30 s polling fallback + visibilitychange refresh. Belt-and-braces in case
    // the Tauri event channel drops or the user opens the panel from a non-
    // Tauri webview (dev `next dev` outside the desktop shell).
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        scheduleLoad();
      }
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        scheduleLoad();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      unlisten?.();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [desktop, load, scheduleLoad]);

  return useMemo(() => {
    const installedItems = Object.values(installed);
    const llamaTextModel =
      installedItems.find(
        (item) =>
          item.imported &&
          item.installed &&
          item.runtimeTarget === "llama-cpp" &&
          Boolean(item.modelPath && llama?.modelPath === item.modelPath),
      )?.label ??
      HF_MODEL_CATALOG.find(
        (entry) =>
          entry.runtimeTarget === "llama-cpp" &&
          Boolean(entry.fileName && llama?.modelPath?.endsWith(entry.fileName)),
      )?.label ??
      null;
    const mlxTextModel =
      HF_MODEL_CATALOG.find(
        (entry) => entry.runtimeTarget === "mlx" && mlx?.model === entry.hfRepo,
      )?.label ?? null;
    const currentTextModel = llamaTextModel ?? mlxTextModel ?? externalTextModel;
    const currentImageModel =
      installedItems.find((item) => item.imported && item.installed && item.capability === "image-gen")?.label ??
      HF_MODEL_CATALOG.find((entry) => entry.capability === "image-gen" && installed[entry.id]?.installed)?.label ??
      null;
    const sdReady = runtimes?.some((runtime) => runtime.id === "sd-cpp" && runtime.status === "ready") ?? false;
    const hasReadyText = isTextCapabilityReady({
      llamaModel: llamaTextModel,
      mlxModel: mlxTextModel,
      externalTextModel,
      llamaRunning: llama?.running === true,
      mlxRunning: mlx?.running === true,
    });
    const hasReadyImage = Boolean(currentImageModel && sdReady);
    const installedCount = installedItems.filter((item) => item.installed).length;

    return {
      desktop,
      isChecking: isLocalModelSummaryChecking(desktop, hasLoadedRuntimeDetails),
      installedCount,
      currentTextModel,
      currentImageModel,
      hasReadyText,
      hasReadyImage,
      hasAnyReadyLocal: hasReadyText || hasReadyImage,
      accel,
      externalTextProbes,
    };
  }, [accel, desktop, externalTextModel, externalTextProbes, hasLoadedRuntimeDetails, installed, llama?.modelPath, llama?.running, mlx?.model, mlx?.running, runtimes]);
}
