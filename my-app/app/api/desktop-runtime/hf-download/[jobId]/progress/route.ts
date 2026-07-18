import { type NextRequest, NextResponse } from "next/server";
import { requireDesktopBridge } from "@/lib/server/desktop-bridge";

export const dynamic = "force-dynamic";

/**
 * GET /api/desktop-runtime/hf-download/[jobId]/progress
 *
 * SSE passthrough: opens the bridge /download-events endpoint and pipes the
 * upstream chunked SSE response straight through to the browser client.
 * Uses plain fetch + Response body piping (no EventSource) so the desktop
 * bridge token can be passed and the route is same-origin to the Next server.
 *
 * The bridge sends: `data: {json}\n\n` frames in chunked transfer encoding.
 * We strip the chunked framing (fetch + ReadableStream handles that) and
 * pass the body bytes directly so the browser's EventSource sees plain
 * `data:` lines.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const bridge = requireDesktopBridge();
  if (bridge instanceof NextResponse) return bridge;
  const { url, token } = bridge;

  const { jobId } = await params;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${url}/download-events?jobId=${encodeURIComponent(jobId)}`,
      {
        cache: "no-store",
        headers: { "x-lunery-desktop-token": token },
      },
    );
  } catch {
    // Bridge process is down / socket refused — surface a typed error the SSE
    // reader can treat as a closed stream instead of crashing the route.
    return NextResponse.json(
      { error: "Desktop runtime bridge is not available" },
      { status: 404 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "upstream error");
    return NextResponse.json(
      { error: text },
      { status: upstream.status || 500 },
    );
  }

  // Pipe the upstream body directly to the browser.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Prevent Next/middleware from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
