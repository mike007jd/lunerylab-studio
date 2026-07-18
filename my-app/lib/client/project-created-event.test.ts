// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  announceProjectCreated,
  announceProjectUpdated,
  subscribeToProjectCreated,
  subscribeToProjectUpdated,
} from "@/lib/client/project-created-event";

describe("project shell events", () => {
  it("keeps creation and update channels independent", () => {
    const created = vi.fn();
    const updated = vi.fn();
    const unsubscribeCreated = subscribeToProjectCreated(created);
    const unsubscribeUpdated = subscribeToProjectUpdated(updated);

    announceProjectCreated({ id: "project-1", name: "First" });
    expect(created).toHaveBeenCalledWith({ id: "project-1", name: "First" });
    expect(updated).not.toHaveBeenCalled();

    announceProjectUpdated({ id: "project-1", name: "Renamed" });
    expect(updated).toHaveBeenCalledWith({ id: "project-1", name: "Renamed" });
    expect(created).toHaveBeenCalledTimes(1);

    unsubscribeCreated();
    unsubscribeUpdated();
  });
});
