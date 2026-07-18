import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import type { ApiErrorPayload } from "@/lib/types/api";

/**
 * Replace credential-shaped substrings in any value before it lands in a log.
 * `readByokKey`'s contract is "never log the key"; `toApiError` / provider
 * error paths used to violate it by passing an Error whose message embedded
 * the request URL with `Authorization: Bearer …`. Scrub at the boundary so
 * even a regression upstream can't leak the token to stderr.
 *
 * Patterns are anchored on credential-specific tokens — bare `key`/`secret`
 * alternatives were dropped because they were matching benign log lines like
 * `Unique constraint failed on field: key=email`.
 */
const REDACT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /Token\s+[A-Za-z0-9._\-]+/gi,
  // Credential field names — anchored so unrelated `key`/`secret` words in
  // ordinary log lines don't get mangled.
  /\b(?:api[-_]?key|api[-_]?secret|client[-_]?secret|access[-_]?token|password)\s*[:=]\s*"?[A-Za-z0-9._\-]+"?/gi,
  // OpenAI-style "sk-…", Anthropic "sk-ant-…", Replicate "r8_…"
  /\bsk-[A-Za-z0-9._\-]{16,}/g,
  /\br8_[A-Za-z0-9]{16,}/g,
];

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, "<redacted>");
    return out;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      stack: typeof value.stack === "string" ? redact(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor({
    status,
    code,
    message,
    retryable = false,
    details,
  }: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    console.error("[internal_error]", redact(error.message), redact(error.stack));
    return new ApiError({
      status: 500,
      code: "internal_error",
      message: "An unexpected error occurred. Please try again later.",
      retryable: false,
    });
  }

  return new ApiError({
    status: 500,
    code: "internal_error",
    message: "Unknown server error",
    retryable: false,
  });
}

export function jsonError(error: unknown) {
  const mapped = toApiError(error);
  const payload: ApiErrorPayload = {
    code: mapped.code,
    message: mapped.message,
    retryable: mapped.retryable,
    details: mapped.details,
  };

  return NextResponse.json(payload, { status: mapped.status });
}

const PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  provider_unauthorized: "AI provider rejected the request. Please retry later.",
  provider_rate_limited: "AI provider is busy. Please retry in a moment.",
  provider_unavailable: "AI provider is temporarily unavailable.",
  generation_failed: "Generation failed. Please retry.",
  video_download_failed: "Could not retrieve the generated video.",
};

/**
 * Run a Prisma operation and translate the `P2025 RecordNotFound` error into
 * a 404 ApiError. The plain pattern was duplicated across `app/api/projects`,
 * `app/api/assets`, and similar routes — each with an unsafe
 * `(error as { code?: string }).code === "P2025"` cast that could mis-fire on
 * unrelated errors that happen to carry a `code` property. Funnelling through
 * `Prisma.PrismaClientKnownRequestError` gives us the typed check.
 */
export async function withPrismaNotFound<T>(
  promise: Promise<T>,
  message: string,
  code = "not_found",
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApiError({
        status: 404,
        code,
        message,
        retryable: false,
      });
    }
    throw error;
  }
}

export function sanitizeProviderError(error: unknown, fallbackCode: string): ApiError {
  console.error("[provider_error]", redact(error));
  const source = error instanceof ApiError ? error : null;
  const status = source?.status ?? 502;
  const retryable = source?.retryable ?? status >= 500;
  const code = source && PROVIDER_ERROR_MESSAGES[source.code] ? source.code : fallbackCode;
  return new ApiError({
    status,
    code,
    message: PROVIDER_ERROR_MESSAGES[code] ?? PROVIDER_ERROR_MESSAGES.generation_failed!, // safe: generation_failed is a static key in PROVIDER_ERROR_MESSAGES
    retryable,
  });
}
