import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { ApiError, jsonError } from "@/lib/server/errors";
import { parseJsonBody } from "@/lib/server/http-validation";
import { requireLocalWorkspaceOwner } from "@/lib/server/local-workspace-owner";
import { requireWritableCanvasSession } from "@/lib/server/canvas-session-access";

interface Params {
  params: Promise<{ id: string }>;
}

// Mirrors the prior `{ orderedLayerIds?: unknown } | null` cast. The route
// tolerated a null body (defaulting to `[]` then throwing `invalid_layer_order`)
// so the object is `.nullable()` to preserve that. `orderedLayerIds` stays
// `unknown` because the handler does the Array.isArray / uniqueness / coverage
// checks itself and reports `invalid_layer_order`. Non-strict: extra keys
// ignored. This only newly-rejects a structurally non-object/non-null body
// (e.g. a bare JSON string or number) as `invalid_body`.
const reorderLayersBodySchema = z
  .object({ orderedLayerIds: z.unknown().optional() })
  .nullable();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireLocalWorkspaceOwner();
    const { id } = await params;
    const body = await parseJsonBody(request, reorderLayersBodySchema);
    const orderedLayerIds = Array.isArray(body?.orderedLayerIds)
      ? body.orderedLayerIds.map((value) => String(value)).filter(Boolean)
      : [];

    if (orderedLayerIds.length === 0 || new Set(orderedLayerIds).size !== orderedLayerIds.length) {
      throw new ApiError({
        status: 400,
        code: "invalid_layer_order",
        message: "orderedLayerIds must be a non-empty list of unique layer IDs.",
        retryable: false,
      });
    }

    await requireWritableCanvasSession(id, user.id);

    await prisma.$transaction(async (tx) => {
      const layers = await tx.canvasLayer.findMany({
        where: { sessionId: id },
        select: { id: true },
      });
      const existingIds = new Set(layers.map((layer) => layer.id));
      if (
        orderedLayerIds.length !== layers.length ||
        orderedLayerIds.some((layerId) => !existingIds.has(layerId))
      ) {
        throw new ApiError({
          status: 400,
          code: "invalid_layer_order",
          message: "orderedLayerIds must include every layer in this session.",
          retryable: false,
        });
      }

      // Single CASE-based UPDATE replaces N round-trips with one statement.
      const cases = orderedLayerIds
        .map((_, index) => Prisma.sql`WHEN ${orderedLayerIds[index]} THEN ${(index + 1) * 10}`)
        .reduce(
          (acc, fragment) => Prisma.sql`${acc} ${fragment}`,
          Prisma.empty,
        );
      await tx.$executeRaw(
        Prisma.sql`UPDATE "CanvasLayer" SET "zIndex" = CASE "id" ${cases} END WHERE "id" IN (${Prisma.join(orderedLayerIds)}) AND "sessionId" = ${id}`,
      );
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
