// Single source of truth for the Content-Security-Policy directive list.
//
// Two callers consume it:
//   - `next.config.ts` — the static fallback (no nonce) that ships on static
//     assets, error pages, and any response the proxy didn't touch.
//   - `proxy.ts` — the per-request variant that adds a script nonce
//     (+ `'strict-dynamic'`) while allowing style attributes needed by the UI.
//
// Keeping both in one builder means a directive change (a new connect-src host,
// etc.) can't silently diverge between the nonce'd HTML responses and the
// static-asset fallback.
//
// Notes:
//   - NO `upgrade-insecure-requests` — it would break the http loopback server.
//   - loopback hosts are allowed in img/connect for the desktop WebView.
export interface CspOptions {
  /**
   * Extra `frame-src` origins allowed for this response. Used by the /comfy
   * workspace, which embeds the user's own ComfyUI frontend in an iframe.
   * Origins must already be validated endpoints — the builder does not parse
   * them, it only quotes them into the directive.
   */
  frameSrcOrigins?: string[];
}

export function buildCsp(nonce?: string, options: CspOptions = {}): string {
  // Next dev overlay uses eval for stack reconstruction. Keep that local to
  // development; production script CSP stays nonce/strict-dynamic only.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`
    : `script-src 'self'${devEval}`;
  // React, Radix, Konva, and local design-system components use style
  // attributes for CSS variables, geometry, and transforms. A style nonce makes
  // browsers ignore `'unsafe-inline'`, so style-src intentionally stays simple.
  // Script CSP remains nonce-based.
  const styleSrc = "style-src 'self' 'unsafe-inline'";
  const frameSrc =
    options.frameSrcOrigins && options.frameSrcOrigins.length > 0
      ? `frame-src 'self' ${options.frameSrcOrigins.join(" ")}`
      : undefined;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    scriptSrc,
    styleSrc,
    ...(frameSrc ? [frameSrc] : []),
    "img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
  ].join("; ");
}
