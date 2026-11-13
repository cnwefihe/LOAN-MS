import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Origin-Agent-Cluster", value: "?1" },
];

/** Pages get a policy with a fresh script nonce from src/proxy.ts; this one covers files and API responses. */
const apiPolicy = {
  key: "Content-Security-Policy",
  value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // No source maps in the browser, so the original code is not published.
  productionBrowserSourceMaps: false,
  // Hide the floating development badge; build and runtime errors are still shown.
  devIndicators: false,
  // Lets the browser-test server build alongside a running dev server (see playwright.config.ts).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Self-contained server bundle for the container image (see Dockerfile).
  output: "standalone",
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "exceljs", "@azure/msal-node", "@azure/storage-blob", "@azure/identity"],
  experimental: {
    // Above the highest "Maximum upload size" an administrator can set (25 MB), with room for the form.
    serverActions: { bodySizeLimit: "27mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [apiPolicy] },
      // Browsers must always check for a new service worker.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
};

export default nextConfig;
