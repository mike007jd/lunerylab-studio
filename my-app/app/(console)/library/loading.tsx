import { Skeleton } from "@/components/ui/skeleton";

export default function LibraryLoading() {
  return (
    <section className="w-full" aria-busy="true" aria-live="polite">
      <div className="rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-5 shadow-(--shadow-sm) sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-64 max-w-full rounded-lg" />
          <Skeleton className="ml-auto h-9 w-72 max-w-full rounded-lg" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="aspect-square w-full rounded-xl" />
          ))}
        </div>
      </div>
    </section>
  );
}
