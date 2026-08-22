"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Workflow,
  X,
} from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SurfaceCard } from "@/components/ui/page-primitives";
import { useT } from "@/lib/i18n/useT";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import {
  type ComfyActivityJob,
  type ComfyConnectionState,
  type ComfyConnectionStatus,
  type ComfyTestResponse,
} from "@/lib/comfy-attach";
import { ComfyConnectionManagerDialog } from "@/components/comfy/comfy-connection-manager";
import { ComfyStartOutputDialog, ComfySyncDetailsDialog } from "@/components/comfy/comfy-dialogs";
import { ComfyAgentChat } from "@/components/comfy/comfy-agent-chat";

interface StartOutput {
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Console for the attached ComfyUI server. The graph itself lives in a
 * dedicated native window running the official ComfyUI frontend (reached
 * through the desktop bridge's loopback relay), so this page owns connections,
 * health, sync, remote start, and pushing Studio jobs onto the canvas.
 */
export function ComfyWorkspace({
  initialState,
}: {
  initialState: ComfyConnectionState;
}) {
  const t = useT();
  const [state, setState] = useState<ComfyConnectionState>(initialState);
  const [status, setStatus] = useState<ComfyConnectionStatus>("unknown");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [startOutput, setStartOutput] = useState<StartOutput | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  // The connection endpoint the native canvas window is actually attached to
  // (server truth), so the UI can detect and repair drift from the active
  // connection instead of trusting a mount-local flag.
  const [canvasEndpoint, setCanvasEndpoint] = useState<string | null>(null);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [activityJobs, setActivityJobs] = useState<ComfyActivityJob[]>([]);

  const activeConnection = useMemo(
    () =>
      state.connections.find(
        (connection) => connection.id === state.activeConnectionId,
      ) ?? state.connections[0],
    [state],
  );


  const refreshState = useCallback(async () => {
    try {
      const next = await fetchJson<ComfyConnectionState>("/api/comfy/connections", {
        cache: "no-store",
      });
      setState(next);
    } catch {
      // Keep the last known state; the next action will surface errors.
    }
  }, []);

  const testConnection = useCallback(
    async (
      connectionId: string,
      { quiet, signal }: { quiet: boolean; signal?: AbortSignal },
    ) => {
      if (!quiet) setTesting(true);
      try {
        const result = await fetchJson<ComfyTestResponse>("/api/comfy/connections/test", {
          method: "POST",
          body: JSON.stringify({ id: connectionId }),
          signal,
        });
        // A stale probe (connection switched, effect aborted) must not
        // overwrite the status of whatever is active now.
        if (signal?.aborted) return;
        if (result.ok) {
          setStatus("online");
          setStatusDetail(
            result.systemStats?.comfyUiVersion
              ? `v${result.systemStats.comfyUiVersion}`
              : "",
          );
          setActionError(null);
        } else {
          setStatus("offline");
          setStatusDetail("");
          if (!quiet) setActionError(result.error ?? t("comfy.status.offline"));
        }
      } catch (error) {
        if (signal?.aborted) return;
        setStatus("offline");
        setStatusDetail("");
        if (!quiet) setActionError(toErrorMessage(error, t("comfy.testFailed")));
      } finally {
        if (!quiet) setTesting(false);
      }
    },
    [t],
  );

  const activeConnectionId = activeConnection?.id;

  // Displayed status is derived, not reset from an effect: while a visible
  // test runs it shows "checking", with no connection it shows "unknown", and
  // the async probe result settles online/offline.
  const displayStatus: ComfyConnectionStatus = !activeConnectionId
    ? "unknown"
    : testing
      ? "checking"
      : status;
  const displayStatusDetail = displayStatus === "online" ? statusDetail : "";

  // Test the active connection on mount/switch, and keep watching in the
  // background so an idle-stopped remote ComfyUI flips the badge on its own.
  // Aborting the controller drops results from a connection that is no longer
  // active instead of letting them overwrite the new one's status.
  useEffect(() => {
    if (!activeConnectionId) return;
    const controller = new AbortController();
    // Kick the initial probe off the effect body (async boundary) so the
    // status transition is not a synchronous cascade render.
    const kickoff = window.setTimeout(() => {
      void testConnection(activeConnectionId, { quiet: false, signal: controller.signal });
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !controller.signal.aborted) {
        void testConnection(activeConnectionId, { quiet: true, signal: controller.signal });
      }
    }, 30_000);
    return () => {
      controller.abort();
      window.clearTimeout(kickoff);
      window.clearInterval(interval);
    };
  }, [activeConnectionId, testConnection]);

  // Poll the Studio-side activity feed while visible: a running job for the
  // active connection is what gets pushed onto the canvas window below.
  useEffect(() => {
    if (!activeConnectionId) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await fetchJson<{ jobs: ComfyActivityJob[] }>("/api/comfy/activity", {
          cache: "no-store",
        });
        if (!cancelled) setActivityJobs(result.jobs);
      } catch {
        // Transient poll failure — the next tick retries.
      }
    };
    void poll();
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeConnectionId]);

  const openCanvas = useCallback(
    async (reload = false) => {
      if (!activeConnection) return;
      setCanvasBusy(true);
      setActionError(null);
      try {
        await fetchJson("/api/comfy/canvas/open", {
          method: "POST",
          body: JSON.stringify({
            id: activeConnection.id,
            ...(reload ? { reload: true } : {}),
          }),
        });
        setCanvasOpen(true);
        setCanvasEndpoint(activeConnection.endpoint);
      } catch (error) {
        setActionError(toErrorMessage(error, t("comfy.canvasOpenFailed")));
      } finally {
        setCanvasBusy(false);
      }
    },
    [activeConnection, t],
  );

  const closeCanvas = useCallback(async () => {
    setCanvasBusy(true);
    setActionError(null);
    try {
      await fetchJson("/api/comfy/canvas/close", { method: "POST", body: "{}" });
      setCanvasOpen(false);
      setCanvasEndpoint(null);
    } catch (error) {
      setActionError(toErrorMessage(error, t("comfy.canvasCloseFailed")));
    } finally {
      setCanvasBusy(false);
    }
  }, [t]);

  // Reconcile UI state with the native canvas window's reality: hydrate the
  // open flag on mount (a fresh page load starts blind), notice a window the
  // user closed directly, and — the drift the review flagged — retarget the
  // window when it is attached to a different server than the active connection,
  // or close it when that server was deleted. Server truth (open + bound
  // endpoint) comes from /api/comfy/canvas/status.
  const reconcileCanvas = useCallback(async () => {
    let statusOpen = false;
    let statusEndpoint: string | null = null;
    try {
      const result = await fetchJson<{ open: boolean; endpoint: string | null }>(
        "/api/comfy/canvas/status",
        { cache: "no-store" },
      );
      statusOpen = result.open;
      statusEndpoint = result.endpoint;
    } catch {
      // Transient bridge hiccup — keep the last known state.
      return;
    }
    setCanvasOpen(statusOpen);
    setCanvasEndpoint(statusEndpoint);
    if (!statusOpen) return;
    // Read the authoritative connection list here (not component state, which may
    // lag a just-completed mutation) so a delete/edit is reflected immediately.
    let current: ComfyConnectionState;
    try {
      current = await fetchJson<ComfyConnectionState>("/api/comfy/connections", {
        cache: "no-store",
      });
    } catch {
      return;
    }
    const active =
      current.connections.find((connection) => connection.id === current.activeConnectionId) ??
      current.connections[0];
    if (!active) return;
    // Canvas is attached to a server that no longer exists → close it.
    if (
      statusEndpoint &&
      !current.connections.some((connection) => connection.endpoint === statusEndpoint)
    ) {
      await closeCanvas();
      return;
    }
    // Canvas drifted from the active connection → retarget it atomically.
    if (statusEndpoint !== active.endpoint) {
      try {
        await fetchJson("/api/comfy/canvas/open", {
          method: "POST",
          body: JSON.stringify({ id: active.id }),
        });
        setCanvasEndpoint(active.endpoint);
      } catch (error) {
        setActionError(toErrorMessage(error, t("comfy.canvasOpenFailed")));
      }
    }
  }, [closeCanvas, t]);

  // Hydrate on mount and poll slowly so a directly-closed window is noticed.
  // The initial kick is deferred off the effect body (async boundary) so the
  // status-driven setState is not a synchronous cascade render.
  useEffect(() => {
    const kickoff = window.setTimeout(() => {
      void reconcileCanvas();
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void reconcileCanvas();
    }, 5_000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(interval);
    };
  }, [reconcileCanvas]);

  const handleActivate = useCallback(
    async (id: string) => {
      setActionError(null);
      try {
        await fetchJson("/api/comfy/connections/activate", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        await refreshState();
        // An open canvas follows the newly activated server. Reconcile against
        // the window's real state rather than a mount-local flag, so activation
        // after a remount (flag still false) can't strand the canvas on the
        // previous server.
        await reconcileCanvas();
      } catch (error) {
        setActionError(toErrorMessage(error, t("comfy.activateFailed")));
      }
    },
    [refreshState, reconcileCanvas, t],
  );

  const handleSync = useCallback(async () => {
    if (!activeConnection) return;
    setSyncing(true);
    setActionError(null);
    try {
      const result = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/comfy/connections/sync",
        { method: "POST", body: JSON.stringify({ id: activeConnection.id }) },
      );
      if (!result.ok) {
        setActionError(result.error ?? t("comfy.syncFailed"));
      } else {
        await refreshState();
        setDetailsOpen(true);
      }
    } catch (error) {
      setActionError(toErrorMessage(error, t("comfy.syncFailed")));
    } finally {
      setSyncing(false);
    }
  }, [activeConnection, refreshState, t]);

  const handleStart = useCallback(async () => {
    if (!activeConnection) return;
    setStarting(true);
    setActionError(null);
    try {
      const result = await fetchJson<StartOutput>("/api/comfy/connections/start", {
        method: "POST",
        body: JSON.stringify({ id: activeConnection.id }),
      });
      setStartOutput(result);
      // The remote service needs a moment before /system_stats answers; an
      // open canvas must reconnect to the freshly started server.
      const startedConnection = activeConnection;
      window.setTimeout(() => {
        void testConnection(startedConnection.id, { quiet: false }).then(() => {
          if (canvasOpen) void openCanvas(true);
        });
      }, 1500);
    } catch (error) {
      setActionError(toErrorMessage(error, t("comfy.startFailed")));
    } finally {
      setStarting(false);
    }
  }, [activeConnection, testConnection, canvasOpen, openCanvas, t]);

  const activeEndpoint = activeConnection?.endpoint;
  const runningStudioJob = useMemo(
    () =>
      activityJobs.find(
        (job) => job.endpoint === activeEndpoint && job.status === "running",
      ),
    [activityJobs, activeEndpoint],
  );

  // Canvas follow: load the running Studio workflow into the official editor
  // in the canvas window so its native node highlighting shows execution live.
  // Each job is pushed once per connection epoch.
  const loadedJobsRef = useRef<{ connectionId: string; ids: Set<string> }>({
    connectionId: "",
    ids: new Set(),
  });
  useEffect(() => {
    loadedJobsRef.current = { connectionId: activeConnectionId ?? "", ids: new Set() };
  }, [activeConnectionId]);

  useEffect(() => {
    if (!canvasOpen || !activeConnectionId || !runningStudioJob) return;
    // Only push a job onto the canvas when the window is actually attached to the
    // active connection — otherwise a drifted canvas would load this server's
    // workflow onto a different machine.
    if (canvasEndpoint !== activeEndpoint) return;
    if (loadedJobsRef.current.connectionId !== activeConnectionId) {
      loadedJobsRef.current = { connectionId: activeConnectionId, ids: new Set() };
    }
    if (loadedJobsRef.current.ids.has(runningStudioJob.id)) return;
    loadedJobsRef.current.ids.add(runningStudioJob.id);
    void fetchJson("/api/comfy/canvas/load", {
      method: "POST",
      body: JSON.stringify({ workflow: runningStudioJob.workflow }),
    }).catch(() => setActionError(t("comfy.canvasLoadFailed")));
  }, [canvasOpen, canvasEndpoint, activeEndpoint, activeConnectionId, runningStudioJob, t]);

  const statusBadgeVariant =
    displayStatus === "online"
      ? "successSoft"
      : displayStatus === "offline"
        ? "destructive"
        : "secondary";
  const statusLabel = t(`comfy.status.${displayStatus}`);

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
        {state.connections.length > 0 ? (
          <Select
            value={activeConnection?.id ?? ""}
            onValueChange={(id) => void handleActivate(id)}
          >
            <SelectTrigger
              size="sm"
              className="w-64"
              aria-label={t("comfy.connectionLabel")}
            >
              <SelectValue placeholder={t("comfy.connectionLabel")} />
            </SelectTrigger>
            <SelectContent>
              {state.connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Badge variant={statusBadgeVariant}>
          {displayStatus === "checking" ? (
            <Activity className="animate-pulse" />
          ) : null}
          {statusLabel}
          {displayStatusDetail ? (
            <span className="opacity-70">· {displayStatusDetail}</span>
          ) : null}
        </Badge>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {activeConnection?.sshStart ? (
            <Button
              size="sm"
              variant="gold"
              onClick={() => void handleStart()}
              disabled={starting || testing}
            >
              <Play />
              {starting ? t("comfy.starting") : t("comfy.start")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="accent"
            onClick={() =>
              activeConnection && void testConnection(activeConnection.id, { quiet: false })
            }
            disabled={!activeConnection || testing}
          >
            <Activity />
            {testing ? t("comfy.testing") : t("comfy.test")}
          </Button>
          <Button
            size="sm"
            variant="accent"
            onClick={() => void handleSync()}
            disabled={!activeConnection || syncing}
          >
            <RefreshCw />
            {syncing ? t("comfy.syncing") : t("comfy.sync")}
          </Button>
          {activeConnection?.lastSync ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDetailsOpen(true)}
            >
              <Sparkles />
              {t("comfy.details")}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setManagerOpen(true)}>
            <Settings2 />
            {t("comfy.manage")}
          </Button>
        </div>
      </div>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {activeConnection ? (
        <SurfaceCard className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Workflow className="size-4 text-(--accent)" />
            <h2 className="text-sm font-semibold text-(--text-primary)">
              {t("comfy.canvasTitle")}
            </h2>
            <Badge variant={canvasOpen ? "successSoft" : "secondary"}>
              {canvasOpen ? t("comfy.canvasOpenBadge") : t("comfy.canvasClosedBadge")}
            </Badge>
            <div className="ml-auto flex items-center gap-2">
              {canvasOpen ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void openCanvas(true)}
                    disabled={canvasBusy}
                    aria-label={t("comfy.reloadCanvas")}
                  >
                    <RotateCcw />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void closeCanvas()}
                    disabled={canvasBusy}
                  >
                    <X />
                    {t("comfy.closeCanvas")}
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="accent"
                onClick={() => void openCanvas()}
                disabled={canvasBusy}
              >
                <ExternalLink />
                {canvasBusy
                  ? t("comfy.canvasWorking")
                  : canvasOpen
                    ? t("comfy.focusCanvas")
                    : t("comfy.openCanvas")}
              </Button>
            </div>
          </div>
          <p className="max-w-3xl text-sm text-(--text-secondary)">
            {t("comfy.canvasDescription", {
              name: activeConnection.name,
              endpoint: activeConnection.endpoint,
            })}
          </p>
          {displayStatus === "offline" ? (
            <p className="text-sm text-destructive">{t("comfy.canvasOfflineHint")}</p>
          ) : null}
        </SurfaceCard>
      ) : (
        <SurfaceCard className="flex flex-1 items-center justify-center">
          <div className="max-w-md text-center">
            <h2 className="text-lg font-semibold text-(--text-primary)">
              {t("comfy.noConnectionsTitle")}
            </h2>
            <p className="mt-2 text-sm text-(--text-secondary)">
              {t("comfy.noConnectionsDescription")}
            </p>
            <Button className="mt-4" onClick={() => setManagerOpen(true)}>
              {t("comfy.addConnection")}
            </Button>
          </div>
        </SurfaceCard>
      )}

      {managerOpen ? (
        <ComfyConnectionManagerDialog
          open={managerOpen}
          onOpenChange={setManagerOpen}
          state={state}
          onChanged={async () => {
            await refreshState();
            // An edited endpoint or a deleted connection must re-point or close
            // an open canvas rather than leave it on stale server state.
            await reconcileCanvas();
          }}
          onActivate={handleActivate}
        />
      ) : null}
      {activeConnection ? (
        <ComfySyncDetailsDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          connection={activeConnection}
        />
      ) : null}
      <ComfyStartOutputDialog
        output={startOutput}
        onClose={() => setStartOutput(null)}
      />
      </div>

      {activeConnection ? (
        <ComfyAgentChat connectionId={activeConnection.id} />
      ) : (
        <div className="hidden lg:block" />
      )}
    </div>
  );
}
