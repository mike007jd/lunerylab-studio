import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/server/errors";

export const canvasLayerInclude = Prisma.validator<Prisma.CanvasLayerInclude>()({
  asset: {
    select: {
      id: true,
      kind: true,
    },
  },
});

export type CanvasLayerWithAsset = Prisma.CanvasLayerGetPayload<{
  include: typeof canvasLayerInclude;
}>;

// Shared request-body shape for the layer create + update routes. Update uses
// it directly; create extends it with `assetId`. All fields optional and
// non-strict — the handlers keep their own `Number.isFinite` / `typeof` guards,
// so this only structurally types the geometry/flag fields.
export const canvasLayerGeometrySchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  rotation: z.number().optional(),
  zIndex: z.number().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

export type CanvasLayerGeometryInput = z.infer<typeof canvasLayerGeometrySchema>;

function finiteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function buildCanvasLayerCreateData(
  sessionId: string,
  assetId: string,
  body: CanvasLayerGeometryInput,
) {
  return {
    sessionId,
    assetId,
    x: finiteNumber(body.x) ? body.x : 0,
    y: finiteNumber(body.y) ? body.y : 0,
    width: finiteNumber(body.width) ? Math.max(1, body.width) : 1024,
    height: finiteNumber(body.height) ? Math.max(1, body.height) : 1024,
    rotation: finiteNumber(body.rotation) ? body.rotation : 0,
    zIndex: finiteNumber(body.zIndex) ? Math.floor(body.zIndex) : 0,
    locked: typeof body.locked === "boolean" ? body.locked : false,
    hidden: typeof body.hidden === "boolean" ? body.hidden : false,
  };
}

export function buildCanvasLayerUpdateData(body: CanvasLayerGeometryInput) {
  const data: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rotation?: number;
    zIndex?: number;
    locked?: boolean;
    hidden?: boolean;
  } = {};

  if (finiteNumber(body.x)) data.x = body.x;
  if (finiteNumber(body.y)) data.y = body.y;
  if (finiteNumber(body.width)) data.width = Math.max(1, body.width);
  if (finiteNumber(body.height)) data.height = Math.max(1, body.height);
  if (finiteNumber(body.rotation)) data.rotation = body.rotation;
  if (finiteNumber(body.zIndex)) data.zIndex = Math.floor(body.zIndex);
  if (typeof body.locked === "boolean") data.locked = body.locked;
  if (typeof body.hidden === "boolean") data.hidden = body.hidden;

  return data;
}

export function needsFullLayerResponse(body: CanvasLayerGeometryInput) {
  return body.locked !== undefined || body.hidden !== undefined;
}

export function assetRequiredError() {
  return new ApiError({
    status: 400,
    code: "asset_required",
    message: "assetId is required.",
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

export function assetNotFoundError() {
  return new ApiError({
    status: 404,
    code: "asset_not_found",
    message: "Asset not found.",
    retryable: false,
  });
}

export function canvasLayerNotFoundError() {
  return new ApiError({
    status: 404,
    code: "canvas_layer_not_found",
    message: "Canvas layer not found.",
    retryable: false,
  });
}

export function toLayerPayload(layer: CanvasLayerWithAsset) {
  return {
    id: layer.id,
    sessionId: layer.sessionId,
    assetId: layer.assetId,
    assetUrl: `/api/assets/${layer.asset.id}`,
    assetKind: layer.asset.kind,
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
  };
}
