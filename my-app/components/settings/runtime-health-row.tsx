"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The one runtime-health presentation row.
 *
 * Every local runtime — endpoint-probed (Ollama / LM Studio / ComfyUI) or
 * embedded (llama.cpp / sd.cpp / MLX) — renders through this row. Behaviour
 * differences are expressed as typed view data plus an optional action, never
 * as a second copy of the row chrome.
 */
export type RuntimeHealthState = "checking" | "ready" | "unreachable" | "pending";

export interface RuntimeHealthRowView {
  label: string;
  /** Endpoint, path, or a short status line — whatever identifies this runtime. */
  detail: string;
  state: RuntimeHealthState;
  statusLabel: string;
  /** One optional muted hint line (e.g. model count, install guidance). */
  note?: string;
}

const DOT_CLASS: Record<RuntimeHealthState, string> = {
  checking: "bg-(--border-subtle)",
  ready: "bg-(--success)",
  unreachable: "bg-(--destructive)",
  pending: "bg-(--warning)",
};

export function RuntimeHealthRow({
  view,
  action,
}: {
  view: RuntimeHealthRowView;
  action?: ReactNode;
}) {
  return (
    <div
      data-slot="runtime-health-row"
      data-state={view.state}
      className="flex flex-wrap items-start gap-3 px-1 py-2.5"
    >
      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", DOT_CLASS[view.state])} />

      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-(--text-primary)">{view.label}</p>
        <p className="truncate text-xs text-(--text-muted)">{view.detail}</p>
        {view.note ? (
          <p className="mt-0.5 text-xs text-(--text-muted)/80">{view.note}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {view.state === "ready" ? (
          <Badge variant="successSoft">{view.statusLabel}</Badge>
        ) : view.state === "pending" ? (
          <Badge variant="gold">{view.statusLabel}</Badge>
        ) : view.state === "unreachable" ? (
          <Badge
            variant="outline"
            className="border-(--destructive)/40 bg-(--destructive-soft) text-(--destructive)"
          >
            {view.statusLabel}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-(--text-muted)">
            {view.statusLabel}
          </Badge>
        )}
        {action}
      </div>
    </div>
  );
}

export function RuntimeHealthRowSkeleton() {
  return <Skeleton className="h-12" />;
}
