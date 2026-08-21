"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/useT";
import type { ComfyConnection } from "@/lib/comfy-attach";

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${mib.toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

function SystemRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-(--text-secondary)">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export function ComfySyncDetailsDialog({
  open,
  onOpenChange,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ComfyConnection;
}) {
  const t = useT();
  const snapshot = connection.lastSync;
  if (!snapshot) return null;
  const system = snapshot.system;
  const vram = formatBytes(system.vramTotalBytes);
  const ram = formatBytes(system.ramTotalBytes);
  const device = system.deviceName
    ? [system.deviceName, system.deviceType ? `(${system.deviceType})` : undefined]
        .filter(Boolean)
        .join(" ")
    : undefined;
  const folders = Object.entries(snapshot.models).filter(
    ([, names]) => names && names.length > 0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-(--border-subtle) bg-(--bg-surface) text-(--text-primary)">
        <DialogHeader>
          <DialogTitle>{t("comfy.syncDetailsTitle")}</DialogTitle>
          <DialogDescription className="text-(--text-secondary)">
            {connection.name} · {connection.endpoint}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-1.5 rounded-xl border border-(--border-subtle) p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-(--text-secondary)">
              {t("comfy.systemSection")}
            </p>
            <SystemRow label="ComfyUI" value={system.comfyUiVersion} />
            <SystemRow label={t("comfy.device")} value={device} />
            <SystemRow label={t("comfy.vram")} value={vram} />
            <SystemRow label={t("comfy.ram")} value={ram} />
            <SystemRow label={t("comfy.python")} value={system.pythonVersion} />
            <SystemRow label={t("comfy.pytorch")} value={system.pytorchVersion} />
            <SystemRow label={t("comfy.syncedAt")} value={
              new Date(snapshot.at).toLocaleString()
            } />
          </section>

          <section className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-(--text-secondary)">
              {t("comfy.models")}
            </p>
            {folders.length === 0 ? (
              <p className="text-sm text-(--text-secondary)">{t("comfy.noModels")}</p>
            ) : (
              folders.map(([folder, names]) => (
                <details
                  key={folder}
                  className="rounded-xl border border-(--border-subtle) px-3 py-2"
                >
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                    {folder}
                    <Badge variant="secondary">
                      {t("comfy.modelCount", { count: String(names?.length ?? 0) })}
                    </Badge>
                  </summary>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-(--text-secondary)">
                    {names?.map((name) => <li key={name} className="break-all">{name}</li>)}
                  </ul>
                </details>
              ))
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface StartOutput {
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export function ComfyStartOutputDialog({
  output,
  onClose,
}: {
  output: StartOutput | null;
  onClose: () => void;
}) {
  const t = useT();
  if (!output) return null;
  return (
    <Dialog open={output !== null} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-lg border-(--border-subtle) bg-(--bg-surface) text-(--text-primary)">
        <DialogHeader>
          <DialogTitle>{t("comfy.startOutputTitle")}</DialogTitle>
          <DialogDescription className="text-(--text-secondary)">
            {output.ok
              ? t("comfy.startExited", { code: String(output.exitCode ?? 0) })
              : (output.error ?? t("comfy.startFailed"))}
          </DialogDescription>
        </DialogHeader>
        {output.stdout || output.stderr ? (
          <pre className="max-h-60 overflow-auto rounded-xl border border-(--border-subtle) bg-transparent p-3 text-xs whitespace-pre-wrap">
            {output.stdout}
            {output.stderr ? `\n${output.stderr}` : ""}
          </pre>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
