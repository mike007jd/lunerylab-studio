import { ChevronDown } from "@/components/ui/icons";
import { lunaClass } from "@/components/design-system/grammar/tokens";
import { cn } from "@/lib/utils";

/**
 * Progressive-disclosure section. Power-user and diagnostic controls live
 * here, collapsed by default, so the primary surface stays beginner-clean.
 * Native details/summary is keyboard-accessible, needs no client state, and
 * avoids a bare button element (ui-framework rule).
 *
 * Intentionally chrome-less (no border/background): it is always rendered
 * inside a SurfaceCard, so drawing its own card would create nested cards.
 * Separation comes from the summary row's hairline top divider instead.
 */
export function AdvancedDisclosure({
  title,
  defaultOpen = false,
  className,
  summaryClassName,
  children,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group border-t border-(--border-subtle)",
        className,
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center justify-between gap-2 py-2.5 text-xs font-semibold transition-colors hover:text-(--text-primary) [&::-webkit-details-marker]:hidden",
          lunaClass.secondaryText,
          summaryClassName,
        )}
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-(--motion-control) group-open:rotate-180",
            lunaClass.mutedText,
          )}
        />
      </summary>
      <div className="space-y-3 pb-1 pt-1">{children}</div>
    </details>
  );
}
