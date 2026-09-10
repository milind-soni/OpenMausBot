// The deployment's brand (name, tagline, accent, logo, support link) — served
// by GET /api/brand from a brand.json on the server, applied once before the
// first paint so the window never shows "OpenMausBot" and then renames itself.
// Pure helpers live here so they can be unit-tested without a DOM.

export interface Brand {
  name: string;
  tagline?: string;
  accent?: string;
  logo?: string;
  favicon?: string;
  supportUrl?: string;
}

export interface BrandStatus {
  brand: Brand;
  source: "default" | "file";
  file: string;
  notice?: string;
}

export const DEFAULT_BRAND: Brand = { name: "OpenMausBot" };

let current: BrandStatus = { brand: DEFAULT_BRAND, source: "default", file: "" };

/** The brand in effect. Stable after bootstrap; a changed brand.json needs a reload. */
export function brand(): Brand {
  return current.brand;
}

export function brandStatus(): BrandStatus {
  return current;
}

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Relative luminance (WCAG) of a #rrggbb colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const m = HEX.exec(hex);
  if (!m) return 0;
  const channel = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(m[1]) + 0.7152 * channel(m[2]) + 0.0722 * channel(m[3]);
}

/** Text colour that meets WCAG AA on the given accent: white on dark accents,
 * near-black on light ones. The skin contrast check cannot see a runtime
 * accent, so this is where a customer's colour is kept readable. */
export function accentInk(accent: string): string {
  // contrast vs white = 1.05 / (L + 0.05); vs black = (L + 0.05) / 0.05
  const l = luminance(accent);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#111111";
}

/** CSS custom properties a brand overrides on the root element. */
export function brandVars(b: Brand): Record<string, string> {
  if (!b.accent || !HEX.test(b.accent)) return {};
  return {
    "--color-accent": b.accent,
    "--color-accent-border": b.accent,
    "--color-focus": b.accent,
    "--color-accent-text": b.accent,
    "--color-accent-ink": accentInk(b.accent),
  };
}

/** The MIME type a data: URI declares, for the icon link's `type`. */
export function iconType(href: string): string {
  const match = /^data:(image\/[a-z0-9.+-]+)/i.exec(href);
  return match ? match[1].toLowerCase() : "";
}

let defaultIcon: { href: string; type: string } | null = null;

/** Point the tab icon at the brand's, or back at the app's when there is none. */
function applyIcon(favicon: string | undefined): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  defaultIcon ??= { href: link.getAttribute("href") ?? "", type: link.getAttribute("type") ?? "" };
  const next = favicon ? { href: favicon, type: iconType(favicon) } : defaultIcon;
  link.setAttribute("href", next.href);
  if (next.type) link.setAttribute("type", next.type);
  else link.removeAttribute("type");
  let touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"][data-brand]');
  if (favicon) {
    if (!touch) {
      touch = document.createElement("link");
      touch.rel = "apple-touch-icon";
      touch.dataset.brand = "1";
      document.head.appendChild(touch);
    }
    touch.href = favicon;
  } else touch?.remove();
}

/** Stamp the brand on the document: title, icon and accent variables. */
export function applyBrand(status: BrandStatus): void {
  current = status;
  if (typeof document === "undefined") return;
  document.title = status.brand.name;
  applyIcon(status.brand.favicon);
  const root = document.documentElement;
  for (const name of ["--color-accent", "--color-accent-border", "--color-focus", "--color-accent-text", "--color-accent-ink"]) {
    root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(brandVars(status.brand))) root.style.setProperty(name, value);
}

function isBrandStatus(value: unknown): value is BrandStatus {
  if (!value || typeof value !== "object") return false;
  const v = Reflect.get(value, "brand");
  return Boolean(v) && typeof v === "object" && typeof Reflect.get(Object(v), "name") === "string";
}

/** Fetch and apply the brand before the first paint. Any failure keeps the
 * default: a brand is never worth blocking the app for, so this caps its wait. */
export async function bootstrapBrand(fetchImpl: typeof fetch = fetch, timeoutMs = 1500): Promise<BrandStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("/api/brand", { signal: controller.signal });
    if (!res.ok) return current;
    const body: unknown = await res.json();
    if (isBrandStatus(body)) applyBrand(body);
  } catch {
    /* offline, older server, or too slow: the default brand stands */
  } finally {
    clearTimeout(timer);
  }
  return current;
}
