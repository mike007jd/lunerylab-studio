import "server-only";

import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/server/errors";
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

function bridgeConfig(): { url: string; token: string } | null {
  const url = process.env.LUNERY_DESKTOP_BRIDGE_URL;
  const token = process.env.LUNERY_DESKTOP_BRIDGE_TOKEN;
  return url && token ? { url, token } : null;
}

async function postToSdBridge(path: string, body: object): Promise<void> {
  const bridge = bridgeConfig();
  if (!bridge) return;
  await fetch(`${bridge.url}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-lunery-desktop-token": bridge.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
}

export function finishSdProgress(
  runId: string,
  phase: Extract<SdProgressPhase, "completed" | "canceled" | "failed">,
): Promise<void> {
  return postToSdBridge("/sd-progress-finish", { runId, phase });
}
