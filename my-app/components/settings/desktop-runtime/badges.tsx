import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, Loader2 } from "@/components/ui/icons";

/**
 * `checking`, `unreachable`, and `missing` used to collapse into one muted
 * outline badge, so "still probing", "found but not answering", and "not
 * installed" were visually identical. The state is now typed and every state
 * carries its own icon + tone + label — restrained, but distinguishable.
 */
export type RuntimeBadgeState = "checking" | "ready" | "unreachable" | "missing";

export function RuntimeBadge({
  state,
  children,
}: {
  state: RuntimeBadgeState;
  children: ReactNode;
}) {
  switch (state) {
    case "ready":
      return (
        <Badge variant="successSoft" data-state={state}>
          <Check className="h-3 w-3" />
          {children}
        </Badge>
      );
    case "checking":
      return (
        <Badge variant="outline" className="text-(--text-muted)" data-state={state}>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {children}
        </Badge>
      );
    case "unreachable":
      return (
        <Badge
          variant="outline"
          className="border-(--destructive)/40 bg-(--destructive-soft) text-(--destructive)"
          data-state={state}
        >
          <AlertTriangle className="h-3 w-3" />
          {children}
        </Badge>
      );
    case "missing":
      return (
        <Badge
          variant="outline"
          className="border-(--warning-soft) bg-(--warning-soft) text-(--warning)"
          data-state={state}
        >
          <AlertTriangle className="h-3 w-3" />
          {children}
        </Badge>
      );
  }
}

export function PanelEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-(--border-subtle) bg-(--bg-glass) px-3 py-4">
      <p className="text-xs font-semibold text-(--text-primary)">{title}</p>
      <p className="mt-1 text-xs leading-5 text-(--text-muted)">{text}</p>
    </div>
  );
}
