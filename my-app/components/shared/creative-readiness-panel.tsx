"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, Loader2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import type {
  CreativeCapabilityReadiness,
  CreativeCapabilityStatus,
} from "@/lib/client/creative-capability-readiness";
import { cn } from "@/lib/utils";

function StatusIcon({ status }: { status: CreativeCapabilityStatus }) {
  if (status === "ready") return <Check className="h-4 w-4 text-(--success)" />;
  if (status === "checking" || status === "preparing") {
    return <Loader2 className="h-4 w-4 animate-spin text-(--warning)" />;
  }
  return <AlertTriangle className="h-4 w-4 text-(--warning)" />;
}

/**
 * Single-line readiness banner: status icon + one short reason + one action.
 * The per-capability breakdown intentionally lives in Settings, not here — a
 * beginner only needs the one next step, not a five-row capability matrix.
 */
export function CreativeReadinessPanel({
  readiness,
  className,
}: {
  readiness: CreativeCapabilityReadiness;
  className?: string;
}) {
  const primary = readiness.primaryIssue;
  const headline = primary?.reason ?? readiness.detail;
  const primaryAction =
    primary?.href && primary.actionLabel ? (
      <Button asChild type="button" size="sm" variant="accent" className="w-full sm:w-auto">
        <Link href={primary.href}>
          {primary.actionLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    ) : null;

  return (
    <div
      data-testid="creative-readiness-panel"
      data-status={readiness.overallStatus}
      className={cn(
        "relative z-20 flex flex-col gap-2.5 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3 shadow-(--shadow-sm) sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--bg-elevated)">
          <StatusIcon status={readiness.overallStatus} />
        </span>
        <p className="min-w-0 text-sm font-medium text-(--text-primary)">{headline}</p>
      </div>
      {primaryAction}
    </div>
  );
}
