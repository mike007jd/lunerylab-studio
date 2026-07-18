import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/server/errors";
import { CANVAS_LAYER_ORDER_BY } from "@/lib/server/canvas-layer-order";
import {
  parseDrawingState,
  serializeDrawingState,
} from "@/lib/canvas/drawing-state";

export const canvasSessionDetailInclude = Prisma.validator<Prisma.CanvasSessionInclude>()({
  layers: {
    include: {
      asset: {
        select: {
          id: true,
          kind: true,
        },
      },
    },
    orderBy: CANVAS_LAYER_ORDER_BY,
  },
});

export function assetNotFoundError() {
  return new ApiError({
    status: 404,
    code: "asset_not_found",
    message: "Asset not found.",
    retryable: false,
  });
}

export function canvasSessionNotFoundError() {
  return new ApiError({
    status: 404,
    code: "canvas_session_not_found",
    message: "Canvas session not found.",
    retryable: false,
  });
}

export function invalidStatusError() {
  return new ApiError({
    status: 400,
    code: "invalid_status",
    message: "Invalid status value.",
    retryable: false,
  });
}

export function toCanvasSessionPayload(session: {
  id: string;
  projectId: string | null;
  selectedAssetId: string | null;
  title: string;
  status: string;
  zoom: number;
  panX: number;
  panY: number;
  // Opaque JSON column — typed as unknown to avoid leaking Prisma's JsonValue
  // through the helper signature; parseDrawingState handles defensive hydrate.
  drawingState?: unknown;
  createdAt: Date;
  updatedAt: Date;
  layers?: Array<{
    id: string;
    assetId: string;
    sessionId: string;
    asset?: {
      id: string;
      kind: string;
    };
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    zIndex: number;
    locked: boolean;
    hidden: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;
}) {
  return {
    id: session.id,
    projectId: session.projectId,
    selectedAssetId: session.selectedAssetId,
    title: session.title,
    status: session.status,
    zoom: session.zoom,
    panX: session.panX,
    panY: session.panY,
    // Always emit a normalized shape so the client can hydrate without
    // knowing whether the column was empty / legacy / partially migrated.
    drawingState: serializeDrawingState(parseDrawingState(session.drawingState)),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    layers: (session.layers ?? []).map((layer) => ({
      id: layer.id,
      sessionId: layer.sessionId,
      assetId: layer.assetId,
      assetUrl: `/api/assets/${layer.asset?.id ?? layer.assetId}`,
      assetKind: layer.asset?.kind ?? "GENERATED",
      x: layer.x,
      y: layer.y,
      width: layer.width,
      height: layer.height,
      rotation: layer.rotation,
      zIndex: layer.zIndex,
      locked: layer.locked,
      hidden: layer.hidden,
      createdAt: layer.createdAt.toISOString(),
      updatedAt: layer.updatedAt.toISOString(),
    })),
  };
}
