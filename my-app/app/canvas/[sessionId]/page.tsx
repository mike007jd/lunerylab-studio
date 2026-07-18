import { notFound } from "next/navigation";
import { CanvasPage } from "@/components/canvas/canvas-page";

interface Params {
  params: Promise<{ sessionId: string }>;
}

/**
 * Canvas route — Konva (MIT) is the focused asset renderer. Image layers
 * persist through CanvasLayer rows; mask annotations persist through
 * CanvasSession.drawingState.
 */
export default async function CanvasRoute({ params }: Params) {
  const { sessionId } = await params;
  if (sessionId === "visitor") notFound();
  return <CanvasPage sessionId={sessionId} />;
}
