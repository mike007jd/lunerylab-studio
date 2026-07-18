import { describe, expect, it } from "vitest";
import { VIDEO_JOB_TIMEOUT_MS } from "@/lib/constants/video-generation";

describe("video generation timeout", () => {
  it("keeps the server-owned deadline at 25 minutes", () => {
    expect(VIDEO_JOB_TIMEOUT_MS).toBe(25 * 60 * 1000);
  });
});
