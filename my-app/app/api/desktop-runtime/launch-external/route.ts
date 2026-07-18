import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

const launchExternalBodySchema = z.object({
  appId: z.string().optional(),
});

/**
 * POST { appId: "ollama" | "lm-studio" | "comfyui" }
 *
 * Fire-and-forget request to the desktop bridge asking it to launch the named
 * external runtime app. Validation lives in Rust (`launch_external_app`) so
 * the route just whitelists the payload shape + forwards. Errors propagate
 * through with the bridge's status code.
 *
 * Used by the Settings → Connected runtimes panel for the "Open App" button
 * on installed-but-not-running entries.
 */
export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;

    const body = await parseJsonBody(request, launchExternalBodySchema);
    const appId = (body.appId ?? "").trim();
    if (!appId) {
      return NextResponse.json({ error: "appId is required" }, { status: 400 });
    }

    return proxyToBridge(bridge, "/launch-external-app", {
      method: "POST",
      body: JSON.stringify({ appId }),
    });
  } catch (error) {
    return jsonError(error);
  }
}
