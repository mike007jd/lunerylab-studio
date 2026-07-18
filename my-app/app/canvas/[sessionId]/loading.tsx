import { Skeleton } from "@/components/ui/skeleton";

// Canvas route is the heaviest in the app — the editor, image streaming, and the
// session-state fetch can take a second on cold cache. The live canvas is a
// full-bleed `fixed inset-0` stage with only floating chrome (top-left exit +
// bottom toolbar), so the skeleton mirrors that shape — a full-bleed stage
// placeholder with floating-toolbar hints — to avoid a layout jump when the
// data resolves.
export default function CanvasLoading() {
  return (
    <div
      className="fixed inset-0 bg-(--bg-base) p-6"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Full-bleed stage placeholder. */}
      <Skeleton className="h-full w-full rounded-(--radius-panel) border border-(--border-subtle) bg-(--bg-elevated)" />

      {/* Floating top-left exit hint. */}
      <div className="absolute left-8 top-8 flex items-center gap-2">
        <Skeleton className="h-7 w-24 rounded-(--radius-panel) bg-(--bg-elevated)" />
      </div>

      {/* Floating bottom toolbar hint. */}
      <div className="absolute inset-x-0 bottom-8 flex justify-center">
        <Skeleton className="h-11 w-72 rounded-(--radius-panel) border border-(--border-subtle) bg-(--bg-elevated)" />
      </div>
    </div>
  );
}
