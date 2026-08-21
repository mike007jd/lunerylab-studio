// In-memory activity feed for jobs submitted to the attached ComfyUI server.
//
// The /comfy workspace polls this feed so it can load the exact workflow a
// Studio generation queued into the embedded official canvas (via the frame
// agent) and show live progress. Server-global reality: jobs queued from the
// user's own ComfyUI editor never appear here — the workspace learns about
// those from the frame agent's relayed websocket events instead.
//
// Deliberately memory-only: the feed is a live "what is happening now" view,
// not a history store. The Next desktop server is a single long-lived process,
// so a module-global ring is the whole persistence story.

import type { ComfyActivityJob, ComfyActivityJobStatus } from "@/lib/comfy-attach";

export type { ComfyActivityJob, ComfyActivityJobStatus };

const MAX_JOBS = 50;

let jobs: ComfyActivityJob[] = [];

function prune() {
  while (jobs.length > MAX_JOBS) jobs.pop();
}

export function recordComfyJobStarted(input: {
  id: string;
  endpoint: string;
  workflow: unknown;
  prompt: string;
}): void {
  if (!input.id || !input.endpoint) return;
  // Retries of the same prompt id must not duplicate entries.
  jobs = jobs.filter((job) => !(job.id === input.id && job.endpoint === input.endpoint));
  jobs.unshift({
    id: input.id,
    endpoint: input.endpoint,
    status: "running",
    workflow: input.workflow,
    prompt: input.prompt,
    startedAt: new Date().toISOString(),
  });
  prune();
}

export function recordComfyJobFinished(
  endpoint: string,
  id: string,
  status: Exclude<ComfyActivityJobStatus, "running">,
): void {
  const job = jobs.find((entry) => entry.id === id && entry.endpoint === endpoint);
  if (!job || job.status !== "running") return;
  job.status = status;
  job.finishedAt = new Date().toISOString();
}

export function listRecentComfyJobs(): ComfyActivityJob[] {
  return [...jobs];
}

/** Test seam: the ring is process-global, so tests reset it between cases. */
export function resetComfyActivityForTests(): void {
  jobs = [];
}
