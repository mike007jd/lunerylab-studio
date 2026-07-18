import { NextRequest, NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  const modelDir = request.nextUrl.searchParams.get("modelDir");
  const bridgePath = modelDir
    ? `/hardware?modelDir=${encodeURIComponent(modelDir)}`
    : "/hardware";

  return proxyToBridge(bridge, bridgePath);
}
