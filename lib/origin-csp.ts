type Environment = Record<string, string | undefined>;

function checkedOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("CSP destinations must be HTTPS origins or HTTP loopback origins");
  return url.origin;
}

/** Convex serves HTTP actions (uploads, integrations) from the matching .convex.site origin. */
function convexSiteUrl(environment: Environment, convexUrl: string): string | undefined {
  if (environment.NEXT_PUBLIC_CONVEX_SITE_URL) return environment.NEXT_PUBLIC_CONVEX_SITE_URL;
  const cloud = new URL(convexUrl);
  if (cloud.hostname.endsWith(".convex.cloud")) return `${cloud.protocol}//${cloud.hostname.replace(/\.convex\.cloud$/, ".convex.site")}`;
  return undefined;
}

export function originCsp(environment: Environment = {}, nonce?: string): string {
  const origin = checkedOrigin(environment.ORIGIN_PUBLIC_URL || environment.ORIGIN_URL || "http://localhost:3000");
  const convexUrl = environment.NEXT_PUBLIC_CONVEX_URL || "http://127.0.0.1:3210";
  const convex = checkedOrigin(convexUrl);
  const site = convexSiteUrl(environment, convexUrl);
  const convexSite = site ? [checkedOrigin(site)] : [];
  const extra = (environment.ORIGIN_CSP_CONNECT_ORIGINS || "").split(/\s+/).filter(Boolean).map(checkedOrigin);
  const destinations = [...new Set([origin, convex, ...convexSite, ...extra])];
  const sockets = destinations.map(value => value.replace(/^http/, "ws"));
  const drawingFonts = "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/";
  if (nonce && !/^[A-Za-z0-9+/_=-]+$/.test(nonce)) throw new Error("Invalid CSP nonce");
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${environment.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}${nonce ? ` 'nonce-${nonce}'` : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${destinations.join(" ")} ${sockets.join(" ")} ${drawingFonts}`,
    `img-src 'self' data: blob: ${destinations.join(" ")}`,
    `font-src 'self' data: ${origin} ${drawingFonts}`,
    `media-src 'self' blob: ${destinations.join(" ")}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
