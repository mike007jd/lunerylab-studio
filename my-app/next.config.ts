import path from "node:path";
import type { NextConfig } from "next";
import { buildCsp } from "./lib/csp";

const projectRoot = path.resolve(__dirname, "..");

// Native bindings + Prisma engines + sharp's libvips, force-included so the
// standalone bundle is self-contained (Next's tracer misses `require(absPath)`
// loads from generated code).
const nativeBindingIncludes = [
  "../node_modules/.prisma/client/**/*",
  "../node_modules/@prisma/client/**/*",
  "../node_modules/@prisma/engines/**/*",
  "../node_modules/sharp/build/Release/**/*",
  "../node_modules/@img/**/*",
];

// Static (nonce-less) CSP fallback. HTML-bearing routes get a per-request nonce
// variant from `proxy.ts`; this ships on static assets, error pages, and any
// response the proxy didn't touch. Both are built from `lib/csp.ts` so the
// directive lists can't diverge.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: buildCsp(),
  },
  {
    key: "X-DNS-Prefetch-Control",
    value: "on",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: projectRoot,
  outputFileTracingExcludes: {
    "*": ["data/**/*", "src-tauri/target/**/*", "desktop-dist/**/*"],
    "/**": ["data/**/*", "src-tauri/target/**/*", "desktop-dist/**/*"],
  },
  outputFileTracingIncludes: {
    "*": nativeBindingIncludes,
    "/api/**/*": nativeBindingIncludes,
  },
  turbopack: {
    root: projectRoot,
  },
  images: {
    // Account/OAuth avatars are retired (account-less app); no remote image
    // hosts are needed. Keep the optimizer's allow-list empty so it can't be
    // pointed at arbitrary hosts.
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
