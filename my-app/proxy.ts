import { NextResponse, type NextRequest } from "next/server";
import { isDesktopOnlyRoute, isDesktopRuntime } from "@/lib/desktop-runtime";
import { buildCsp } from "@/lib/csp";
import { PUBLIC_SITE_DOWNLOAD_URL } from "@/lib/public-site";

const DESKTOP_WEBVIEW_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/**
 * Trusted loopback binding from process startup state (Rust/dev launcher sets
 * PORT + HOSTNAME=127.0.0.1). Never derived from Host / X-Forwarded-*.
 */
export function trustedDesktopLoopbackOrigin(): string | null {
  const port = process.env.PORT?.trim();
  if (!port || !/^\d{1,5}$/.test(port)) return null;
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return null;
  return `http://127.0.0.1:${numeric}`;
}

export function trustedDesktopHost(): string | null {
  const origin = trustedDesktopLoopbackOrigin();
  if (!origin) return null;
  return origin.slice("http://".length);
}

function hasUntrustedForwardingHeaders(
  request: NextRequest,
  expectedHost: string,
): boolean {
  // Next's HTTP server synthesizes x-forwarded-host/proto when they are absent,
  // before Proxy runs. Accept only those exact canonical values; attacker-
  // supplied values survive the server's ??= normalization and fail closed.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  return Boolean(
    request.headers.get("forwarded") ||
      (forwardedHost && forwardedHost !== expectedHost) ||
      (forwardedProto && forwardedProto !== "http"),
  );
}

/**
 * Desktop Host gate: every matched page/API request must present the exact
 * startup loopback Host. Reject missing, malformed, localhost, hostname,
 * wrong-port, forwarded, and arbitrary values before any routing work.
 */
export function assertTrustedDesktopHost(request: NextRequest): NextResponse | null {
  if (!isDesktopRuntime()) return null;

  const expectedHost = trustedDesktopHost();
  if (!expectedHost) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (hasUntrustedForwardingHeaders(request, expectedHost)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const rawHost = request.headers.get("host");
  if (!rawHost || rawHost !== expectedHost) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return null;
}

// Per-request script nonce + CSP. Style attributes stay allowed because the UI
// uses them for CSS variables and dynamic geometry.
// Next reads the `x-nonce` request header and stamps it onto its own inline
// bootstrap + RSC payload scripts automatically, and Server Components can
// pull it from `headers()` to pass into <Script nonce={...}>.
function buildNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
}

// HTML responses (page navigations, RSC payloads) get the nonce; static
// assets and JSON API responses keep the fallback CSP from next.config.ts.
function expectsHtml(request: NextRequest): boolean {
  if (isApiRoute(request.nextUrl.pathname)) return false;
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) return true;
  // RSC payload navigations: Next sends `RSC: 1` / `Next-Router-Prefetch: 1`.
  if (request.headers.get("rsc") || request.headers.get("next-router-prefetch")) return true;
  return false;
}

function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

// Allowed origins for the CSRF check come ONLY from server-side sources:
// the startup loopback origin plus the desktop WebView origins. We do NOT
// derive them from Host / x-forwarded-* — those are client-controllable.
function expectedAppOrigins(): string[] {
  const origins = new Set<string>();
  const desktopRuntime = isDesktopRuntime();
  if (desktopRuntime) {
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) origins.add(origin);
    const loopback = trustedDesktopLoopbackOrigin();
    if (loopback) origins.add(loopback);
  } else {
    // Non-desktop (public site) keeps same-origin CSRF against the request URL
    // only when Host validation is not the desktop gate.
    // Callers still must present Origin/Referer matching this set.
  }
  return Array.from(origins);
}

function expectedWebOrigin(request: NextRequest): string[] {
  return [request.nextUrl.origin];
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const method = request.method;

  const hostRejection = assertTrustedDesktopHost(request);
  if (hostRejection) return hostRejection;

  // Mint the nonce once per request and thread it through both
  // `forwardWithNonce` (sets it on the forwarded request headers Next reads
  // to stamp inline scripts) and `finalizeResponse` (writes it into the CSP).
  const nonce = expectsHtml(request) ? buildNonce() : null;

  // Workbench routes only open inside the desktop WebView. Browser traffic is
  // sent to the standalone public site, which owns marketing and downloads.
  if (isDesktopOnlyRoute(pathname)) {
    if (!isDesktopRuntime()) {
      return NextResponse.redirect(PUBLIC_SITE_DOWNLOAD_URL);
    }
    return finalizeResponse(forwardWithNonce(request, nonce), nonce);
  }

  // CSRF: state-changing API requests must present an Origin/Referer that
  // matches this app's origin. (No auth — single-user local app.)
  if (isApiRoute(pathname) && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const expected = isDesktopRuntime() ? expectedAppOrigins() : expectedWebOrigin(request);
    const origin = request.headers.get("origin");
    const refOrigin = refererOrigin(request.headers.get("referer"));
    const presented = origin ?? refOrigin;
    if (!presented || !expected.includes(presented)) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  return finalizeResponse(forwardWithNonce(request, nonce), nonce);
}

function forwardWithNonce(request: NextRequest, nonce: string | null): NextResponse {
  if (!nonce) return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  return NextResponse.next({ request: { headers } });
}

function finalizeResponse(response: NextResponse, nonce: string | null): NextResponse {
  if (nonce) {
    response.headers.set("Content-Security-Policy", buildCsp(nonce));
  }
  return response;
}

export const config = {
  matcher: [
    // Apply nonce-bearing CSP to every HTML page. Static assets are
    // excluded by extension so we don't burn cycles minting a nonce per .png.
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|.*\\.(?:png|jpe?g|svg|gif|webp|avif|ico|mp4|webm|m4a|woff2?|ttf|otf|css|js|json|map|txt|xml)$).*)",
  ],
};
