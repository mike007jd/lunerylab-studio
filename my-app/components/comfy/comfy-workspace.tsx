"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
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
  type ComfyConnectionState,
  type ComfyConnectionStatus,
  type ComfyTestResponse,
} from "@/lib/comfy-attach";
import { ComfyConnectionManagerDialog } from "@/components/comfy/comfy-connection-manager";
import { ComfyStartOutputDialog, ComfySyncDetailsDialog } from "@/components/comfy/comfy-dialogs";

interface StartOutput {
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

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
  const [canvasReloadKey, setCanvasReloadKey] = useState(0);

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

  const handleActivate = useCallback(
    async (id: string) => {
      setActionError(null);
      try {
        await fetchJson("/api/comfy/connections/activate", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        await refreshState();
        setCanvasReloadKey((key) => key + 1);
      } catch (error) {
        setActionError(toErrorMessage(error, t("comfy.activateFailed")));
      }
    },
    [refreshState, t],
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
      // The remote service needs a moment before /system_stats answers.
      const startedConnection = activeConnection;
      window.setTimeout(() => {
        void testConnection(startedConnection.id, { quiet: false }).then(() => {
          setCanvasReloadKey((key) => key + 1);
        });
      }, 1500);
    } catch (error) {
      setActionError(toErrorMessage(error, t("comfy.startFailed")));
    } finally {
      setStarting(false);
    }
  }, [activeConnection, testConnection, t]);

  const statusBadgeVariant =
    displayStatus === "online"
      ? "successSoft"
      : displayStatus === "offline"
        ? "destructive"
        : "secondary";
  const statusLabel = t(`comfy.status.${displayStatus}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {state.connections.length > 0 ? (
          <Select
            value={activeConnection?.id ?? ""}
            onValueChange={handleActivate}
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
              onClick={handleStart}
              disabled={starting || testing}
            >
              <Play />
              {starting ? t("comfy.starting") : t("comfy.start")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="accent"
            onClick={() => activeConnection && testConnection(activeConnection.id, { quiet: false })}
            disabled={!activeConnection || testing}
          >
            <Activity />
            {testing ? t("comfy.testing") : t("comfy.test")}
          </Button>
          <Button
            size="sm"
            variant="accent"
            onClick={handleSync}
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCanvasReloadKey((key) => key + 1)}
            disabled={!activeConnection}
            aria-label={t("comfy.reloadCanvas")}
          >
            <RotateCcw />
          </Button>
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
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-(--border-subtle) bg-(--bg-surface)">
          <iframe
            key={`${activeConnection.id}-${canvasReloadKey}`}
            src={activeConnection.endpoint}
            title={`${activeConnection.name} — ComfyUI`}
            className="absolute inset-0 h-full w-full border-0"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
          {displayStatus === "offline" ? (
            <div className="absolute inset-x-0 top-0 flex items-start justify-center p-3">
              <div className="rounded-lg border border-(--border-subtle) bg-(--bg-surface) px-4 py-2 text-sm text-(--text-secondary) shadow-(--shadow-sm)">
                {t("comfy.offlineOverlay")}
              </div>
            </div>
          ) : null}
        </div>
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
          onChanged={refreshState}
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
  );
}
