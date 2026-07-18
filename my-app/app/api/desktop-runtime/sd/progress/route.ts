import { NextRequest, NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { isValidSdRunId } from "@/lib/types/sd-progress";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId") ?? "";
  if (!isValidSdRunId(runId)) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  return proxyToBridge(
    bridge,
    `/sd-progress?runId=${encodeURIComponent(runId)}`,
    undefined,
    () => NextResponse.json({ progress: null }),
  );
}
