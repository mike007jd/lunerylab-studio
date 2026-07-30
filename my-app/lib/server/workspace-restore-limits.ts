import "server-only";

import { statfs } from "node:fs/promises";
import { ApiError } from "@/lib/server/errors";
import { luneryProfileRoot } from "@/lib/server/lunery-profile";
import { WORKSPACE_RESTORE_LIMITS } from "@/lib/workspace-backup-limits";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  CURRENT_SCHEMA_VERSION,
  type WorkspaceBackup,
} from "@/lib/server/workspace-backup";

export const RESTORE_LIMITS = WORKSPACE_RESTORE_LIMITS;

const RESTORE_MODELS = [
  "appState",
  "user",
  "userSettings",
  "project",
  "generationJob",
  "asset",
  "canvasSession",
  "canvasSnapshot",
  "agentTask",
  "canvasLayer",
  "agentMessage",
  "agentTaskStep",
  "referenceSet",
  "referenceSetAsset",
] as const;

function tooLarge(message: string): never {
  throw new ApiError({
    status: 413,
    code: "request_too_large",
    message,
    retryable: false,
  });
}

function estimatedDecodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

async function freeDiskBytes(): Promise<number | null> {
  try {
    const stats = await statfs(luneryProfileRoot());
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Boundedly stream a restore JSON body. Rejects before staging when encoded
 * size, structural counts, decoded payload sizes, or disk headroom exceed limits.
 */
export async function readBoundedRestoreBody(
  request: Request,
  limits: typeof RESTORE_LIMITS = RESTORE_LIMITS,
): Promise<{ backup: WorkspaceBackup; confirm: boolean }> {
  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader) {
    tooLarge("Restore requests must include Content-Length.");
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    tooLarge("Restore Content-Length is invalid.");
  }
  if (contentLength > limits.maxEncodedBytes) {
    tooLarge(`Restore body exceeds the ${limits.maxEncodedBytes} byte encoded limit.`);
  }

  const reader = request.body?.getReader();
  if (!reader) {
    tooLarge("Restore body is empty.");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limits.maxEncodedBytes) {
      await reader.cancel().catch(() => {});
      tooLarge(`Restore body exceeds the ${limits.maxEncodedBytes} byte encoded limit.`);
    }
    chunks.push(value);
  }

  if (total === 0) {
    tooLarge("Restore body is empty.");
  }
  if (contentLength !== total) {
    tooLarge("Restore body length does not match Content-Length.");
  }

  let parsed: unknown;
  try {
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Request must include a backup payload.",
      retryable: false,
    });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Request must include a backup payload.",
      retryable: false,
    });
  }

  const body = parsed as { backup?: WorkspaceBackup; confirm?: unknown };
  if (!body.backup) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "Request must include a backup payload.",
      retryable: false,
    });
  }

  assertRestorePayloadLimits(body.backup, limits);
  await assertRestoreDiskHeadroom(body.backup);

  return { backup: body.backup, confirm: body.confirm === true };
}

export function assertRestorePayloadLimits(
  backup: WorkspaceBackup,
  limits: typeof RESTORE_LIMITS = RESTORE_LIMITS,
): void {
  const manifest = backup.manifest;
  if (
    !manifest ||
    manifest.format !== BACKUP_FORMAT ||
    manifest.version !== BACKUP_VERSION ||
    manifest.schemaVersion !== CURRENT_SCHEMA_VERSION
  ) {
    // Leave unrecognized/schema mismatches to verifyBackupIntegrity (400/409).
    // Size limits still apply to media/config arrays when present.
  }

  const media = Array.isArray(backup.media) ? backup.media : [];
  const config = Array.isArray(backup.config) ? backup.config : [];
  const payloadCount = media.length + config.length;
  if (payloadCount > limits.maxPayloadCount) {
    tooLarge(`Restore payload count exceeds the ${limits.maxPayloadCount} limit.`);
  }

  let aggregate = 0;
  for (const entry of [...media, ...config]) {
    if (!entry || typeof entry.base64 !== "string") continue;
    const decoded = estimatedDecodedBytes(entry.base64);
    if (decoded > limits.maxPerFileDecodedBytes) {
      tooLarge(
        `Restore file exceeds the ${limits.maxPerFileDecodedBytes} byte per-file decoded limit.`,
      );
    }
    aggregate += decoded;
    if (aggregate > limits.maxAggregateDecodedBytes) {
      tooLarge(
        `Restore aggregate decoded bytes exceed the ${limits.maxAggregateDecodedBytes} byte limit.`,
      );
    }
  }

  const data = backup.data && typeof backup.data === "object" ? backup.data : {};
  let totalRows = 0;
  for (const model of RESTORE_MODELS) {
    const rows = data[model];
    const count = Array.isArray(rows) ? rows.length : 0;
    if (count > limits.maxPerModelRows) {
      tooLarge(`Restore row count for ${model} exceeds the ${limits.maxPerModelRows} limit.`);
    }
    totalRows += count;
    if (totalRows > limits.maxTotalRows) {
      tooLarge(`Restore total row count exceeds the ${limits.maxTotalRows} limit.`);
    }
  }
}

export async function assertRestoreDiskHeadroom(
  backup: WorkspaceBackup,
): Promise<void> {
  const media = Array.isArray(backup.media) ? backup.media : [];
  const config = Array.isArray(backup.config) ? backup.config : [];
  let needed = 0;
  for (const entry of [...media, ...config]) {
    if (!entry || typeof entry.base64 !== "string") continue;
    needed += estimatedDecodedBytes(entry.base64);
  }
  // Stage + rollback headroom: size this from the payload actually supplied.
  // Requiring the theoretical maximum single-file allowance even for a tiny
  // backup would incorrectly block restores on otherwise healthy machines.
  const required = needed * 2;
  const free = await freeDiskBytes();
  if (free !== null && free < required) {
    tooLarge("Insufficient disk space to stage the workspace restore.");
  }
}
