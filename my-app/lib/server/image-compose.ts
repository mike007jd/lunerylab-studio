import "server-only";
import { safeSharp } from "@/lib/server/image-safety";

export interface ComposeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Coerce a possibly-NaN / negative / out-of-range bbox (agent- or client-
 * supplied) to a finite integer rect clamped inside the image bounds, so a bad
 * region can never drive an out-of-bounds extract/composite. Shared by crop and
 * rect-mask so the defensive strategy lives in exactly one place.
 */
export function clampBboxToImage(
  bbox: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): ComposeRect {
  const finite = (n: number, fallback = 0) => (Number.isFinite(n) ? n : fallback);
  const w = Math.max(1, Math.floor(finite(imageWidth, 1)));
  const h = Math.max(1, Math.floor(finite(imageHeight, 1)));
  const left = Math.min(Math.max(0, Math.round(finite(bbox.x))), w - 1);
  const top = Math.min(Math.max(0, Math.round(finite(bbox.y))), h - 1);
  const width = Math.max(1, Math.min(w - left, Math.round(finite(bbox.width, 1))));
  const height = Math.max(1, Math.min(h - top, Math.round(finite(bbox.height, 1))));
  return { left, top, width, height };
}

/**
 * Crop the marked region (given in layer-display space) out of the source
 * image, scaled to the image's natural pixels, with a context padding margin.
 */
export async function cropRegion(
  source: Buffer,
  bbox: { x: number; y: number; width: number; height: number },
  layerWidth: number,
  layerHeight: number,
  paddingRatio = 0.12,
): Promise<{ cropBuffer: Buffer; rect: ComposeRect }> {
  const pipeline = safeSharp(source);
  const meta = await pipeline.metadata();
  const naturalW = meta.width ?? layerWidth;
  const naturalH = meta.height ?? layerHeight;
  const scaleX = naturalW / Math.max(1, layerWidth);
  const scaleY = naturalH / Math.max(1, layerHeight);

  // bbox is agent/client-supplied — coerce to finite, non-negative values so a
  // NaN/negative/out-of-range region can't produce an out-of-bounds extract.
  const finite = (n: number, fallback = 0) => (Number.isFinite(n) ? n : fallback);
  const safeX = Math.max(0, finite(bbox.x));
  const safeY = Math.max(0, finite(bbox.y));
  const safeW = Math.max(1, finite(bbox.width, 1));
  const safeH = Math.max(1, finite(bbox.height, 1));

  const rawW = safeW * scaleX;
  const rawH = safeH * scaleY;
  const padX = rawW * paddingRatio;
  const padY = rawH * paddingRatio;

  // Clamp the origin strictly inside the image so `extract` never starts at or
  // beyond the natural bounds (which sharp rejects).
  const left = Math.min(Math.max(0, Math.round(safeX * scaleX - padX)), Math.max(0, naturalW - 1));
  const top = Math.min(Math.max(0, Math.round(safeY * scaleY - padY)), Math.max(0, naturalH - 1));
  const width = Math.max(
    1,
    Math.min(naturalW - left, Math.round(rawW + padX * 2)),
  );
  const height = Math.max(
    1,
    Math.min(naturalH - top, Math.round(rawH + padY * 2)),
  );

  const rect: ComposeRect = { left, top, width, height };
  const cropBuffer = await pipeline
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  return { cropBuffer, rect };
}

/**
 * Resize the edited crop back to the rect size and composite it onto the
 * original image at the rect origin. Everything outside the rect is byte-identical.
 */
export async function compositeBack(
  source: Buffer,
  edited: Buffer,
  rect: ComposeRect,
): Promise<Buffer> {
  const resized = await safeSharp(edited)
    .resize(rect.width, rect.height, { fit: "fill" })
    .png()
    .toBuffer();
  return safeSharp(source)
    .composite([{ input: resized, left: rect.left, top: rect.top }])
    .png()
    .toBuffer();
}
