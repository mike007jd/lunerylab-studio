/** Compact backup downloads; pretty-print only human-readable diagnostics. */
const RESTORE_BODY_PREFIX = '{"backup":';
const RESTORE_BODY_SUFFIX = ',"confirm":true}';

export function serializeWorkspaceDownload(
  value: unknown,
  style: "compact" | "pretty",
): string {
  return style === "pretty" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** Keep validated text and submitted bytes identical for UTF-8 BOM inputs. */
export async function normalizeWorkspaceBackupBlob(input: Blob): Promise<Blob> {
  if (input.size < 3) return input;
  const prefix = new Uint8Array(await input.slice(0, 3).arrayBuffer());
  const hasUtf8Bom = prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
  return hasUtf8Bom
    ? input.slice(3, input.size, "application/json")
    : input;
}

export function confirmedRestoreBodySize(backupJson: Blob): number {
  return RESTORE_BODY_PREFIX.length + backupJson.size + RESTORE_BODY_SUFFIX.length;
}

/**
 * Build the restore request body from an already-validated backup JSON Blob.
 * Blob parts avoid concatenating another near-limit JavaScript string.
 */
export function buildConfirmedRestoreBody(backupJson: Blob): Blob {
  return new Blob(
    [RESTORE_BODY_PREFIX, backupJson, RESTORE_BODY_SUFFIX],
    { type: "application/json" },
  );
}
