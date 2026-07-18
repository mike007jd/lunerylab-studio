import { z } from "zod";
import { ApiError } from "@/lib/server/errors";

/**
 * Shared zod-at-the-boundary helpers for API route handlers.
 *
 * Every mutating route used to hand-roll the same 15-line block: read the JSON
 * body, `safeParse` it against a schema, and — on failure — flatten the issues
 * into a `400 invalid_body` ApiError carrying `details.fieldErrors`. That block
 * was copy-pasted (and drifted) across routes, or omitted entirely so a
 * malformed body reached Prisma and surfaced as an opaque 500. These helpers
 * centralise the exact same contract so the parse/validate boundary is uniform
 * and a bad request always fails fast as a typed 400.
 *
 * The error shape is intentionally identical to what `app/api/settings`
 * established and what `lib/client/fetch-json` + the settings UI already read:
 * `code: "invalid_body"`, top-level `message` = the first issue's message (so
 * plain callers get something human), and `details.fieldErrors` = zod's
 * per-field error map (so clients can render inline hints).
 */

/** The 400 thrown when a payload fails schema validation. Exported for tests. */
export function invalidBodyError(error: z.ZodError): ApiError {
  const fieldErrors = error.flatten().fieldErrors;
  const firstIssue = error.issues[0];
  const message = firstIssue?.message ?? "Request body failed validation.";
  return new ApiError({
    status: 400,
    code: "invalid_body",
    message,
    retryable: false,
    details: { fieldErrors },
  });
}

/**
 * Validate an already-in-hand value against a schema. Use this for inputs that
 * aren't a raw JSON body — e.g. fields pulled out of `FormData`, query params,
 * or a body the handler already read for another reason. Throws the standard
 * `invalid_body` ApiError (caught by `jsonError`) on failure.
 */
export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidBodyError(parsed.error);
  }
  return parsed.data;
}

/**
 * Read a request's JSON body and validate it against `schema`. A missing or
 * syntactically invalid body parses as `null`, which then fails the schema and
 * yields the same `400 invalid_body` as any other validation failure — callers
 * never have to special-case "empty body" themselves.
 *
 * Returns the parsed, fully-typed value (`z.infer` of the schema).
 */
export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const rawBody = await request.json().catch(() => null);
  return parseWithSchema(schema, rawBody);
}

/**
 * Read a request's multipart / urlencoded body as `FormData`. When the body is
 * not form-encoded (e.g. a client sends `application/json`, `text/plain`, or no
 * content-type), `Request.formData()` throws a `TypeError` — which, left
 * unwrapped, escapes as an opaque `500 internal_error` instead of telling the
 * caller their request was malformed. This mirrors `parseJsonBody`: a body the
 * route can't parse fails fast as a typed `400`, never a 500.
 */
export async function parseFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiError({
      status: 400,
      code: "invalid_content_type",
      message:
        "Request body must be multipart/form-data or application/x-www-form-urlencoded.",
      retryable: false,
    });
  }
}
