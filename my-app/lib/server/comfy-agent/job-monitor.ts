// Detached lifecycle watcher for agent-queued ComfyUI jobs.
//
// queue_prompt returns the moment the server accepts the prompt, long before the
// job finishes. Without this the activity feed would strand a phantom "running"
// entry forever — canvas-follow could reload that stale workflow over newer
// edits, and a user Stop would leave the job burning GPU. This watcher runs
// independent of the request lifecycle: it polls the job to a terminal state and
// records it, and cancels the job on the server if the agent run is aborted.

import "server-only";
import type { ValidatedProviderEndpoint as ValidatedComfyEndpoint } from "@/lib/server/byok-shared";
import { recordComfyJobFinished } from "@/lib/server/comfy-activity";
import { cancelComfyPrompt, pollComfyJobUntilTerminal } from "@/lib/server/comfy-agent/comfy-client";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Watch a queued agent job to a terminal state and reconcile the activity feed.
 * `activeEndpointRaw` is the connection's stored endpoint (the feed's matching
 * key); `endpoint` is the DNS-pinned transport target. Detached and self-
 * contained: it never throws, so callers fire it with `void`.
 *
 * Abort semantics: `abortSignal` is the agent request signal, which fires on a
 * user Stop (or client disconnect), never on normal stream completion — so an
 * abort means "stop this job", and the watcher cancels it on the server.
 */
export async function trackComfyAgentJob(
  endpoint: ValidatedComfyEndpoint,
  activeEndpointRaw: string,
  promptId: string,
  abortSignal: AbortSignal,
): Promise<void> {
  try {
    const status = await pollComfyJobUntilTerminal(endpoint, promptId, abortSignal);
    // null = gave up watching (timeout) — leave the last-known state untouched
    // rather than mislabel a job whose outcome we never observed.
    if (status) recordComfyJobFinished(activeEndpointRaw, promptId, status);
  } catch (error) {
    if (isAbortError(error)) {
      await cancelComfyPrompt(endpoint, promptId).catch(() => undefined);
      recordComfyJobFinished(activeEndpointRaw, promptId, "cancelled");
    } else {
      recordComfyJobFinished(activeEndpointRaw, promptId, "failed");
    }
  }
}
