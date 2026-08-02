import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToBridge: vi.fn(),
  requireDesktopBridge: vi.fn(),
}));

vi.mock("@/lib/server/desktop-bridge", () => ({
  proxyToBridge: mocks.proxyToBridge,
  requireDesktopBridge: mocks.requireDesktopBridge,
}));

import { GET } from "@/app/api/desktop-runtime/hf-download/[jobId]/route";

describe("desktop HF download status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDesktopBridge.mockReturnValue({
      url: "http://127.0.0.1:49152",
      token: "bridge-token",
    });
  });

  it("maps an exact bridge unknown snapshot to a typed 404", async () => {
    mocks.proxyToBridge.mockResolvedValue(Response.json({ status: "unknown" }));

    const response = await GET(
      new Request("http://localhost/api/desktop-runtime/hf-download/job-missing") as never,
      { params: Promise.resolve({ jobId: "job-missing" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Download job not found",
      code: "download_job_not_found",
      jobId: "job-missing",
    });
  });

  it("preserves an observed bridge snapshot", async () => {
    mocks.proxyToBridge.mockResolvedValue(Response.json({
      status: "downloading",
      received: 10,
      total: 100,
      error: null,
    }));

    const response = await GET(
      new Request("http://localhost/api/desktop-runtime/hf-download/job-live") as never,
      { params: Promise.resolve({ jobId: "job-live" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "downloading" });
  });
});
