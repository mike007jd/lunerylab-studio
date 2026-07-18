"use client";

import { fetchJson } from "@/lib/client/fetch-json";
import type { CanvasDrawingState } from "@/lib/canvas/drawing-state";

export interface CanvasRawLayer {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex: number;
  hidden?: boolean;
  locked?: boolean;
}

export interface CanvasSessionPayload {
  id: string;
  updatedAt?: string;
  drawingState?: CanvasDrawingState;
  layers: CanvasRawLayer[];
}

export interface CanvasSessionResponse {
  session: CanvasSessionPayload;
}

export type CanvasLayerGeometryPatch = Partial<
  Pick<CanvasRawLayer, "x" | "y" | "width" | "height" | "rotation">
>;

function canvasSessionUrl(sessionId: string): string {
  return `/api/canvas/sessions/${encodeURIComponent(sessionId)}`;
}

function canvasLayerUrl(sessionId: string, layerId?: string): string {
  const base = `${canvasSessionUrl(sessionId)}/layers`;
  return layerId ? `${base}/${encodeURIComponent(layerId)}` : base;
}

async function fetchOk(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response;
}

export function fetchCanvasSession(sessionId: string): Promise<CanvasSessionResponse> {
  return fetchJson<CanvasSessionResponse>(canvasSessionUrl(sessionId), { cache: "no-store" });
}

export async function patchCanvasLayer(
  sessionId: string,
  layerId: string,
  patch: CanvasLayerGeometryPatch,
  signal?: AbortSignal,
): Promise<void> {
  await fetchOk(canvasLayerUrl(sessionId, layerId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal,
    // Geometry payloads are tiny and bounded. Make every in-flight save
    // navigation-safe, including one that already left the debounce queue
    // before the component starts unmounting.
    keepalive: true,
  });
}

export async function deleteCanvasLayer(sessionId: string, layerId: string): Promise<Response> {
  return fetch(canvasLayerUrl(sessionId, layerId), { method: "DELETE" });
}

export interface SendAssetToCanvasOptions {
  assetId: string;
  title: string;
  projectId?: string;
}

/**
 * The one Library/Studio → Canvas entry flow: create a session with the
 * asset as its first layer in a single API call, then return its canvas URL.
 */
export async function sendAssetToCanvas({
  assetId,
  title,
  projectId,
}: SendAssetToCanvasOptions): Promise<{ url: string }> {
  const created = await fetchJson<{ session: { id: string }; url: string }>("/api/canvas/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, title, assetId }),
  });
  return { url: created.url };
}
