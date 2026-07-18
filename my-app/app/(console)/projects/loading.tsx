import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectsLoading() {
  return (
    <section className="w-full space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex justify-end gap-2">
        <Skeleton className="h-9 w-32 rounded-lg" />
        <Skeleton className="h-9 w-24 rounded-lg" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="space-y-4 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-5 shadow-(--shadow-sm) sm:p-6"
          >
            <Skeleton className="h-5 w-2/3 rounded-md" />
            <Skeleton className="h-4 w-1/3 rounded-md" />
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="h-8 rounded-lg" />
              <Skeleton className="h-8 rounded-lg" />
              <Skeleton className="h-8 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
