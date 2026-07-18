import { ApiError } from "@/lib/server/errors";
import { resolveOwnedProjectId as resolveProjectIdForOwner } from "@/lib/server/project-ownership";

/** Max references (uploaded files + referenced asset ids) per generation. */
export const MAX_GENERATION_REFERENCES = 4;
export const MAX_GENERATED_IMAGES_PER_REQUEST = 4;

export function parseRequestedImageCount(raw: FormDataEntryValue | null): number {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return 1;
  const count = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_GENERATED_IMAGES_PER_REQUEST) {
    throw new ApiError({
      status: 400,
      code: "invalid_generation_count",
      message: `Image count must be an integer from 1 to ${MAX_GENERATED_IMAGES_PER_REQUEST}.`,
      retryable: false,
    });
  }
  return count;
}

/**
 * Reject a request whose total references exceed the cap BEFORE any reference
 * file is read — so there is no wasted I/O on inputs that would be dropped, and
 * the recorded `referenceCount` matches what's actually sent (no silent
 * `slice(0, 4)` truncation downstream).
 */
export function assertReferenceLimit(fileCount: number, assetIdCount: number): void {
  if (fileCount + assetIdCount > MAX_GENERATION_REFERENCES) {
    throw new ApiError({
      status: 400,
      code: "too_many_references",
      message: `At most ${MAX_GENERATION_REFERENCES} reference images are allowed per request.`,
      retryable: false,
    });
  }
}

/**
 * Shared request-shaping helpers for the generation routes (`/api/generate/*`).
 *
 * The image and video routes accept different multipart payloads (counts,
 * presets, tools vs. duration, single reference) so their field parsing stays
 * route-local — forcing one reader over both transports would be premature
 * abstraction. What they DO share, verbatim, is the request fingerprint used
 * for idempotent replay and the "resolve a caller-provided projectId to one the
 * caller actually owns, else 404" guard. Those lived as duplicated copies in
 * each route (same code, same 404 message/code); centralising them keeps the
 * ownership check from drifting between the two money-path routes.
 */

/** Stable fingerprint of a generation request, used for idempotent replay. */
export function buildRequestFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function uploadedFileFingerprint(
  file: Pick<File, "name" | "type" | "size" | "lastModified"> | null | undefined,
) {
  if (!file) return null;
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
}

export function trimFormString(formData: FormData, fieldName: string): string {
  return String(formData.get(fieldName) ?? "").trim();
}

export function trimFormStringOrNull(formData: FormData, fieldName: string): string | null {
  return trimFormString(formData, fieldName) || null;
}

export function firstNonEmptyFormString(
  formData: FormData,
  fieldNames: readonly string[],
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = trimFormString(formData, fieldName);
    if (value) return value;
  }
  return undefined;
}

export function getUploadedFiles(formData: FormData, fieldName: string): File[] {
  return formData
    .getAll(fieldName)
    .filter((entry): entry is File => entry instanceof File)
    .filter((file) => file.size > 0);
}

export function parseRepeatedFormStrings(formData: FormData, fieldName: string): string[] {
  return Array.from(
    new Set(
      formData
        .getAll(fieldName)
        .map((entry) => String(entry).trim())
        .filter(Boolean),
    ),
  );
}

export async function resolveOwnedProjectId(
  providedProjectId: string,
  userId: string,
  options: { notFoundMessage?: string } = {},
): Promise<string | null> {
  return resolveProjectIdForOwner(providedProjectId, userId, {
    notFoundMessage: options.notFoundMessage ?? "Provided projectId does not exist.",
  });
}
