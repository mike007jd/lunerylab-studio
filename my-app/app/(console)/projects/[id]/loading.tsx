import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectLoading() {
  return (
    <section className="w-full" aria-busy="true" aria-live="polite">
      <div className="space-y-5 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-5 shadow-(--shadow-sm) sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-7 w-32 rounded-lg" />
            <Skeleton className="h-6 w-64 max-w-full rounded-lg" />
          </div>
          <Skeleton className="h-9 w-32 rounded-lg" />
        </div>
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="aspect-square w-full rounded-xl" />
          ))}
        </div>
      </div>
    </section>
  );
}
