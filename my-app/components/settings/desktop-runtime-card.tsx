"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AdvancedDisclosure } from "@/components/ui/advanced-disclosure";
import { SurfaceCard } from "@/components/ui/page-primitives";
import { useI18n } from "@/lib/i18n/provider";
import { useSharedBootstrapSnapshot } from "@/lib/client/bootstrap-snapshot-provider";
import {
  invalidateBootstrapSnapshot,
  type BootstrapSnapshot,
} from "@/lib/client/use-bootstrap-snapshot";
import type { HardwareInfo, RuntimeProbeResult } from "@/lib/desktop-runtime";
import { fetchDesktopHardware, fetchRuntimeProbe } from "@/hooks/use-desktop-available";
import { ProviderConnectionsPanel } from "./desktop-runtime/provider-connections-panel";
import { RuntimePanels } from "./desktop-runtime/runtime-panels";
import { COPY, DEFAULT_ENDPOINTS, PROVIDER_ORDER } from "./desktop-runtime/constants";
import {
  byokModelInputRoles,
  type ByokConnectionModels,
  type ByokModelRole,
} from "@/lib/byok-providers";
import type {
  DesktopInvoke,
  DesktopBridgePhase,
  DesktopRuntimeStatus,
  ProviderFeedback,
  SavedProviderConnection,
} from "./desktop-runtime/types";
import {
  bridgeInvoke,
  createProviderRequestGate,
  desktopBridgeDisabledReason,
  draftModelsFromConnection,
  providerMeta,
  removeProviderCredentials,
  runProviderSaveSingleFlight,
  saveProviderConnectionTransaction,
} from "./desktop-runtime/utils";

const TEST_COOLDOWN_MS = 3_000;

function toSavedConnections(
  raw: BootstrapSnapshot["providerConnections"],
  providers: BootstrapSnapshot["providers"],
): Record<string, SavedProviderConnection> {
  return Object.fromEntries(
    Object.entries(raw).map(([providerId, connection]) => [
      providerId,
      {
        ...connection,
        capabilities: providerMeta(providerId).capabilities,
        hasSecret: providers[providerId]?.configured === true,
      },
    ]),
  );
}

export function DesktopRuntimeCard({ capability }: { capability?: "text" | "image" | "video" }) {
  const bootstrap = useSharedBootstrapSnapshot();
  return <DesktopRuntimeCardContent bootstrap={bootstrap} capability={capability} />;
}

function DesktopRuntimeCardContent({
  bootstrap,
  capability,
}: {
  bootstrap: BootstrapSnapshot | null;
  capability?: "text" | "image" | "video";
}) {
  const { locale } = useI18n();
  const copy = COPY[locale] ?? COPY.en;
  const [status, setStatus] = useState<DesktopRuntimeStatus | null>(null);
  const [connections, setConnections] = useState<Record<string, SavedProviderConnection>>(() =>
    toSavedConnections(
      bootstrap?.providerConnections ?? {},
      bootstrap?.providers ?? {},
    ),
  );
  const initialProvider = useMemo(() => {
    if (!capability) return "openai";
    return PROVIDER_ORDER.find((id) => {
      const meta = providerMeta(id);
      if (capability === "text") return meta.capabilities.includes("text");
      if (capability === "image") return meta.imageApiMode !== "none";
      return Boolean(meta.videoApiMode && meta.videoApiMode !== "none");
    }) ?? "openai";
  }, [capability]);
  const [draftProvider, setDraftProvider] = useState<string>(initialProvider);
  const [draftEndpoint, setDraftEndpoint] = useState(DEFAULT_ENDPOINTS[initialProvider] ?? "");
  const [draftModels, setDraftModels] = useState<ByokConnectionModels>({});
  const [draftKey, setDraftKey] = useState("");
  const [invokeCommand, setInvokeCommand] = useState<DesktopInvoke | null>(null);
  const [secretFeedback, setSecretFeedback] = useState<ProviderFeedback | null>(null);
  const [profileFeedback, setProfileFeedback] = useState<ProviderFeedback | null>(null);
  const [openingProfileFolder, setOpeningProfileFolder] = useState(false);
  const [bridgePhase, setBridgePhase] = useState<DesktopBridgePhase>("loading");
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [runtimeProbes, setRuntimeProbes] = useState<Record<string, RuntimeProbeResult | null>>({});
  const [testState, setTestState] = useState<{ ok: boolean | null; ms?: number; error?: string } | null>(null);
  // "testing" = request in flight; "cooldown" = post-test lockout so rapid
  // re-clicks can't trip the provider's rate limit.
  const [testPhase, setTestPhase] = useState<"idle" | "testing" | "cooldown">("idle");
  const testCooldownTimerRef = useRef<number | null>(null);
  const activeProviderRef = useRef(draftProvider);
  const savePendingRef = useRef(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [saveRequestGate] = useState(createProviderRequestGate);
  const [testRequestGate] = useState(createProviderRequestGate);

  useEffect(() => {
    return () => {
      if (testCooldownTimerRef.current !== null) {
        window.clearTimeout(testCooldownTimerRef.current);
      }
    };
  }, []);

  // Persist connection metadata (endpoint + per-capability models) to the
  // profile-owned server store, the single source of truth for every surface.
  async function pushConnectionMetaToServer(
    providerId: string,
    meta: { endpoint: string; models?: ByokConnectionModels },
  ): Promise<BootstrapSnapshot["providerConnections"][string]> {
    const response = await fetch("/api/desktop-runtime/provider-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId, endpoint: meta.endpoint, models: meta.models }),
    });

    if (!response.ok) {
      throw new Error(`Provider connection metadata save failed (${response.status})`);
    }
    const payload = (await response.json()) as {
      connection?: BootstrapSnapshot["providerConnections"][string];
    };
    if (!payload.connection) {
      throw new Error("Provider connection metadata response was incomplete");
    }
    return payload.connection;
  }

  useEffect(() => {
    let active = true;

    async function fetchHardware() {
      const info = await fetchDesktopHardware();
      if (info && active) {
        setHardware(info);
      }
    }

    async function probeRuntimes(runtimes: { id: string; endpoint: string }[]) {
      await Promise.all(
        runtimes.map(async (rt) => {
          const probe = await fetchRuntimeProbe(rt.endpoint);
          if (active) {
            setRuntimeProbes((prev) => ({ ...prev, [rt.id]: probe }));
          }
        }),
      );
    }

    async function loadStatus() {
      try {
        const payload = await bridgeInvoke<DesktopRuntimeStatus>("desktop_runtime_status");
        if (!active) return;

        setInvokeCommand(() => bridgeInvoke);
        setStatus(payload);
        setBridgePhase("ready");
        void fetchHardware();
        void probeRuntimes(payload.local_runtimes);
      } catch {
        if (active) {
          setBridgePhase("unavailable");
        }
      }
    }
    void loadStatus();
    return () => {
      active = false;
    };
  }, []);

  const runtimeProviderById = useMemo(
    () => new Map((status?.providers ?? []).map((provider) => [provider.id, provider])),
    [status?.providers],
  );

  const activeProviderHasSecret = useMemo(() => {
    const runtime = runtimeProviderById.get(draftProvider);
    if (runtime) return runtime.configured;
    return status ? false : Boolean(connections[draftProvider]?.hasSecret);
  }, [connections, draftProvider, runtimeProviderById, status]);

  function markProviderSecretStatus(providerId: string, configured: boolean) {
    setStatus((current) => {
      if (!current) return current;
      return {
        ...current,
        providers: current.providers.map((provider) => {
          if (provider.id !== providerId) return provider;
          if (!configured && provider.source === "environment") return provider;
          const nextSource = configured
            ? provider.source === "environment"
              ? "environment"
              : "system-keychain"
            : "none";
          return {
            ...provider,
            configured,
            source: nextSource,
          };
        }),
      };
    });
  }

  const providers = useMemo(() => {
    return PROVIDER_ORDER.filter((id) => {
      if (!capability) return true;
      const meta = providerMeta(id);
      if (capability === "text") return meta.capabilities.includes("text");
      if (capability === "image") return meta.imageApiMode !== "none";
      return Boolean(meta.videoApiMode && meta.videoApiMode !== "none");
    }).map((id) => {
      const saved = connections[id];
      const runtime = runtimeProviderById.get(id);
      const savedSecret = Boolean(saved?.hasSecret);
      const hasRuntimeSecret = runtime ? runtime.configured : status ? false : savedSecret;
      const meta = providerMeta(id);
      return {
        id,
        label: runtime?.label ?? meta.label,
        auth: runtime?.auth ?? "API key",
        configured: Boolean(saved && hasRuntimeSecret),
        meta,
        source:
          runtime?.source === "environment"
            ? copy.env
            : runtime?.source === "system-keychain"
              ? copy.keychain
              : !status && savedSecret
                ? copy.saved
                : copy.notConnected,
      };
    });
  }, [capability, connections, copy.env, copy.keychain, copy.notConnected, copy.saved, runtimeProviderById, status]);

  const activeMeta = providerMeta(draftProvider);
  const visibleRoles = useMemo<ByokModelRole[] | undefined>(() => {
    if (!capability) return undefined;
    const role: ByokModelRole = capability === "text" ? "text" : capability === "image" ? "imageGenerate" : "video";
    return byokModelInputRoles(activeMeta).includes(role) ? [role] : [];
  }, [activeMeta, capability]);
  const draftEndpointReady = !activeMeta.requiresEndpoint || Boolean(draftEndpoint.trim());
  const canTestConnection = Boolean(invokeCommand) &&
    bridgePhase === "ready" &&
    draftEndpointReady &&
    (draftKey.trim().length > 0 || activeProviderHasSecret);

  function selectProvider(providerId: string) {
    activeProviderRef.current = providerId;
    saveRequestGate.invalidate();
    testRequestGate.invalidate();
    if (testCooldownTimerRef.current !== null) {
      window.clearTimeout(testCooldownTimerRef.current);
      testCooldownTimerRef.current = null;
    }
    const saved = connections[providerId];
    const meta = providerMeta(providerId);
    setDraftProvider(providerId);
    setDraftEndpoint(saved?.endpoint || meta.defaultEndpoint || "");
    // Prefill only from the user's saved value — never from a catalog default.
    // The placeholder (rendered below) shows an example without committing it.
    setDraftModels(draftModelsFromConnection(saved));
    setDraftKey("");
    setTestState(null);
    setTestPhase("idle");
    setSecretFeedback(null);
  }

  function updateDraftModel(role: ByokModelRole, value: string) {
    setDraftModels((prev) => ({ ...prev, [role]: value }));
  }

  // Trim draft models down to the active provider's real input slots,
  // dropping blanks. Shared by save + the disabled-state checks.
  function collectDraftModels(): ByokConnectionModels {
    const models: ByokConnectionModels = {};
    for (const role of byokModelInputRoles(activeMeta)) {
      const value = draftModels[role]?.trim();
      if (value) models[role] = value;
    }
    return models;
  }

  async function saveProvider() {
    if (!invokeCommand) {
      setSecretFeedback({ text: copy.unavailable, tone: "error" });
      return;
    }
    const hasNewKey = draftKey.trim().length > 0;
    if (activeMeta.requiresEndpoint && !draftEndpoint.trim()) {
      setSecretFeedback({ text: copy.endpointRequired, tone: "error" });
      return;
    }
    const models = collectDraftModels();
    const hasAnyModel = (visibleRoles ?? byokModelInputRoles(activeMeta)).some((role) => Boolean(models[role]));
    if (activeMeta.requiresModelId && !hasAnyModel) {
      setSecretFeedback({ text: copy.modelIdRequired, tone: "error" });
      return;
    }
    setSecretFeedback(null);
    if (!hasNewKey && !activeProviderHasSecret) {
      setSecretFeedback({ text: copy.keyRequired, tone: "error" });
      return;
    }

    const endpoint = draftEndpoint.trim() || activeMeta.defaultEndpoint || "";
    const requestProvider = draftProvider;
    const execution = await runProviderSaveSingleFlight(savePendingRef, async () => {
      setSavingProvider(true);
      const request = saveRequestGate.begin(requestProvider);
      try {
        const result = await saveProviderConnectionTransaction({
          providerId: requestProvider,
          apiKey: draftKey,
          hadSecret: activeProviderHasSecret,
          invoke: invokeCommand,
          saveConnection: () => pushConnectionMetaToServer(requestProvider, { endpoint, models }),
        });
        return { request, result };
      } finally {
        setSavingProvider(false);
      }
    });
    if (!execution.started) return;

    const { request, result } = execution.value;
    const requestIsCurrent = saveRequestGate.isCurrent(request, activeProviderRef.current);
    if (result.status === "failed") {
      if (requestIsCurrent) {
        setSecretFeedback({ text: copy.saveFailed, tone: "error" });
      }
      return;
    }
    if (result.status === "partial") {
      markProviderSecretStatus(requestProvider, true);
      if (requestIsCurrent) {
        setDraftKey("");
        setSecretFeedback({ text: copy.savePartial, tone: "error" });
      }
      return;
    }

    if (hasNewKey) markProviderSecretStatus(requestProvider, true);

    setConnections((current) => ({
      ...current,
      [requestProvider]: {
        ...result.connection,
        capabilities: activeMeta.capabilities,
        hasSecret: activeProviderHasSecret || hasNewKey,
      },
    }));
    invalidateBootstrapSnapshot();
    if (requestIsCurrent) {
      setDraftKey("");
      setSecretFeedback({ text: copy.savedOk, tone: "success" });
    }
  }

  async function removeProvider(providerId: string): Promise<boolean> {
    const result = await removeProviderCredentials({ providerId, invoke: invokeCommand });
    if (!result.ok) {
      if (result.secretRemoved) markProviderSecretStatus(providerId, false);
      setSecretFeedback({ text: copy.removeFailed, tone: "error" });
      return false;
    }
    markProviderSecretStatus(providerId, false);
    const next = { ...connections };
    delete next[providerId];
    setConnections(next);
    invalidateBootstrapSnapshot();
    if (providerId === draftProvider) {
      setDraftKey("");
      const meta = providerMeta(providerId);
      setDraftEndpoint(meta.defaultEndpoint || "");
      // Reset to empty — the placeholder hints at the expected shape.
      setDraftModels({});
      setTestState(null);
    }
    return true;
  }

  async function testConnection() {
    if (testPhase !== "idle") return;
    if (!invokeCommand) {
      setSecretFeedback({ text: copy.unavailable, tone: "error" });
      return;
    }
    const requestProvider = draftProvider;
    const requestEndpoint = draftEndpoint.trim() || undefined;
    const requestApiKey = draftKey.trim() || undefined;
    const request = testRequestGate.begin(requestProvider);
    setTestPhase("testing");
    setTestState(null);
    try {
      const response = await fetch("/api/desktop-runtime/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: requestProvider,
          endpoint: requestEndpoint,
          apiKey: requestApiKey,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        latency_ms?: number;
        error?: string;
      };
      if (testRequestGate.isCurrent(request, activeProviderRef.current)) {
        setTestState({
          ok: Boolean(data.ok),
          ms: typeof data.latency_ms === "number" ? data.latency_ms : undefined,
          error: data.error,
        });
      }
    } catch (err) {
      if (testRequestGate.isCurrent(request, activeProviderRef.current)) {
        setTestState({
          ok: false,
          error: err instanceof Error ? err.message : "request failed",
        });
      }
    } finally {
      if (!testRequestGate.isCurrent(request, activeProviderRef.current)) return;
      setTestPhase("cooldown");
      if (testCooldownTimerRef.current !== null) {
        window.clearTimeout(testCooldownTimerRef.current);
      }
      testCooldownTimerRef.current = window.setTimeout(() => {
        testCooldownTimerRef.current = null;
        setTestPhase("idle");
      }, TEST_COOLDOWN_MS);
    }
  }

  async function openProfileFolder() {
    if (!status || openingProfileFolder) return;
    setOpeningProfileFolder(true);
    setProfileFeedback(null);
    try {
      const response = await fetch("/api/desktop-runtime/open-profile-folder", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setProfileFeedback({ text: copy.openProfileFolderOk, tone: "success" });
    } catch {
      setProfileFeedback({ text: copy.openProfileFolderFailed, tone: "error" });
    } finally {
      setOpeningProfileFolder(false);
    }
  }

  const hardwareLine = hardware
    ? `${hardware.arch} · ${hardware.ram_gb} GB RAM · ${hardware.disk_available_gb} GB free`
    : null;

  const testFeedback: ProviderFeedback | null = testPhase === "testing"
    ? { text: copy.testing, tone: "muted" }
    : testState?.ok
      ? { text: copy.testOk.replace("{ms}", String(testState.ms ?? 0)), tone: "success" }
      : testState
        ? { text: copy.testFail.replace("{reason}", testState.error || "unknown"), tone: "error" }
        : null;

  // One consolidated feedback line: explicit save/validation feedback wins,
  // then the latest test-connection outcome. Tone drives the text colour so
  // errors are visually distinct from success/status (UX rule: error states
  // must not look like neutral copy).
  const feedback = secretFeedback ?? testFeedback;
  const unavailable = bridgePhase === "unavailable";
  const bridgeBlockedReason = desktopBridgeDisabledReason(bridgePhase, {
    checking: copy.bridgeChecking,
    unavailable: copy.unavailable,
  });

  // Why Save is disabled — surfaced as a tooltip so the inert button explains
  // itself instead of just greying out.
  const saveDisabledReason = bridgeBlockedReason
    ?? (activeMeta.requiresEndpoint && !draftEndpoint.trim()
      ? copy.endpointRequired
      : activeMeta.requiresModelId && !(visibleRoles ?? byokModelInputRoles(activeMeta)).some((role) => Boolean(collectDraftModels()[role]))
        ? copy.modelIdRequired
        : !draftKey.trim() && !activeProviderHasSecret
          ? copy.keyRequired
          : undefined);
  const testDisabledReason = bridgeBlockedReason
    ?? (!draftEndpointReady
      ? copy.endpointRequired
      : !draftKey.trim() && !activeProviderHasSecret
        ? copy.keyRequired
        : undefined);

  return (
    <SurfaceCard className="space-y-5">
      <div className="min-w-0">
        <ProviderConnectionsPanel
          providers={providers}
          activeMeta={activeMeta}
          draftProvider={draftProvider}
          draftEndpoint={draftEndpoint}
          draftModels={draftModels}
          draftKey={draftKey}
          connections={connections}
          activeProviderHasSecret={activeProviderHasSecret}
          bridgePhase={bridgePhase}
          unavailable={unavailable}
          feedback={feedback}
          testing={testPhase === "testing"}
          testCooldown={testPhase === "cooldown"}
          saving={savingProvider}
          canTestConnection={canTestConnection}
          invokeCommand={invokeCommand}
          saveDisabledReason={saveDisabledReason}
          testDisabledReason={testDisabledReason}
          copy={copy}
          visibleRoles={visibleRoles}
          onSelectProvider={selectProvider}
          onDraftEndpointChange={setDraftEndpoint}
          onDraftModelChange={updateDraftModel}
          onDraftKeyChange={setDraftKey}
          onRemoveProvider={removeProvider}
          onTestConnection={() => void testConnection()}
          onSaveProvider={() => void saveProvider()}
        />

      </div>

      <AdvancedDisclosure title={copy.systemDetailsTitle}>
        {hardwareLine ? (
          <p className="text-xs text-(--text-muted)">{hardwareLine}</p>
        ) : null}
        <RuntimePanels
          status={status}
          bridgePhase={bridgePhase}
          unavailable={unavailable}
          runtimeProbes={runtimeProbes}
          copy={copy}
          profileFeedback={profileFeedback}
          openingProfileFolder={openingProfileFolder}
          onOpenProfileFolder={() => void openProfileFolder()}
        />
      </AdvancedDisclosure>

    </SurfaceCard>
  );
}
