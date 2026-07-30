import { describe, expect, it } from "vitest";
import {
  buildConfirmedRestoreBody,
  confirmedRestoreBodySize,
  normalizeWorkspaceBackupBlob,
  serializeWorkspaceDownload,
} from "@/components/settings/workspace-data-download";
import { WORKSPACE_RESTORE_LIMITS } from "@/lib/workspace-backup-limits";

describe("workspace download serialization", () => {
  it("downloads backups compactly so they stay inside the restore file-size gate", () => {
    const backup = {
      manifest: { format: "lunery-workspace-backup", version: 2 },
      data: {
        agentMessage: Array.from({ length: 80 }, (_, index) => ({
          id: `msg-${index}`,
          content: "workspace row payload ".repeat(40),
        })),
      },
      media: [{ path: "generated/x.png", base64: "A".repeat(4_000) }],
      config: [],
    };

    const compact = serializeWorkspaceDownload(backup, "compact");
    const pretty = serializeWorkspaceDownload(backup, "pretty");
    const restoreEnvelope = buildConfirmedRestoreBody(
      new Blob([compact], { type: "application/json" }),
    ).size;

    expect(compact.includes("\n")).toBe(false);
    expect(pretty.includes("\n")).toBe(true);
    expect(Buffer.byteLength(pretty)).toBeGreaterThan(Buffer.byteLength(compact));
    expect(restoreEnvelope).toBeLessThanOrEqual(WORKSPACE_RESTORE_LIMITS.maxEncodedBytes);
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(
      WORKSPACE_RESTORE_LIMITS.maxEncodedBytes,
    );
  });

  it("keeps diagnostics pretty-printed for readability", () => {
    const diagnostics = { runtime: { ok: true }, paths: { media: "/tmp/media" } };
    const pretty = serializeWorkspaceDownload(diagnostics, "pretty");
    expect(pretty).toBe(JSON.stringify(diagnostics, null, 2));
  });
});

describe("confirmed restore body construction", () => {
  it("wraps a validated backup Blob without building a second source string", async () => {
    const backupJson = '{"manifest":{"version":2},"data":{},"media":[],"config":[]}';
    const backup = new Blob([backupJson], { type: "application/json" });
    const body = buildConfirmedRestoreBody(backup);
    expect(body.type).toBe("application/json");
    expect(body.size).toBe(
      new TextEncoder().encode(backupJson).byteLength
        + new TextEncoder().encode('{"backup":').byteLength
        + new TextEncoder().encode(',"confirm":true}').byteLength,
    );
    expect(JSON.parse(await body.text())).toEqual({
      backup: { manifest: { version: 2 }, data: {}, media: [], config: [] },
      confirm: true,
    });
  });

  it("normalizes a UTF-8 BOM before validating and embedding backup bytes", async () => {
    const backupJson = '{"manifest":{"version":2},"data":{},"media":[],"config":[]}';
    const input = new Blob([
      Uint8Array.of(0xef, 0xbb, 0xbf),
      backupJson,
    ], { type: "application/json" });
    const normalized = await normalizeWorkspaceBackupBlob(input);

    expect(normalized.size).toBe(input.size - 3);
    expect(JSON.parse(await normalized.text())).toBeDefined();
    expect(
      JSON.parse(await buildConfirmedRestoreBody(normalized).text()),
    ).toEqual({
      backup: { manifest: { version: 2 }, data: {}, media: [], config: [] },
      confirm: true,
    });
  });

  it("includes the JSON envelope in the client-side encoded-size gate", () => {
    const backup = new Blob(["{}"], { type: "application/json" });
    const body = buildConfirmedRestoreBody(backup);
    const innerOnlyLimit = backup.size;

    expect(backup.size).toBeLessThanOrEqual(innerOnlyLimit);
    expect(confirmedRestoreBodySize(backup)).toBe(body.size);
    expect(confirmedRestoreBodySize(backup)).toBeGreaterThan(innerOnlyLimit);
  });
});
