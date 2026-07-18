import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { SD_RUN_ID_PATTERN } from "@/lib/types/sd-progress";

export const dynamic = "force-dynamic";

const cancelBodySchema = z.object({
  runId: z.string().regex(SD_RUN_ID_PATTERN),
});

export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;
    const body = await parseJsonBody(request, cancelBodySchema);
    return proxyToBridge(bridge, "/sd-cancel", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    return jsonError(error);
  }
}
