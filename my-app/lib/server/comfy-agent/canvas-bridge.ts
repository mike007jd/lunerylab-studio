// Shared canvas-window bridge helpers.
//
// Both the /api/comfy/canvas/load route and the agent's edit_graph tool apply
// API-format workflows through the same bridge eval path, so the contract
// lives in exactly one place.

import "server-only";
import { NextResponse } from "next/server";
import type { DesktopBridge } from "@/lib/server/desktop-bridge";
import { proxyToBridge } from "@/lib/server/desktop-bridge";
import { ApiError } from "@/lib/server/errors";

/**
 * Load an API-format workflow into the canvas window's official frontend.
 * The frontend's loadApiJson validates node types against object_info, so an
 * unknown class_type surfaces inside the ComfyUI UI rather than here.
 */
export async function loadWorkflowOnCanvas(
  bridge: DesktopBridge,
  workflow: Record<string, unknown>,
): Promise<void> {
  const response: NextResponse = await proxyToBridge(bridge, "/comfy-canvas-load", {
    method: "POST",
    body: JSON.stringify({ workflow }),
    timeoutMs: 10_000,
  });
  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "canvas_load_failed",
      message: "The ComfyUI canvas window did not accept the workflow.",
      retryable: true,
    });
  }
}

/** One literal widget-value edit applied on an existing live frontend node. */
export interface CanvasWidgetEdit {
  nodeId: string;
  name: string;
  value: string | number | boolean;
}

/**
 * Apply literal widget-value edits directly on the live frontend graph so node
 * positions, groups, and untouched widget state are preserved (reloading the
 * API-format graph would rebuild the layout). The frontend resolves each node by
 * id and each field by widget name, surfacing an unknown node/field as an error
 * here rather than silently dropping the edit.
 */
export async function applyWidgetEditsOnCanvas(
  bridge: DesktopBridge,
  edits: CanvasWidgetEdit[],
): Promise<void> {
  const response: NextResponse = await proxyToBridge(bridge, "/comfy-canvas-apply-edits", {
    method: "POST",
    body: JSON.stringify({ edits }),
    timeoutMs: 8_000,
  });
  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "canvas_edit_failed",
      message: "The ComfyUI canvas window did not accept the edit.",
      retryable: true,
    });
  }
}
