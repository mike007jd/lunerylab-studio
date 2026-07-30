import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  listReferenceSets: vi.fn(),
}));

vi.mock("@/lib/server/reference-set", () => ({
  listReferenceSets: mocks.listReferenceSets,
}));

import { buildListReferenceSetsTool } from "@/lib/server/agent/runtime/tools/reference-set-ops";

describe("list_reference_sets agent tool", () => {
  it("returns a failed tool result when the database read fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listReferenceSets.mockRejectedValue(new Error("db down"));
    const steps: Array<{ status: string; summary: string }> = [];
    const tool = buildListReferenceSetsTool({
      projectId: "project-1",
      userId: "user-1",
      nextStepIndex: () => steps.length,
      recordStep: (step: { status: string; summary: string }) => {
        steps.push(step);
      },
    } as never);

    const result = await (tool.execute as (input: unknown) => Promise<unknown>)({});

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: "Failed to read project reference sets.",
      sets: [],
    });
    expect(steps[0]?.status).toBe("failed");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("reference_sets_read_failed"),
    );
    consoleError.mockRestore();
  });

  it("returns sets when the database read succeeds", async () => {
    mocks.listReferenceSets.mockResolvedValue([
      {
        id: "set-1",
        projectId: "project-1",
        name: "Mood",
        description: null,
        assetIds: ["a1"],
        isDefault: true,
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    const tool = buildListReferenceSetsTool({
      projectId: "project-1",
      userId: "user-1",
      nextStepIndex: () => 0,
      recordStep: () => {},
    } as never);

    await expect((tool.execute as (input: unknown) => Promise<unknown>)({})).resolves.toMatchObject({
      ok: true,
      sets: [{ id: "set-1", name: "Mood", assetCount: 1, isDefault: true }],
    });
  });
});
