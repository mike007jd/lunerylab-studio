import { NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";

export const dynamic = "force-dynamic";

/** GET → embedded stable-diffusion.cpp engine status ({ available, engine }). */
export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  return proxyToBridge(bridge, "/sd-status");
}
