import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchJson = vi.fn();

vi.mock("@/lib/client/fetch-json", () => ({
  fetchJson: (...args: unknown[]) => fetchJson(...args),
}));

import { createProject, deleteProject, renameProject } from "@/lib/client/projects";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("projects client helpers", () => {
  it("creates a project through POST /api/projects", async () => {
    fetchJson.mockResolvedValue({ project: { id: "p1", name: "New" } });
    await expect(createProject({ name: "New" })).resolves.toEqual({ id: "p1", name: "New" });
    expect(fetchJson).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST" }));
  });

  it("renames a project through PATCH", async () => {
    fetchJson.mockResolvedValue({
      project: { id: "p1", name: "Renamed", updatedAt: "2026-07-29T00:00:00.000Z" },
    });
    await expect(renameProject("p1", "Renamed")).resolves.toMatchObject({ name: "Renamed" });
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/projects/p1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("deletes a project through DELETE", async () => {
    fetchJson.mockResolvedValue({ deleted: { id: "p1", name: "Gone" } });
    await expect(deleteProject("p1")).resolves.toEqual({ id: "p1", name: "Gone" });
    expect(fetchJson).toHaveBeenCalledWith("/api/projects/p1", { method: "DELETE" });
  });
});
