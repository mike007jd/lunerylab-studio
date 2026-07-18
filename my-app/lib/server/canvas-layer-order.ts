import type { Prisma } from "@prisma/client";

/**
 * Canonical layer ordering for a canvas session.
 *
 * zIndex is the visual stacking order; createdAt + id break ties so that
 * layers sharing a zIndex (or a creation timestamp) always serialize in a
 * stable, deterministic order. Every query that reads layers — route handlers,
 * the agent context/serializer, snapshots — must use this so persisted and
 * rendered z-order never diverge.
 */
export const CANVAS_LAYER_ORDER_BY = [
  { zIndex: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.CanvasLayerOrderByWithRelationInput[];
