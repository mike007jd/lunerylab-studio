import { NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";

export const dynamic = "force-dynamic";

// Status polling is an expected optional check in web/dev mode and whenever the
// bridge process is momentarily down. Always resolve to an explicit JSON
// `{ available: false }` state so callers never mistake an absent/crashed
// bridge for a valid desktop status payload.
function statusUnavailable() {
  return NextResponse.json({
    available: false,
    error: "Desktop runtime bridge is not available",
  });
}

export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) {
    if (bridge.status === 404) return statusUnavailable();
    return bridge;
  }

  return proxyToBridge(bridge, "/status", undefined, statusUnavailable);
}
