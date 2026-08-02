import { NextRequest, NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";

export const dynamic = "force-dynamic";

/**
 * GET /api/desktop-runtime/hf-download/[jobId]
 * Returns the current status snapshot for the given job.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  const { jobId } = await params;

  const response = await proxyToBridge(
    bridge,
    `/hf-download-status?jobId=${encodeURIComponent(jobId)}`,
  );
  if (response.ok) {
    const payload = await response.clone().json().catch(() => null) as { status?: unknown } | null;
    if (payload?.status === "unknown") {
      return NextResponse.json(
        {
          error: "Download job not found",
          code: "download_job_not_found",
          jobId,
        },
        { status: 404 },
      );
    }
  }
  return response;
}

/**
 * DELETE /api/desktop-runtime/hf-download/[jobId]
 * Cancels the download job.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  const { jobId } = await params;

  return proxyToBridge(bridge, "/hf-download-cancel", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}
