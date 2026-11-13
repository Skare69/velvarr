import type { NextConfig } from "next";

// ponytail: script/style 'unsafe-inline' is the ceiling for Next App Router
// without a nonce middleware (inline flight-data scripts are part of the
// runtime); upgrade path is nonce-based CSP middleware if ever required.
// Dev only: React dev tooling needs eval, and the impeccable live helper serves
// its overlay script and event stream from localhost:8400.
const dev = process.env.NODE_ENV === "development";
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: `default-src 'self'; script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval' http://localhost:8400" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${dev ? " http://localhost:8400" : ""}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // /app is root-owned and group/other read-only in the container image, so
  // the image optimizer's disk cache (/app/.next/cache/images) can never be
  // created: every /_next/image request logged an unhandledRejection mkdir
  // error and re-encoded with sharp. The app never uses next/image, so turn
  // the endpoint off entirely (unoptimized makes it answer 404;
  // maximumDiskCacheSize 0 skips the eager cache-dir init).
  images: { unoptimized: true, maximumDiskCacheSize: 0 },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
