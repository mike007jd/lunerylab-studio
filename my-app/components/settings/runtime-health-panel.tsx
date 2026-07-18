"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchRuntimeProbe,
  getDesktopRuntime,
  useDesktopAvailable,
  useDesktopLocalRuntimes,
  type LocalRuntime,
} from "@/hooks/use-desktop-available";
import { useLocalModelSummary } from "@/hooks/use-local-model-summary";
import { AdvancedDisclosure } from "@/components/ui/advanced-disclosure";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/ui/page-primitives";
import { Activity } from "@/components/ui/icons";
import {
  RuntimeHealthRow,
  RuntimeHealthRowSkeleton,
  type RuntimeHealthRowView,
} from "@/components/settings/runtime-health-row";
import { useI18n } from "@/lib/i18n/provider";
import type { AccelInfo, RuntimeProbeResult } from "@/lib/desktop-runtime";

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const COPY = {
  en: {
    title: "Local AI status",
    subtitle: "Local AI on this computer.",
    reachable: "Connected",
    unreachable: "Not detected",
    probing: "Checking…",
    models: "models",
    testConnection: "Test connection",
    testing: "Testing…",
    comfyUiUnreachable:
      "Not detected — install & start ComfyUI, or use a cloud key",
    ready: "Ready",
    notReady: "Not ready",
    imageCapability: "Image creation",
    textCapability: "Text help",
    imageNotReady: "Set up image creation.",
    textNotReady: "Set up text help.",
    checkingDetail: "Reading local AI status.",
    appleSilicon: "Apple Silicon",
    detected: "Detected",
    notDetected: "Not detected",
    checkFailed: "Couldn't check",
    builtInImageEngine: "Built-in image engine",
    mlxEngine: "Apple text engine",
    builtInTextEngine: "Built-in text engine",
    builtInDetail: "Built into Lunery",
    installed: "Installed",
    idle: "Idle",
    notInstalled: "Not installed",
    advancedTitle: "Advanced",
    pending: "Setting up…",
    runtimeUnavailableTitle: "Local AI not running",
    runtimeUnavailableDescription: "Open the desktop app to use local AI.",
  },
  zh: {
    title: "本地 AI 状态",
    subtitle: "这台电脑上的本地 AI。",
    reachable: "已连接",
    unreachable: "未检测到",
    probing: "检查中…",
    models: "个模型",
    testConnection: "测试连接",
    testing: "测试中…",
    comfyUiUnreachable:
      "未检测到 — 请安装并启动 ComfyUI，或使用云端 key",
    ready: "已就绪",
    notReady: "未就绪",
    imageCapability: "图片创作",
    textCapability: "文字辅助",
    imageNotReady: "请先设置图片创作。",
    textNotReady: "请先设置文字辅助。",
    checkingDetail: "正在读取本地 AI 状态。",
    appleSilicon: "Apple 芯片",
    detected: "已检测",
    notDetected: "未检测到",
    checkFailed: "无法检查",
    builtInImageEngine: "内置图片引擎",
    mlxEngine: "Apple 文字引擎",
    builtInTextEngine: "内置文字引擎",
    builtInDetail: "Lunery 内置",
    installed: "已安装",
    idle: "空闲",
    notInstalled: "未安装",
    advancedTitle: "高级",
    pending: "准备中…",
    runtimeUnavailableTitle: "本地 AI 尚未运行",
    runtimeUnavailableDescription: "打开桌面应用即可使用本地 AI。",
  },
  // Traditional Chinese. Previously zh-TW fell through to the simplified `zh`
  // block (the locale==='en'?en:zh bug); this restores correct 繁中. A move to
  // the central i18n catalog is a fast-follow — the formatter-valued copy in
  // LocalModelsPanel makes a one-shot migration disproportionate.
  zhTW: {
    title: "本地 AI 狀態",
    subtitle: "這台電腦上的本地 AI。",
    reachable: "已連接",
    unreachable: "未檢測到",
    probing: "檢查中…",
    models: "個模型",
    testConnection: "測試連線",
    testing: "測試中…",
    comfyUiUnreachable:
      "未檢測到 — 請安裝並啟動 ComfyUI，或使用雲端 key",
    ready: "已就緒",
    notReady: "未就緒",
    imageCapability: "圖片創作",
    textCapability: "文字輔助",
    imageNotReady: "請先設定圖片創作。",
    textNotReady: "請先設定文字輔助。",
    checkingDetail: "正在讀取本地 AI 狀態。",
    appleSilicon: "Apple 晶片",
    detected: "已偵測",
    notDetected: "未偵測到",
    checkFailed: "無法檢查",
    builtInImageEngine: "內建圖片引擎",
    mlxEngine: "Apple 文字引擎",
    builtInTextEngine: "內建文字引擎",
    builtInDetail: "Lunery 內建",
    installed: "已安裝",
    idle: "閒置",
    notInstalled: "未安裝",
    advancedTitle: "進階",
    pending: "準備中…",
    runtimeUnavailableTitle: "本地 AI 尚未執行",
    runtimeUnavailableDescription: "打開桌面應用即可使用本地 AI。",
  },
} as const;

// ---------------------------------------------------------------------------
// Runtime definitions
// ---------------------------------------------------------------------------

interface RuntimeDef {
  id: "ollama" | "lm-studio" | "comfyui";
  label: string;
  endpoint: string;
}

const LOCAL_RUNTIMES: RuntimeDef[] = [
  { id: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434" },
  { id: "lm-studio", label: "LM Studio", endpoint: "http://127.0.0.1:1234" },
  { id: "comfyui", label: "ComfyUI", endpoint: "http://127.0.0.1:8188" },
];

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

type CopyShape = (typeof COPY)["en"] | (typeof COPY)["zh"] | (typeof COPY)["zhTW"];

export function capabilityHealthView({
  label,
  activeLabel,
  ready,
  checking,
  notReadyDetail,
  copy,
}: {
  label: string;
  activeLabel: string | null;
  ready: boolean;
  checking: boolean;
  notReadyDetail: string;
  copy: CopyShape;
}): RuntimeHealthRowView {
  if (checking) {
    return {
      label,
      detail: copy.checkingDetail,
      state: "checking",
      statusLabel: copy.probing,
    };
  }
  if (ready) {
    return {
      label,
      detail: activeLabel ?? copy.ready,
      state: "ready",
      statusLabel: copy.ready,
    };
  }
  return {
    label,
    detail: notReadyDetail,
    state: "unreachable",
    statusLabel: copy.notReady,
  };
}

export function hardwareHealthView(
  accel: AccelInfo | null,
  checking: boolean,
  copy: CopyShape,
): RuntimeHealthRowView {
  if (checking) {
    return {
      label: copy.appleSilicon,
      detail: copy.checkingDetail,
      state: "checking",
      statusLabel: copy.probing,
    };
  }
  if (accel === null) {
    return {
      label: copy.appleSilicon,
      detail: copy.checkFailed,
      state: "unreachable",
      statusLabel: copy.checkFailed,
    };
  }
  return {
    label: copy.appleSilicon,
    detail: accel.vendor || accel.gpu,
    state: accel.platform === "macos-arm64" ? "ready" : "unreachable",
    statusLabel: accel.platform === "macos-arm64" ? copy.detected : copy.notDetected,
  };
}

export function embeddedEngineHealthView({
  runtime,
  label,
  checking,
  readyMeansInstalled = false,
  copy,
}: {
  runtime: LocalRuntime | null;
  label: string;
  checking: boolean;
  readyMeansInstalled?: boolean;
  copy: CopyShape;
}): RuntimeHealthRowView {
  if (checking) {
    return {
      label,
      detail: copy.builtInDetail,
      state: "checking",
      statusLabel: copy.probing,
    };
  }
  if (!runtime || runtime.installed === false) {
    return {
      label,
      detail: copy.builtInDetail,
      state: "unreachable",
      statusLabel: copy.notInstalled,
    };
  }
  if (runtime.status === "starting" || runtime.status === "downloading") {
    return {
      label,
      detail: copy.builtInDetail,
      state: "pending",
      statusLabel: copy.pending,
    };
  }
  if (runtime.status === "ready") {
    return {
      label,
      detail: copy.builtInDetail,
      state: "ready",
      statusLabel: readyMeansInstalled ? copy.installed : copy.ready,
    };
  }
  return {
    label,
    detail: copy.builtInDetail,
    state: "pending",
    statusLabel: copy.idle,
  };
}

/** Probe result → the shared row's typed view data. */
function probedRuntimeView(
  runtime: RuntimeDef,
  probe: RuntimeProbeResult | null | undefined,
  copy: CopyShape,
): RuntimeHealthRowView {
  if (probe === undefined) {
    return {
      label: runtime.label,
      detail: runtime.endpoint,
      state: "checking",
      statusLabel: copy.probing,
    };
  }
  const reachable = probe?.reachable ?? false;
  const modelCount = probe?.models.length ?? 0;
  if (reachable) {
    return {
      label: runtime.label,
      detail: runtime.endpoint,
      state: "ready",
      statusLabel: copy.reachable,
      note: modelCount > 0 ? `${modelCount} ${copy.models}` : undefined,
    };
  }
  return {
    label: runtime.label,
    detail: runtime.endpoint,
    state: "unreachable",
    statusLabel: copy.unreachable,
    note: runtime.id === "comfyui" ? copy.comfyUiUnreachable : undefined,
  };
}

/** An endpoint-probed runtime: the shared row plus its optional re-probe action. */
function ProbedRuntimeRow({
  runtime,
  probe,
  isLoading,
  copy,
}: {
  runtime: RuntimeDef;
  probe: RuntimeProbeResult | null | undefined;
  isLoading: boolean;
  copy: CopyShape;
}) {
  const [testing, setTesting] = useState(false);
  const [liveProbe, setLiveProbe] = useState<{
    baseProbe: RuntimeProbeResult | null | undefined;
    result: RuntimeProbeResult | null;
  } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // A manual result only overrides the exact shared snapshot it tested. Once
  // the shared poll publishes a new snapshot, that fresher truth wins.
  const effectiveProbe = liveProbe && liveProbe.baseProbe === probe ? liveProbe.result : probe;

  async function handleTest() {
    setTesting(true);
    const result = await fetchRuntimeProbe(runtime.endpoint);
    if (mountedRef.current) {
      setLiveProbe({ baseProbe: probe, result });
      setTesting(false);
    }
  }

  if (isLoading) return <RuntimeHealthRowSkeleton />;

  return (
    <RuntimeHealthRow
      view={probedRuntimeView(runtime, effectiveProbe, copy)}
      action={
        <Button
          type="button"
          size="sm"
          variant="ghostMuted"
          loading={testing}
          onClick={() => void handleTest()}
        >
          {copy.testConnection}
        </Button>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Main panel — desktop-gated, mirrors LocalModelsPanel self-hide pattern
// ---------------------------------------------------------------------------

export function RuntimeHealthPanel() {
  const { locale } = useI18n();
  const copy = locale === "en" ? COPY.en : locale === "zh-TW" ? COPY.zhTW : COPY.zh;

  const available = useDesktopAvailable();
  const runtimes = useDesktopLocalRuntimes();
  const localSummary = useLocalModelSummary();
  const [probes, setProbes] = useState<Record<string, RuntimeProbeResult | null | undefined>>(
    // undefined = still loading, null = fetch failed, RuntimeProbeResult = done
    Object.fromEntries(LOCAL_RUNTIMES.map((rt) => [rt.id, undefined])),
  );
  const llamaRuntime = getDesktopRuntime(runtimes, "llama-cpp");
  const sdRuntime = getDesktopRuntime(runtimes, "sd-cpp");
  const mlxRuntime = getDesktopRuntime(runtimes, "mlx");
  const capabilityChecking = available === null || localSummary.isChecking;
  const capabilityViews = [
    capabilityHealthView({
      label: copy.imageCapability,
      activeLabel: localSummary.currentImageModel,
      ready: localSummary.hasReadyImage,
      checking: capabilityChecking,
      notReadyDetail: copy.imageNotReady,
      copy,
    }),
    capabilityHealthView({
      label: copy.textCapability,
      activeLabel: localSummary.currentTextModel,
      ready: localSummary.hasReadyText,
      checking: capabilityChecking,
      notReadyDetail: copy.textNotReady,
      copy,
    }),
  ];
  const embeddedViews = [
    embeddedEngineHealthView({
      runtime: sdRuntime,
      label: copy.builtInImageEngine,
      checking: available === null,
      readyMeansInstalled: true,
      copy,
    }),
    embeddedEngineHealthView({
      runtime: llamaRuntime,
      label: copy.builtInTextEngine,
      checking: available === null,
      copy,
    }),
    embeddedEngineHealthView({
      runtime: mlxRuntime,
      label: copy.mlxEngine,
      checking: available === null,
      copy,
    }),
  ];

  useEffect(() => {
    // Only probe runtimes once the desktop bridge is confirmed available.
    if (!available) return;

    let active = true;

    async function load() {
      const comfyUi = LOCAL_RUNTIMES.find((runtime) => runtime.id === "comfyui");
      if (!comfyUi) return;
      const result = await fetchRuntimeProbe(comfyUi.endpoint);
      if (active) {
        setProbes((prev) => ({ ...prev, [comfyUi.id]: result }));
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [available]);

  if (available === false) {
    return (
      <SurfaceCard className="space-y-3">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-(--warning-soft) text-(--warning)">
            <Activity className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-(--text-primary)">
              {copy.runtimeUnavailableTitle}
            </h2>
            <p className="mt-1 text-xs leading-5 text-(--text-muted)">
              {copy.runtimeUnavailableDescription}
            </p>
          </div>
        </div>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-(--accent-glow-soft) text-(--accent-glow)">
          <Activity className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-(--text-primary)">{copy.title}</h2>
        </div>
      </div>

      {/* User-facing capability truth stays primary. Technical engine and
          hardware details remain available under progressive disclosure. */}
      <div className="divide-y divide-(--border-subtle)">
        {capabilityViews.map((view) => (
          <RuntimeHealthRow key={view.label} view={view} />
        ))}
      </div>

      <AdvancedDisclosure title={copy.advancedTitle}>
        <div className="divide-y divide-(--border-subtle)">
          <RuntimeHealthRow
            view={hardwareHealthView(localSummary.accel, available === null, copy)}
          />
          {embeddedViews.map((view) => (
            <RuntimeHealthRow key={view.label} view={view} />
          ))}
          {LOCAL_RUNTIMES.map((rt) => {
            const probe = rt.id === "comfyui"
              ? probes[rt.id]
              : localSummary.externalTextProbes[rt.id];
            return (
              <ProbedRuntimeRow
                key={rt.id}
                runtime={rt}
                probe={probe}
                isLoading={available !== true || probe === undefined}
                copy={copy}
              />
            );
          })}
        </div>
      </AdvancedDisclosure>
    </SurfaceCard>
  );
}
