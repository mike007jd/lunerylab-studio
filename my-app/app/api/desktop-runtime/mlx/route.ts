import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findHfModelEntry } from "@/lib/hf-model-catalog";
import { proxyToBridge, requireDesktopBridge } from "@/lib/server/desktop-bridge";
import { parseJsonBody } from "@/lib/server/http-validation";
import { jsonError } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

const mlxBodySchema = z.object({
  modelId: z.string().optional(),
  action: z.enum(["start", "stop"]).optional(),
});

/** POST { modelId } → start (or switch) the embedded SwiftLM engine on that
 * model's HF repo. POST { action:"stop" } → stop. SwiftLM self-downloads the
 * repo on first start, so we pass the repo id, not an on-disk file path. */
export async function POST(request: NextRequest) {
  try {
    const bridge = requireDesktopBridge();
    if (bridge instanceof NextResponse) return bridge;

    const body = await parseJsonBody(request, mlxBodySchema);

    if (body.action === "stop") {
      return proxyToBridge(bridge, "/mlx-stop", { method: "POST" });
    }

    const { modelId } = body;
    if (!modelId) {
      return NextResponse.json({ error: "modelId is required" }, { status: 400 });
    }
    const entry = findHfModelEntry(modelId);
    if (!entry) {
      return NextResponse.json({ error: `Unknown model id: ${modelId}` }, { status: 404 });
    }
    if (entry.capability !== "planner-llm" || entry.runtimeTarget !== "mlx") {
      return NextResponse.json(
        { error: `Model ${modelId} is not an MLX text model` },
        { status: 400 },
      );
    }
    if (!entry.hfRepo) {
      return NextResponse.json({ error: "MLX model has no hfRepo" }, { status: 400 });
    }

    return proxyToBridge(bridge, "/mlx-start", {
      method: "POST",
      body: JSON.stringify({ model: entry.hfRepo }),
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** GET → embedded MLX engine status. */
export async function GET() {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;

  return proxyToBridge(bridge, "/mlx-status");
}
