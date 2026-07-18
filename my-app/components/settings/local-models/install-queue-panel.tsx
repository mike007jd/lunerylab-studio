"use client";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { QueueEntry } from "./types";
import type { CopyShape } from "./copy";
import { isActiveQueueStatus } from "./catalog-utils";

export function InstallQueuePanel({ queue, copy }: { queue: QueueEntry[]; copy: CopyShape }) {
  const active = queue.filter((item) => isActiveQueueStatus(item.status));
  // Only surface the queue while something is actually downloading — no idle
  // "no active installs" box cluttering the panel.
  if (active.length === 0) return null;
  return (
    <div className="border-t border-(--border-subtle) pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-(--text-secondary)">{copy.queueTitle}</h3>
        <Badge variant="gold" className="text-(--text-muted)">
          {active.length}
        </Badge>
      </div>
      <div className="divide-y divide-(--border-subtle)">
        {active.map((item) => (
          <div key={item.id} className="space-y-1 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-medium text-(--text-primary)">{item.label}</span>
              <span className="shrink-0 text-(--text-muted)">
                {item.percent !== null ? `${item.percent}%` : item.status}
              </span>
            </div>
            {/* Known percent → real bar; unknown (queued / no total yet) →
                genuine indeterminate, not a fake stuck 33%. */}
            <Progress
              value={item.percent === null ? null : item.percent}
              className={cn(
                "h-1.5 bg-(--bg-glass)",
                item.percent === null && "animate-pulse opacity-70",
              )}
            />
            <div className="flex items-center justify-between gap-2 text-xs text-(--text-muted)">
              <span>{copy.fileProgress(item.fileIndex + 1, item.fileCount)}</span>
              {item.speedBps > 0 && <span>{copy.speed(item.speedBps)}</span>}
            </div>
            {item.error && <p className="text-xs text-(--destructive)">{item.error}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
