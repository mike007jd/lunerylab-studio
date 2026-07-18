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
// the server's own origin plus the desktop WebView origins in desktop runtime.
// We do NOT derive them from `x-forwarded-host`/`x-forwarded-proto` — those are
// client-controllable, and adding them to the allow-set would let an attacker
// present `Origin: https://evil` + `X-Forwarded-Host: evil` and bypass CSRF.
function expectedAppOrigins(request: NextRequest): string[] {
  const origins = new Set<string>([request.nextUrl.origin]);
  const desktopRuntime = isDesktopRuntime();
  if (desktopRuntime) {
    for (const origin of DESKTOP_WEBVIEW_ORIGINS) origins.add(origin);
    // Next normalizes a 127.0.0.1 request URL to localhost internally. Keep the
    // server-selected port and allow both loopback spellings so the navigated
    // WebView remains same-origin without trusting Host/X-Forwarded-* headers.
    const port = request.nextUrl.port ? `:${request.nextUrl.port}` : "";
    origins.add(`http://127.0.0.1${port}`);
    origins.add(`http://localhost${port}`);
  }
  return Array.from(origins);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const method = request.method;
  // Mint the nonce once per request and thread it through both
  // `forwardWithNonce` (sets it on the forwarded request headers Next reads
  // to stamp inline scripts) and `finalizeResponse` (writes it into the CSP).
  // Previously each helper re-derived the nonce off `request.headers`, but
  // `new Headers(request.headers)` is a COPY — the original NextRequest never
  // saw the mutation, so the CSP advertised one nonce while React stamped a
  // different one onto its bootstrap scripts. Result: CSP blocked every page.
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
    // The desktop WKWebView may retain its Tauri custom-protocol origin after it
    // navigates to the private loopback server. Those exact app-owned origins
    // are included above; arbitrary websites must never receive a blanket
    // desktop bypass because they can still send simple requests to localhost.
    const expected = expectedAppOrigins(request);
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
