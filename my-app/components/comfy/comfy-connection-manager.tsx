"use client";

import { useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { useT } from "@/lib/i18n/useT";
import { fetchJson, toErrorMessage } from "@/lib/client/fetch-json";
import {
  type ComfyConnection,
  type ComfyConnectionState,
  type ComfyTestResponse,
} from "@/lib/comfy-attach";

type ManagerMode = "list" | "add" | "edit";

interface ConnectionForm {
  name: string;
  endpoint: string;
  sshEnabled: boolean;
  hostAlias: string;
  command: string;
}

const EMPTY_FORM: ConnectionForm = {
  name: "",
  endpoint: "",
  sshEnabled: false,
  hostAlias: "",
  command: "",
};

export function ComfyConnectionManagerDialog({
  open,
  onOpenChange,
  state,
  onChanged,
  onActivate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ComfyConnectionState;
  onChanged: () => void | Promise<void>;
  onActivate: (id: string) => void | Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<ManagerMode>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formTestResult, setFormTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ComfyConnection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // This dialog is mounted only while open, so fresh state per open replaces
  // any reset-on-open effect.

  const beginAdd = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormTestResult(null);
    setMode("add");
  };

  const beginEdit = (connection: ComfyConnection) => {
    setForm({
      name: connection.name,
      endpoint: connection.endpoint,
      sshEnabled: Boolean(connection.sshStart),
      hostAlias: connection.sshStart?.hostAlias ?? "",
      command: connection.sshStart?.command ?? "",
    });
    setFormError(null);
    setFormTestResult(null);
    setEditingId(connection.id);
    setMode("edit");
  };

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    try {
      await fetchJson("/api/comfy/connections", {
        method: "POST",
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          name: form.name.trim(),
          endpoint: form.endpoint.trim(),
          ...(form.sshEnabled && form.hostAlias.trim() && form.command.trim()
            ? {
                sshStart: {
                  hostAlias: form.hostAlias.trim(),
                  command: form.command.trim(),
                },
              }
            : {}),
        }),
      });
      await onChanged();
      setMode("list");
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (error) {
      setFormError(toErrorMessage(error, t("comfy.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleTestFormEndpoint = async () => {
    setTesting(true);
    setFormTestResult(null);
    try {
      const result = await fetchJson<ComfyTestResponse>("/api/comfy/connections/test", {
        method: "POST",
        body: JSON.stringify({ endpoint: form.endpoint.trim() }),
      });
      if (result.ok) {
        setFormTestResult(
          result.systemStats?.comfyUiVersion
            ? t("comfy.formTestOk", { version: result.systemStats.comfyUiVersion })
            : t("comfy.status.online"),
        );
      } else {
        setFormTestResult(result.error ?? t("comfy.status.offline"));
      }
    } catch (error) {
      setFormTestResult(toErrorMessage(error, t("comfy.testFailed")));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await fetchJson("/api/comfy/connections", {
        method: "DELETE",
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      setDeleteTarget(null);
      await onChanged();
    } catch (error) {
      setDeleteError(toErrorMessage(error, t("comfy.deleteFailed")));
    } finally {
      setDeleting(false);
    }
  };

  const canSave =
    form.name.trim().length > 0 &&
    /^https?:\/\//.test(form.endpoint.trim()) &&
    (!form.sshEnabled || (form.hostAlias.trim().length > 0 && form.command.trim().length > 0));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg border-(--border-subtle) bg-(--bg-surface) text-(--text-primary)">
          <DialogHeader>
            <DialogTitle>
              {mode === "list"
                ? t("comfy.managerTitle")
                : mode === "add"
                  ? t("comfy.addConnection")
                  : t("comfy.editConnection")}
            </DialogTitle>
            <DialogDescription className="text-(--text-secondary)">
              {t("comfy.managerDescription")}
            </DialogDescription>
          </DialogHeader>

          {mode === "list" ? (
            <div className="flex flex-col gap-2">
              {state.connections.length === 0 ? (
                <p className="text-sm text-(--text-secondary)">
                  {t("comfy.noConnectionsDescription")}
                </p>
              ) : (
                state.connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex items-center gap-3 rounded-xl border border-(--border-subtle) px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {connection.name}
                        </span>
                        {state.activeConnectionId === connection.id ? (
                          <Badge variant="gold">{t("comfy.activeConnection")}</Badge>
                        ) : null}
                        {connection.sshStart ? (
                          <Badge variant="outline">SSH</Badge>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-(--text-secondary)">
                        {connection.endpoint}
                      </p>
                    </div>
                    {state.activeConnectionId !== connection.id ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={t("comfy.activateConnection")}
                        onClick={() => onActivate(connection.id)}
                      >
                        <Check />
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t("comfy.editConnection")}
                      onClick={() => beginEdit(connection)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t("common.delete")}
                      onClick={() => setDeleteTarget(connection)}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </div>
                ))
              )}
              <Button variant="accent" size="sm" className="mt-2" onClick={beginAdd}>
                <Plus />
                {t("comfy.addConnection")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="block space-y-1.5 text-xs font-medium text-(--text-secondary)">
                {t("comfy.name")}
                <Input
                  value={form.name}
                  placeholder={t("comfy.namePlaceholder")}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
              </label>
              <div className="flex flex-col gap-2">
                <label className="block space-y-1.5 text-xs font-medium text-(--text-secondary)">
                  {t("comfy.endpoint")}
                  <Input
                    value={form.endpoint}
                    placeholder={t("comfy.endpointPlaceholder")}
                    inputMode="url"
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, endpoint: event.target.value }))
                    }
                  />
                </label>
                <p className="text-xs text-(--text-secondary)">{t("comfy.endpointHint")}</p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleTestFormEndpoint}
                    disabled={testing || !/^https?:\/\//.test(form.endpoint.trim())}
                  >
                    {testing ? t("comfy.testing") : t("comfy.testInForm")}
                  </Button>
                  {formTestResult ? (
                    <span className="text-xs text-(--text-secondary)">{formTestResult}</span>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-(--border-subtle) p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.sshEnabled}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, sshEnabled: event.target.checked }))
                    }
                  />
                  {t("comfy.sshSection")}
                </label>
                {form.sshEnabled ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <label className="block space-y-1.5 text-xs font-medium text-(--text-secondary)">
                      {t("comfy.hostAlias")}
                      <Input
                        value={form.hostAlias}
                        placeholder={t("comfy.hostAliasPlaceholder")}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, hostAlias: event.target.value }))
                        }
                      />
                    </label>
                    <label className="block space-y-1.5 text-xs font-medium text-(--text-secondary)">
                      {t("comfy.sshCommand")}
                      <Input
                        value={form.command}
                        placeholder={t("comfy.sshCommandPlaceholder")}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, command: event.target.value }))
                        }
                      />
                    </label>
                    <p className="text-xs text-(--text-secondary)">{t("comfy.sshHint")}</p>
                  </div>
                ) : null}
              </div>

              {formError ? (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setMode("list")}>
                  {t("common.back")}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!canSave || saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && deleting) return;
          if (!nextOpen) setDeleteTarget(null);
        }}
        title={t("comfy.deleteTitle")}
        description={t("comfy.deleteDescription", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={handleDelete}
        tone="destructive"
        pending={deleting}
        error={deleteError ?? undefined}
      />
    </>
  );
}
