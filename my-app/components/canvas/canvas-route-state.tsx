"use client";

import { AlertTriangle, Loader2 } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export function CanvasRouteState({
  title,
  description,
  tone = "neutral",
  children,
}: {
  title: string;
  description: string;
  tone?: "neutral" | "danger";
  children?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-(--bg-base) p-6">
      <div className="w-full max-w-md rounded-(--radius-panel) border border-(--border-subtle) bg-(--bg-surface) p-6 text-center shadow-sm">
        <div
          className={cn(
            "mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full border",
            tone === "danger"
              ? "border-(--destructive)/30 bg-(--destructive)/10 text-(--destructive)"
              : "border-(--accent-primary)/25 bg-(--accent-primary)/10 text-(--accent-primary)",
          )}
          aria-hidden="true"
        >
          {tone === "danger" ? (
            <AlertTriangle className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
        </div>
        <h1 className="text-base font-semibold text-(--text-primary)">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-(--text-secondary)">{description}</p>
        {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
      </div>
    </div>
  );
}
