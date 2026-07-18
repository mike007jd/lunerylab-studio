import type { KonvaLayerItem } from "@/components/canvas/konva-stage";
import type {
  CanvasLayerGeometryPatch,
  CanvasRawLayer,
  CanvasSessionResponse,
} from "@/lib/client/canvas-sessions";

export type RawLayer = CanvasRawLayer;

export type SessionResponse = CanvasSessionResponse;

export type LayerGeometryPatch = CanvasLayerGeometryPatch;

// Coalesce a burst of drag/resize geometry changes into one PATCH per idle
// window, and cap retry attempts so a persistently failing save eventually
// surfaces instead of looping forever.
export const PATCH_DEBOUNCE_MS = 350;
export const PATCH_MAX_RETRIES = 4;

export function mapLayers(raws: RawLayer[]): KonvaLayerItem[] {
  return raws.map((l) => ({
    id: l.id,
    assetId: l.assetId,
    assetUrl: `/api/assets/${l.assetId}`,
    x: l.x,
    y: l.y,
    width: l.width,
    height: l.height,
    rotation: l.rotation,
    zIndex: l.zIndex,
    hidden: l.hidden,
    locked: l.locked,
  }));
}
