import { NextRequest, NextResponse } from "next/server";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { jsonError } from "@/lib/server/errors";
import { bumpDesktopStatusRevision } from "@/lib/server/desktop-status-revision";

export const dynamic = "force-dynamic";

async function forwardSecretRequest(method: "POST" | "DELETE", request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;

    // Bump before the mutation so a concurrent consumer cannot keep a prior
    // cached snapshot. Bump again after success so any status read that raced
    // the bridge write is invalidated across independently bundled routes.
    bumpDesktopStatusRevision();
    const response = await proxyToBridge(bridge, "/provider-secret", {
      method,
      body: await request.text(),
    });
    if (response.ok) bumpDesktopStatusRevision();
    return response;
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  return forwardSecretRequest("POST", request);
}

export async function DELETE(request: NextRequest) {
  return forwardSecretRequest("DELETE", request);
}
