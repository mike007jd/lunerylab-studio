/** Shared client/server ceilings for the current JSON workspace-backup format. */
const MIB = 1024 * 1024;

export const WORKSPACE_RESTORE_LIMITS = {
  // JSON restore necessarily holds encoded bytes, a concatenated Buffer, a
  // UTF-16 string, the parsed object, and decoded validation buffers. Keep the
  // wire cap deliberately below the Node/WebView heap danger zone. Larger
  // workspaces require a future streaming archive format, not a higher JSON cap.
  maxEncodedBytes: 128 * MIB,
  maxPayloadCount: 10_000,
  maxPerFileDecodedBytes: 64 * MIB,
  maxAggregateDecodedBytes: 96 * MIB,
  maxPerModelRows: 100_000,
  maxTotalRows: 500_000,
} as const;
