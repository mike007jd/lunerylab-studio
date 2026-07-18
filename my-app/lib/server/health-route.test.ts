import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/server/prisma";

describe("desktop health identity", () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("proves the healthy bundled runtime identity without exposing its token", async () => {
    const token = "desktop-session-token";
    vi.stubEnv("LUNERY_DESKTOP_SESSION", token);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("does not invent a desktop identity outside the managed runtime", async () => {
    vi.stubEnv("LUNERY_DESKTOP_SESSION", "");

    const response = await GET();

    await expect(response.json()).resolves.not.toHaveProperty("session");
  });
});
