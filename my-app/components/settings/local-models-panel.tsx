"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  fetchDesktopHardware,
  fetchLlamaStatus,
  fetchRuntimeProbe,
  useDesktopAccel,
  useDesktopAvailable,
  useDesktopLocalRuntimes,
} from "@/hooks/use-desktop-available";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SurfaceCard } from "@/components/ui/page-primitives";
import { AdvancedDisclosure } from "@/components/ui/advanced-disclosure";
import { Download, KeyRound, RefreshCw, Search } from "@/components/ui/icons";
import { useCreativeCapabilityReadiness } from "@/hooks/use-creative-capability-readiness";
import { useI18n } from "@/lib/i18n/provider";
import { readResponseError } from "@/lib/client/fetch-json";
import { invalidateBootstrapSnapshot } from "@/lib/client/use-bootstrap-snapshot";
import { cn } from "@/lib/utils";
import {
  HF_MODEL_CATALOG,
  type HfModelEntry,
  type ModelCapability,
} from "@/lib/hf-model-catalog";
import type { HardwareInfo } from "@/lib/desktop-runtime";
import { PUBLIC_SITE_DOWNLOAD_URL } from "@/lib/public-site";
import { COPY } from "./local-models/copy";
import type {
  ExternalRuntimeModel,
  HubModelEntry,
  InstallStatusMap,
  QueueEntry,
  RuntimeTargetOption,
  StatusFilter,
} from "./local-models/types";
import {
  buildRuntimeInstallList,
  CATEGORY_TABS,
  EXTERNAL_RUNTIMES,
  fetchInstallStatuses,
  importedStatusToEntry,
  isAccelMatch,
  isHardwareFit,
  normalizeQueueStatus,
  readStoredExternalRuntimes,
  searchText,
  selectQuickStartImageModels,
  STATUS_FILTERS,
  writeStoredExternalRuntimes,
} from "./local-models/catalog-utils";
import { HardwareStatusBar } from "./local-models/hardware-status-bar";
import { ImportAndRuntimePanel } from "./local-models/import-and-runtime-panel";
import { InstallQueuePanel } from "./local-models/install-queue-panel";
import { ModelRow } from "./local-models/model-row";

export function LocalModelsPanel({ capability = "image" }: { capability?: "text" | "image" }) {
  const { locale } = useI18n();
  const detailsLocale = locale === "en" ? "en" : locale === "zh-TW" ? "zhTW" : "zh";
  const copy = COPY[detailsLocale];
  const readiness = useCreativeCapabilityReadiness();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const available = useDesktopAvailable();
  const runtimes = useDesktopLocalRuntimes();
  const accel = useDesktopAccel();
  const panelRef = useRef<HTMLElement | null>(null);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [diskGb, setDiskGb] = useState(0);
  const [query, setQuery] = useState("");
  const allowedCategories = useMemo<ModelCapability[]>(
    () => capability === "text" ? ["planner-llm"] : ["image-gen"],
    [capability],
  );
  const [category, setCategory] = useState<ModelCapability>(
    capability === "text" ? "planner-llm" : "image-gen",
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [installStatuses, setInstallStatuses] = useState<InstallStatusMap>({});
  const [activeLlamaPath, setActiveLlamaPath] = useState<string | null>(null);
  const [queueEntries, setQueueEntries] = useState<Record<string, QueueEntry>>({});
  const [externalRuntimes, setExternalRuntimes] = useState<ExternalRuntimeModel[]>([]);
  const [runtimeTarget, setRuntimeTarget] = useState<RuntimeTargetOption>("llama-cpp");
  const [hfUrl, setHfUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [importStatus, setImportStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const panelMountedRef = useRef(true);
  const watchedImportJobsRef = useRef(new Set<string>());

  useEffect(() => () => {
    panelMountedRef.current = false;
    watchedImportJobsRef.current.clear();
  }, []);

  const refreshLocalState = useCallback(async () => {
    const [statuses, llama] = await Promise.all([
      fetchInstallStatuses(),
      fetchLlamaStatus(),
    ]);
    if (!panelMountedRef.current) return;
    setInstallStatuses(statuses);
    if (llama) {
      setActiveLlamaPath(llama.running ? llama.modelPath : null);
    }
  }, []);

  const handleQueueChange = useCallback((entry: QueueEntry) => {
    if (!panelMountedRef.current) return;
    setQueueEntries((current) => ({ ...current, [entry.id]: entry }));
  }, []);

  const watchImportJob = useCallback((jobId: string, label: string) => {
    if (!panelMountedRef.current || watchedImportJobsRef.current.has(jobId)) return;
    watchedImportJobsRef.current.add(jobId);
    void (async () => {
      const POLL_MS = 1500;
      // Give up only on a sustained STALL (no byte progress AND/OR an
      // unreachable bridge for ~3 min), never on a fixed clock — a multi-GB
      // model legitimately downloads for a long time, so a hard time cap would
      // wrongly kill healthy long downloads. MAX_POLLS is just a runaway
      // backstop (~4h) so the watcher can never spin forever.
      const STALL_LIMIT = 120;
      const MAX_POLLS = 9600;
      let lastReceived = -1;
      let stall = 0;
      try {
        for (let i = 0; i < MAX_POLLS; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (!panelMountedRef.current || !watchedImportJobsRef.current.has(jobId)) return;
          // Each iteration counts as progress only when bytes actually advanced;
          // anything else (HTTP failure, no new bytes, unreachable bridge) spends
          // one unit of the stall budget. The terminal path `return`s, so reaching
          // the fallback below always means the loop stalled or exhausted MAX_POLLS.
          let madeProgress = false;
          try {
            const response = await fetch(`/api/desktop-runtime/hf-download/${encodeURIComponent(jobId)}`, {
              cache: "no-store",
            });
            if (response.ok) {
              const status = (await response.json()) as {
                status: string;
                received: number;
                total: number;
                error: string | null;
              };
              if (!panelMountedRef.current || !watchedImportJobsRef.current.has(jobId)) return;
              handleQueueChange({
                id: jobId,
                label,
                status: normalizeQueueStatus(status.status),
                percent: status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : null,
                fileIndex: 0,
                fileCount: 1,
                speedBps: 0,
                error: status.error,
              });
              if (status.status === "ready" || status.status === "error" || status.status === "canceled") {
                await refreshLocalState();
                return;
              }
              if (status.received > lastReceived) {
                lastReceived = status.received;
                madeProgress = true;
              }
            }
          } catch {
            // Bridge unreachable — spend the stall budget, then surface a failure.
          }
          if (madeProgress) {
            stall = 0;
          } else if ((stall += 1) >= STALL_LIMIT) {
            break;
          }
        }
      } finally {
        watchedImportJobsRef.current.delete(jobId);
      }
      if (!panelMountedRef.current) return;
      // Loop ended without a terminal status (stalled or hit MAX_POLLS): flip the
      // entry to a clear failed state so it leaves the active queue (no more
      // perpetual spinner) and tell the user why. If the job is in fact still
      // alive server-side, the next status refresh re-attaches a watcher, so a
      // live download is never stranded by this fallback.
      handleQueueChange({
        id: jobId,
        label,
        status: "error",
        percent: null,
        fileIndex: 0,
        fileCount: 1,
        speedBps: 0,
        error: copy.importStalled,
      });
      setImportStatus({ tone: "error", text: copy.importStalled });
      await refreshLocalState();
    })();
  }, [copy.importStalled, handleQueueChange, refreshLocalState]);

  // Surface the server's specific reason (bad URL, unsupported host, path not
  // found) so the user can correct their input — not a bare "Import failed."
  // The `catch` in each handler stays as the transport-level fallback.
  const reportImportError = useCallback(
    async (response: Response) => {
      setImportStatus({ tone: "error", text: await readResponseError(response, copy.importError) });
    },
    [copy.importError],
  );

  const resumeImportedDownload = useCallback(async (entry: HubModelEntry) => {
    if (!entry.url || !entry.runtimeTarget) return;
    setImportStatus(null);
    try {
      const response = await fetch("/api/desktop-runtime/models/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "huggingface-url",
          url: entry.url,
          runtimeTarget: entry.runtimeTarget,
          label: entry.label,
        }),
        cache: "no-store",
      });
      if (!response.ok) {
        await reportImportError(response);
        return;
      }
      const result = (await response.json()) as { jobId?: string; fileName?: string };
      if (result.jobId) {
        const label = result.fileName ?? entry.label;
        handleQueueChange({
          id: result.jobId,
          label,
          status: "queued",
          percent: null,
          fileIndex: 0,
          fileCount: 1,
          speedBps: 0,
          error: null,
        });
        watchImportJob(result.jobId, label);
      }
      setImportStatus({ tone: "success", text: copy.importQueued });
      await refreshLocalState();
    } catch {
      setImportStatus({ tone: "error", text: copy.importError });
    }
  }, [copy.importError, copy.importQueued, handleQueueChange, refreshLocalState, reportImportError, watchImportJob]);

  const probeExternalRuntimes = useCallback(async () => {
    setProbing(true);
    try {
      const detected = (
        await Promise.all(
          EXTERNAL_RUNTIMES.map(async (runtime): Promise<ExternalRuntimeModel | null> => {
            const result = await fetchRuntimeProbe(runtime.endpoint);
            if (!result?.reachable || result.models.length === 0) return null;
            return {
              runtimeId: runtime.id,
              runtimeLabel: runtime.label,
              endpoint: runtime.endpoint,
              models: result.models,
              latencyMs: result.latency_ms,
            };
          }),
        )
      ).filter((item): item is ExternalRuntimeModel => item !== null);
      setExternalRuntimes(detected);
      writeStoredExternalRuntimes(detected);
    } finally {
      setProbing(false);
    }
  }, []);

  const importLocalPath = useCallback(async () => {
    const pathValue = localPath.trim();
    if (!pathValue) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const response = await fetch("/api/desktop-runtime/models/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "local-path", path: pathValue, runtimeTarget }),
        cache: "no-store",
      });
      if (!response.ok) {
        await reportImportError(response);
        return;
      }
      setImportStatus({ tone: "success", text: copy.importDone });
      setLocalPath("");
      await refreshLocalState();
    } catch {
      setImportStatus({ tone: "error", text: copy.importError });
    } finally {
      setImporting(false);
    }
  }, [copy.importDone, copy.importError, localPath, refreshLocalState, reportImportError, runtimeTarget]);

  const importHfUrl = useCallback(async () => {
    setImporting(true);
    setImportStatus(null);
    try {
      const response = await fetch("/api/desktop-runtime/models/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "huggingface-url", url: hfUrl.trim(), runtimeTarget }),
        cache: "no-store",
      });
      if (!response.ok) {
        await reportImportError(response);
        return;
      }
      const result = (await response.json()) as { jobId?: string; fileName?: string };
      if (result.jobId) {
        const label = result.fileName ?? hfUrl.trim();
        handleQueueChange({
          id: result.jobId,
          label,
          status: "queued",
          percent: null,
          fileIndex: 0,
          fileCount: 1,
          speedBps: 0,
          error: null,
        });
        watchImportJob(result.jobId, label);
      }
      setImportStatus({ tone: "success", text: copy.importQueued });
      setHfUrl("");
      await refreshLocalState();
    } catch {
      setImportStatus({ tone: "error", text: copy.importError });
    } finally {
      setImporting(false);
    }
  }, [copy.importError, copy.importQueued, handleQueueChange, hfUrl, refreshLocalState, reportImportError, runtimeTarget, watchImportJob]);

  // Fire-and-forget launcher for installed-but-not-running external runtimes.
  // After kicking the bridge we wait 1.5s and re-probe so the UX flips from
  // "Open App" → "Connected" without manual refresh.
  const launchExternalRuntime = useCallback(
    (appId: string) => {
      void (async () => {
        try {
          await fetch("/api/desktop-runtime/launch-external", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ appId }),
            cache: "no-store",
          });
        } catch {
          // Best-effort — UI stays at "Not running" until next probe.
        }
        setTimeout(() => {
          if (!panelMountedRef.current) return;
          void probeExternalRuntimes();
        }, 1500);
      })();
    },
    [probeExternalRuntimes],
  );

  const runtimeInstallList = useMemo(
    () => buildRuntimeInstallList(runtimes, externalRuntimes),
    [externalRuntimes, runtimes],
  );

  const openSettingsPanel = useCallback(
    (panel: "runtime-diagnostics" | "provider-connections") => {
      router.replace(`${pathname}?panel=${panel}`, { scroll: false });
    },
    [pathname, router],
  );

  const openDiagnostics = useCallback(() => {
    openSettingsPanel("runtime-diagnostics");
  }, [openSettingsPanel]);

  const openProviders = useCallback(() => {
    openSettingsPanel("provider-connections");
  }, [openSettingsPanel]);

  // Browser-only renders have no bridge to diagnose, so the standalone
  // website owns the download path.
  const openDownload = useCallback(() => {
    window.location.assign(PUBLIC_SITE_DOWNLOAD_URL);
  }, []);

  useEffect(() => {
    if (!available) return;
    let active = true;
    async function load() {
      const info = await fetchDesktopHardware();
      if (info && active) {
        setHw(info);
        setDiskGb(info.disk_available_gb);
      }
      if (active) await refreshLocalState();
    }
    void load();
    return () => {
      active = false;
    };
  }, [available, refreshLocalState]);

  useEffect(() => {
    const rehydrateTimer = window.setTimeout(() => {
      setExternalRuntimes(readStoredExternalRuntimes());
    }, 0);
    return () => window.clearTimeout(rehydrateTimer);
  }, []);

  useEffect(() => {
    for (const status of Object.values(installStatuses)) {
      if (
        status.imported &&
        status.source === "huggingface-url" &&
        !status.installed &&
        status.jobId
      ) {
        watchImportJob(status.jobId, status.label ?? status.fileName ?? status.id);
      }
    }
  }, [installStatuses, watchImportJob]);

  useEffect(() => {
    if (searchParams.get("panel") === "local-models" || window.location.hash === "#local-models") {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searchParams]);

  const hubEntries = useMemo<HubModelEntry[]>(() => {
    const importedEntries = Object.values(installStatuses)
      .map(importedStatusToEntry)
      .filter((entry): entry is HubModelEntry => entry !== null);
    const importedIds = new Set(importedEntries.map((entry) => entry.id));
    const merged: HubModelEntry[] = [
      ...(HF_MODEL_CATALOG as readonly HfModelEntry[]).filter((entry) => !importedIds.has(entry.id)),
      ...importedEntries,
    ];
    // Stable accel-aware sort within capability groups: entries that match the
    // detected accelerator float up without becoming defaults.
    return merged.sort((a, b) => {
      const aMatch = isAccelMatch(a, accel) ? 1 : 0;
      const bMatch = isAccelMatch(b, accel) ? 1 : 0;
      return bMatch - aMatch;
    });
  }, [accel, installStatuses]);

  // Flat result set, no stacked capability groups. A search spans every category
  // (so you never miss a model because the wrong tab is active); with no query we
  // scope to the active category tab.
  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return hubEntries.filter((entry) => {
      const installed = Boolean(installStatuses[entry.id]?.installed);
      const compatible = isHardwareFit(entry, hw);
      if (statusFilter === "recommended" && (!entry.recommended || !compatible)) return false;
      if (statusFilter === "installed" && !installed) return false;
      if (statusFilter === "compatible" && !compatible) return false;
      if (!allowedCategories.includes(entry.capability)) return false;
      if (q) return searchText(entry).includes(q);
      return entry.capability === category;
    });
  }, [allowedCategories, category, hubEntries, hw, installStatuses, query, statusFilter]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ModelCapability, number> = { "planner-llm": 0, "image-gen": 0, vision: 0 };
    for (const entry of hubEntries) counts[entry.capability] += 1;
    return counts;
  }, [hubEntries]);

  const installedCount = hubEntries.filter((entry) => {
    const status = installStatuses[entry.id];
    return status?.installed;
  }).length;
  const fitCount = hubEntries.filter((entry) => isHardwareFit(entry, hw)).length;
  const categoryFilterApplied = query.trim().length === 0;
  const runningLabel =
    hubEntries.find(
      (entry) =>
        entry.runtimeTarget === "llama-cpp" &&
        (entry.modelPath
          ? activeLlamaPath === entry.modelPath
          : Boolean(entry.fileName && activeLlamaPath?.endsWith(entry.fileName))),
    )?.label ?? null;

  // Beginner quick-start: the few image models that matter. Show what's
  // installed, else put the fastest small image path ahead of the flagship kit.
  // Never an invented default — the user still taps Install (NO-DEFAULT-MODEL holds).
  const quickStartModels = useMemo(() => {
    if (capability === "text") {
      return hubEntries
        .filter((entry) => entry.capability === "planner-llm" && isHardwareFit(entry, hw))
        .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))
        .slice(0, 2);
    }
    return selectQuickStartImageModels({
      entries: hubEntries,
      installStatuses,
      hw,
    });
  }, [capability, hubEntries, hw, installStatuses]);

  const renderModelRow = (entry: HubModelEntry) => (
    <ModelRow
      key={entry.id}
      entry={entry}
      hw={hw}
      diskGb={diskGb}
      installStatus={installStatuses[entry.id]}
      runtimes={runtimes}
      activeLlamaPath={activeLlamaPath}
      copy={copy}
      detailsLocale={detailsLocale}
      onStatusChange={refreshLocalState}
      onActivated={capability === "text" ? async (modelId) => {
        const response = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaultTextModel: `local:${modelId}` }),
        });
        if (!response.ok) throw new Error(await readResponseError(response, copy.activateFailed));
        invalidateBootstrapSnapshot();
      } : undefined}
      onQueueChange={handleQueueChange}
      onResumeImport={resumeImportedDownload}
      onOpenDiagnostics={openDiagnostics}
      importQueueEntry={entry.jobId ? queueEntries[entry.jobId] : undefined}
    />
  );

  if (available === false) {
    // Disconnected state: ONE clear next step. The bridge can't be diagnosed
    // from the web shell, so we lead with capability ("run models on your
    // computer") and a single accent CTA to get the desktop app, with a
    // clearly-secondary cloud-key path. Health detail lives in the Status tab —
    // we don't re-render status cards here (single source of truth).
    return (
      <section id="local-models" ref={panelRef} className="scroll-mt-24 space-y-5">
        <SurfaceCard>
          <div className="mx-auto flex max-w-md flex-col items-center gap-5 px-2 py-8 text-center sm:py-12">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-(--accent-primary)">
              <Download className="h-5 w-5" />
            </span>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-(--text-primary)">
                {copy.runtimeUnavailableTitle}
              </h2>
              <p className="text-sm leading-6 text-(--text-secondary)">
                {copy.runtimeUnavailableDescription}
              </p>
            </div>
            <div className="flex w-full flex-col items-center gap-2.5 sm:w-auto sm:flex-row">
              <Button
                type="button"
                variant="accent"
                className="w-full sm:w-auto"
                onClick={openDownload}
              >
                <Download className="h-4 w-4" />
                {copy.runtimeUnavailablePrimaryAction}
              </Button>
              <Button
                type="button"
                variant="ghostMuted"
                className="w-full sm:w-auto"
                onClick={openProviders}
              >
                <KeyRound className="h-4 w-4" />
                {copy.runtimeUnavailableProviderAction}
              </Button>
            </div>
            <p className="text-xs leading-5 text-(--text-muted)">
              {copy.runtimeUnavailableCloudHint}
            </p>
            <p className="text-xs leading-4 text-(--text-muted)">
              {copy.runtimeUnavailableEngineNote}
            </p>
          </div>
        </SurfaceCard>
      </section>
    );
  }

  return (
    <section id="local-models" ref={panelRef} className="scroll-mt-24">
      <SurfaceCard className="space-y-4">
        {/* Quick start — the one thing a beginner needs: an image model. */}
        <div className="space-y-2.5">
          <h2 className="text-sm font-semibold text-(--text-primary)">{copy.quickStartTitle}</h2>
          {quickStartModels.length > 0 ? (
            <div className="divide-y divide-(--border-subtle)">{quickStartModels.map(renderModelRow)}</div>
          ) : (
            <p className="rounded-lg border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4 text-xs text-(--text-muted)">
              {copy.noResults}
            </p>
          )}
        </div>

        {/* Only shows while something is downloading. */}
        <InstallQueuePanel queue={Object.values(queueEntries)} copy={copy} />

        {/* Everything power-user: hardware, search, all categories, import,
            connected runtimes. Collapsed by default. */}
        <AdvancedDisclosure title={copy.advancedTitle}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <HardwareStatusBar accel={accel} hw={hw} copy={copy} />
            </div>
            <Button type="button" size="sm" variant="ghostMuted" className="shrink-0" onClick={() => void refreshLocalState()}>
              <RefreshCw className="h-3 w-3" />
              {copy.actionRefresh}
            </Button>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            {[
              copy.summaryReady(installedCount),
              copy.summaryRunning(runningLabel),
              copy.summarySelected(readiness.byId.defaults.activeLabel ?? null),
              copy.summaryFit(fitCount),
            ].map((item) => (
              <div key={item} className="text-xs font-medium text-(--text-secondary)">
                {item}
              </div>
            ))}
          </div>

          <div className="space-y-2.5">
            {/* Primary category filter. Search intentionally overrides this filter. */}
            <div
              role="group"
              aria-label={copy.categoriesLabel}
              className="flex flex-wrap items-center gap-1.5"
            >
              {CATEGORY_TABS.filter((cap) => allowedCategories.includes(cap)).map((cap) => {
                const isActive = categoryFilterApplied && category === cap;
                return (
                  <Button
                    key={cap}
                    type="button"
                    aria-pressed={isActive}
                    size="chip"
                    variant={isActive ? "selected" : "ghostMuted"}
                    onClick={() => {
                      setQuery("");
                      setCategory(cap);
                    }}
                    className={cn("gap-1.5", isActive && "shadow-(--shadow-sm)")}
                  >
                    {copy.filters[cap]}
                    <span className="text-(--text-muted)">{categoryCounts[cap]}</span>
                  </Button>
                );
              })}
            </div>

            {/* Search (spans all categories) + status refinements within the active tab. */}
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-muted)" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy.searchPlaceholder}
                  className="pl-9"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_FILTERS.map((item) => (
                  <Button
                    key={item}
                    type="button"
                    size="chip"
                    variant={statusFilter === item ? "selected" : "ghostMuted"}
                    onClick={() => setStatusFilter(item)}
                  >
                    {copy.filters[item]}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {visibleEntries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-(--border-subtle) bg-(--bg-glass) p-4 text-xs text-(--text-muted)">
              {copy.noResults}
            </div>
          ) : (
            <div className="divide-y divide-(--border-subtle)">{visibleEntries.map(renderModelRow)}</div>
          )}

          <ImportAndRuntimePanel
            copy={copy}
            externalRuntimes={externalRuntimes}
            runtimeInstallList={runtimeInstallList}
            importStatus={importStatus}
            runtimeTarget={runtimeTarget}
            hfUrl={hfUrl}
            localPath={localPath}
            probing={probing}
            importing={importing}
            onRuntimeTargetChange={setRuntimeTarget}
            onHfUrlChange={setHfUrl}
            onLocalPathChange={setLocalPath}
            onImportPath={() => void importLocalPath()}
            onImportUrl={() => void importHfUrl()}
            onProbeRuntimes={() => void probeExternalRuntimes()}
            onLaunchRuntime={launchExternalRuntime}
          />
        </AdvancedDisclosure>
      </SurfaceCard>
    </section>
  );
}
