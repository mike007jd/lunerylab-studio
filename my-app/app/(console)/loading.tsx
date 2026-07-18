import { Skeleton } from "@/components/ui/skeleton";
import { CONSOLE_CONTENT_FRAME_CLASS } from "@/components/design-system/shell";
import { cn } from "@/lib/utils";

// Rendered as the routed child inside AppShell's content scope, so the outer
// padding (CONSOLE_CONTENT_SCOPE_CLASS) is already applied by the shell; this
// only owns the inner frame so the skeleton lines up with the loaded page.
//
// The highest-frequency landing route (Studio) is a single vertically-centered
// composer, so the placeholder mirrors that shape — a centered composer block —
// rather than a 3-column card grid, which caused a load→content layout jump.
// content-frame is a full-height flex column (flex-1), so centering the block
// keeps the loading and loaded states on the same vertical rhythm.
export default function ConsoleLoading() {
  return (
    <section
      className={cn(CONSOLE_CONTENT_FRAME_CLASS, "items-center justify-center")}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex w-full max-w-2xl flex-col items-center gap-4">
        <Skeleton className="h-5 w-40 rounded-lg bg-(--bg-elevated)" />
        <Skeleton className="h-32 w-full rounded-2xl border border-(--border-subtle) bg-(--bg-elevated)" />
        <Skeleton className="h-9 w-32 rounded-full bg-(--bg-elevated)" />
      </div>
    </section>
  );
}
