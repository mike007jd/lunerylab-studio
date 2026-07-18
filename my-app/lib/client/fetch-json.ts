/**
 * Typed error thrown by `fetchJson` on HTTP failure. Callers that want to
 * branch on status (e.g. classify a poll error as 4xx vs 5xx) should
 * `instanceof HttpError` and read `status` directly instead of regex-matching
 * the message — which used to be how `use-video-generation` did it.
 */
export class HttpError extends Error {
  status: number;
  statusText: string;
  payload: unknown;

  constructor(message: string, init: { status: number; statusText: string; payload?: unknown }) {
    super(message);
    this.name = "HttpError";
    this.status = init.status;
    this.statusText = init.statusText;
    this.payload = init.payload;
  }
}

export function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Pull a human-readable message out of a failed `Response`. Routes return
 * `{ error: "..." }`; some desktop-bridge passthroughs return plain text.
 * Unlike `fetchJson`, this tolerates non-JSON bodies (and reads the body only
 * once, so the caller must not have consumed it). Falls back to `fallback`
 * when the body is empty or unreadable.
 */
export async function readResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      return payloadErrorMessage(JSON.parse(text)) || text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
}

function payloadErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { error?: unknown; message?: unknown };
  return typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : undefined;
}

/**
 * Tiny `fetch` wrapper that parses JSON and throws a typed `HttpError`.
 *
 * Cancellation: `init.signal` is forwarded straight to `fetch`. Long-running
 * calls — prompt optimization, video polls, BYOK provider requests — MUST pass
 * an `AbortController.signal` from a `useEffect` cleanup or a "Cancel"
 * handler. The spinner has no other way to be interruptible: without a signal,
 * an in-flight slow request hangs until the server eventually responds (or
 * the user closes the tab). The shared `signal` from a stable
 * `AbortController` lets the same controller cover the whole call chain
 * (start → poll → finalise).
 *
 * On HTTP failure the throw is synchronous-ish (after parsing the JSON body),
 * so the caller's catch can `instanceof HttpError` and read `.status` /
 * `.payload` without further parsing.
 */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");

  if (!isJsonResponse) {
    const statusText = `${response.status} ${response.statusText}`.trim();
    throw new HttpError(
      `Expected JSON response but received ${contentType || "unknown content type"} (${statusText}).`,
      { status: response.status, statusText: response.statusText },
    );
  }

  const payload = (await response.json().catch(() => {
    throw new HttpError("Received an invalid JSON response.", {
      status: response.status,
      statusText: response.statusText,
    });
  })) as T;

  if (!response.ok) {
    const serverMsg = payloadErrorMessage(payload);
    const statusText = `${response.status} ${response.statusText}`.trim();
    const detail = serverMsg ? `${serverMsg} (${statusText})` : `Request failed: ${statusText}`;
    throw new HttpError(detail, {
      status: response.status,
      statusText: response.statusText,
      payload,
    });
  }

  return payload;
}
