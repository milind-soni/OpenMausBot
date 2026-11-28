/** Safari on iPhone paints its bottom bar from the root scheme and from
 * theme-color. The skin lives in --color-app; the bar has to be told. */

const SURFACE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;

type ThemeColorMeta = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

export type ThemeColorDocument = {
  head: {
    querySelector(selector: string): ThemeColorMeta | null;
    appendChild(node: ThemeColorMeta): void;
  } | null;
  createElement(tag: string): ThemeColorMeta;
};

/** Writes a skin surface onto the theme-color meta. Refuses anything that is
 * not a hex color, so a custom property or an empty read cannot reach Safari. */
export function applyThemeColor(color: string, doc: ThemeColorDocument): boolean {
  const surface = color.trim();
  if (!SURFACE.test(surface) || !doc.head) return false;
  const found = doc.head.querySelector('meta[name="theme-color"]');
  const meta = found ?? doc.createElement("meta");
  if (!found) {
    meta.setAttribute("name", "theme-color");
    doc.head.appendChild(meta);
  }
  meta.setAttribute("content", surface);
  return true;
}

/** Reads the worn skin's app ground and copies it to theme-color. No-ops
 * where there is no computed style, which is the case for the stub document
 * the skin tests install. */
export function syncBrowserChrome(doc: Document = document): void {
  if (typeof getComputedStyle !== "function") return;
  let surface = "";
  try {
    surface = getComputedStyle(doc.documentElement).getPropertyValue("--color-app");
  } catch {
    return;
  }
  // A real head appends any Node; the narrow type is what the tests can fake.
  applyThemeColor(surface, doc as unknown as ThemeColorDocument);
}
