import "server-only";

import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/server/errors";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { isValidSdRunId, type SdProgressPhase } from "@/lib/types/sd-progress";

export function resolveSdRunId(value: FormDataEntryValue | null): string {
  if (value == null) return randomUUID();
  if (isValidSdRunId(value)) return value;
  throw new ApiError({
    status: 400,
    code: "invalid_request",
    message: "runId is invalid.",
    retryable: false,
  });
}

async function postToSdBridge(path: string, body: object): Promise<void> {
  const bridge = requireDesktopBridge();
  if (bridge instanceof Response) {
    console.error(`[lunerylab] SD progress bridge unavailable for ${path} (${bridge.status})`);
    return;
  }

  try {
    const response = await fetch(`${bridge.url}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-lunery-desktop-token": bridge.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      console.error(`[lunerylab] SD progress bridge ${path} failed (${response.status})`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    console.error(`[lunerylab] SD progress bridge ${path} request failed: ${message}`);
  }
}

/** Best-effort native progress notification after the business job is settled. */
export function finishSdProgress(
  runId: string,
  phase: Extract<SdProgressPhase, "completed" | "canceled" | "failed">,
): Promise<void> {
  return postToSdBridge("/sd-progress-finish", { runId, phase });
}
