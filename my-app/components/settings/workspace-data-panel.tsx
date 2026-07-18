"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Download, RefreshCw, RotateCcw, Trash2 } from "@/components/ui/icons";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import { useT } from "@/lib/i18n/useT";

interface StorageBreakdown {
  activeBytes: number;
  trashBytes: number;
  modelsBytes: number;
  logsBytes: number;
  freeDiskBytes: number;
  quotaBytes: number;
}

interface ReconcileResult {
  supported: boolean;
  missingFiles: string[];
  orphanFiles: string[];
  orphansDeleted: number;
}

type PendingAction =
  | "backup"
  | "diagnostics"
  | "check-files"
  | "empty-trash"
  | "remove-loose-files"
  | "restore"
  | null;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function downloadJson(value: unknown, fileName: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function WorkspaceDataPanel() {
  const t = useT();
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const [storage, setStorage] = useState<StorageBreakdown | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [restoreBackup, setRestoreBackup] = useState<Record<string, unknown> | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [confirm, setConfirm] = useState<PendingAction>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const refreshStorage = useCallback(async () => {
    const response = await fetchJson<{ breakdown: StorageBreakdown }>("/api/storage/breakdown", { cache: "no-store" });
    setStorage(response.breakdown);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshStorage().catch((error) => {
        setFeedback({ tone: "error", text: toErrorMessage(error, t("settings.data.loadFailed")) });
      });
    });
  }, [refreshStorage, t]);

  async function runAction(action: Exclude<PendingAction, null>, work: () => Promise<void>) {
    setPending(action);
    setFeedback(null);
    try {
      await work();
    } catch (error) {
      setFeedback({ tone: "error", text: toErrorMessage(error, t("settings.data.actionFailed")) });
    } finally {
      setPending(null);
      setConfirm(null);
    }
  }

  async function handleBackup() {
    await runAction("backup", async () => {
      const backup = await fetchJson<Record<string, unknown>>("/api/workspace/backup", { cache: "no-store" });
      downloadJson(backup, `lunery-workspace-${new Date().toISOString().slice(0, 10)}.json`);
      setFeedback({ tone: "success", text: t("settings.data.backupReady") });
    });
  }

  async function handleDiagnostics() {
    await runAction("diagnostics", async () => {
      const diagnostics = await fetchJson<Record<string, unknown>>("/api/diagnostics", { cache: "no-store" });
      downloadJson(diagnostics, "lunery-diagnostics.json");
      setFeedback({ tone: "success", text: t("settings.data.diagnosticsReady") });
    });
  }

  async function handleRestoreFile(file: File | undefined) {
    if (!file) return;
    setFeedback(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid backup");
      setRestoreBackup(parsed as Record<string, unknown>);
      setConfirm("restore");
    } catch {
      setRestoreBackup(null);
      setFeedback({ tone: "error", text: t("settings.data.invalidBackup") });
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  }

  async function handleRestore() {
    if (!restoreBackup) return;
    await runAction("restore", async () => {
      await fetchJson("/api/workspace/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: restoreBackup, confirm: true }),
      });
      window.location.assign("/settings?panel=general");
    });
  }

  async function handleEmptyTrash() {
    await runAction("empty-trash", async () => {
      await fetchJson("/api/assets/trash", { method: "DELETE" });
      await refreshStorage();
      setFeedback({ tone: "success", text: t("settings.data.trashEmptied") });
    });
  }

  async function handleCheckFiles() {
    await runAction("check-files", async () => {
      const response = await fetchJson<{ reconcile: ReconcileResult }>("/api/storage/reconcile", { cache: "no-store" });
      setReconcile(response.reconcile);
    });
  }

  async function handleRemoveLooseFiles() {
    await runAction("remove-loose-files", async () => {
      const response = await fetchJson<{ reconcile: ReconcileResult }>("/api/storage/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteOrphans: true }),
      });
      setReconcile(response.reconcile);
      await refreshStorage();
      setFeedback({ tone: "success", text: t("settings.data.looseFilesRemoved", { count: response.reconcile.orphansDeleted }) });
    });
  }

  const metrics = storage ? [
    ["active", storage.activeBytes],
    ["trash", storage.trashBytes],
    ["models", storage.modelsBytes],
    ["logs", storage.logsBytes],
    ["free", storage.freeDiskBytes],
  ] as const : [];

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>{t("settings.data.title")}</CardTitle>
        <CardDescription>{t("settings.data.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {feedback ? (
          <Alert variant={feedback.tone === "error" ? "destructive" : "default"}>
            <AlertDescription>{feedback.text}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {metrics.map(([key, bytes]) => (
            <div key={key}>
              <p className="text-xs text-(--text-muted)">{t(`settings.data.storage.${key}`)}</p>
              <p className="mt-1 text-sm font-semibold text-(--text-primary)">{formatBytes(bytes)}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-(--text-muted)">{t("settings.data.trashNote")}</p>

        <div className="divide-y divide-(--border-subtle)">
          <div className="space-y-2 py-4">
            <p className="text-xs font-semibold text-(--text-secondary)">{t("settings.data.spaceTitle")}</p>
            <p className="text-xs text-(--text-muted)">{t("settings.data.spaceDescription")}</p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!storage?.trashBytes}
              onClick={() => setConfirm("empty-trash")}
            >
              <Trash2 className="h-4 w-4" />
              {t("settings.data.emptyTrash")}
            </Button>
          </div>

          <div className="space-y-2 py-4">
            <p className="text-xs font-semibold text-(--text-secondary)">{t("settings.data.backupTitle")}</p>
            <p className="text-xs text-(--text-muted)">{t("settings.data.backupDescription")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" loading={pending === "backup"} onClick={() => void handleBackup()}>
                <Download className="h-4 w-4" />
                {t("settings.data.backup")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={pending !== null} onClick={() => restoreInputRef.current?.click()}>
                <RotateCcw className="h-4 w-4" />
                {t("settings.data.restore")}
              </Button>
              <input
                ref={restoreInputRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => void handleRestoreFile(event.target.files?.[0])}
              />
            </div>
          </div>

          <div className="space-y-2 py-4">
            <p className="text-xs font-semibold text-(--text-secondary)">{t("settings.data.healthTitle")}</p>
            <p className="text-xs text-(--text-muted)">{t("settings.data.healthDescription")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" loading={pending === "check-files"} onClick={() => void handleCheckFiles()}>
                <RefreshCw className="h-4 w-4" />
                {t("settings.data.checkFiles")}
              </Button>
              <Button type="button" variant="outline" size="sm" loading={pending === "diagnostics"} onClick={() => void handleDiagnostics()}>
                <Download className="h-4 w-4" />
                {t("settings.data.diagnostics")}
              </Button>
            </div>
            {reconcile ? (
              <div className="space-y-2 text-xs text-(--text-muted)">
                <p>{t("settings.data.fileCheckResult", { missing: reconcile.missingFiles.length, loose: reconcile.orphanFiles.length })}</p>
                {reconcile.orphanFiles.length > 0 ? (
                  <Button type="button" variant="destructive" size="sm" onClick={() => setConfirm("remove-loose-files")}>
                    {t("settings.data.removeLooseFiles")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>

      <ConfirmActionDialog
        open={confirm === "empty-trash"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("settings.data.emptyTrashTitle")}
        description={t("settings.data.emptyTrashDescription")}
        confirmLabel={t("settings.data.emptyTrash")}
        cancelLabel={t("common.cancel")}
        pending={pending === "empty-trash"}
        onConfirm={handleEmptyTrash}
      />
      <ConfirmActionDialog
        open={confirm === "remove-loose-files"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("settings.data.removeLooseFilesTitle")}
        description={t("settings.data.removeLooseFilesDescription")}
        confirmLabel={t("settings.data.removeLooseFiles")}
        cancelLabel={t("common.cancel")}
        pending={pending === "remove-loose-files"}
        onConfirm={handleRemoveLooseFiles}
      />
      <ConfirmActionDialog
        open={confirm === "restore"}
        onOpenChange={(open) => {
          if (!open && pending !== "restore") {
            setConfirm(null);
            setRestoreBackup(null);
          }
        }}
        title={t("settings.data.restoreTitle")}
        description={t("settings.data.restoreDescription")}
        confirmLabel={t("settings.data.restore")}
        cancelLabel={t("common.cancel")}
        pending={pending === "restore"}
        onConfirm={handleRestore}
      />
    </Card>
  );
}
