// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  announceProjectCreated,
  announceProjectDeleted,
  announceProjectUpdated,
  subscribeToProjectCreated,
  subscribeToProjectDeleted,
  subscribeToProjectUpdated,
} from "@/lib/client/project-created-event";

describe("project shell events", () => {
  it("keeps creation, update, and deletion channels independent", () => {
    const created = vi.fn();
    const updated = vi.fn();
    const deleted = vi.fn();
    const unsubscribeCreated = subscribeToProjectCreated(created);
    const unsubscribeUpdated = subscribeToProjectUpdated(updated);
    const unsubscribeDeleted = subscribeToProjectDeleted(deleted);

    announceProjectCreated({ id: "project-1", name: "First" });
    expect(created).toHaveBeenCalledWith({ id: "project-1", name: "First" });
    expect(updated).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();

    announceProjectUpdated({ id: "project-1", name: "Renamed" });
    expect(updated).toHaveBeenCalledWith({ id: "project-1", name: "Renamed" });
    expect(created).toHaveBeenCalledTimes(1);
    expect(deleted).not.toHaveBeenCalled();

    announceProjectDeleted({ id: "project-1", name: "Renamed" });
    expect(deleted).toHaveBeenCalledWith({ id: "project-1", name: "Renamed" });
    expect(created).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);

    unsubscribeCreated();
    unsubscribeUpdated();
    unsubscribeDeleted();
  });
});
