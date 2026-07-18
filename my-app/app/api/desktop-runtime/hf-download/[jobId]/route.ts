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

  return proxyToBridge(
    bridge,
    `/hf-download-status?jobId=${encodeURIComponent(jobId)}`,
  );
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
