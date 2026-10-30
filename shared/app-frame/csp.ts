// An app frame's Content-Security-Policy leads its srcdoc; phones also enforce `network` at the network layer.
// Bot HTML: three package CDNs (and Google Fonts for styles and fonts), none of which shows a requester's URLs
// to a third party, and no images from arbitrary hosts, so no tracking pixels.
// MCP apps: the MCP Apps construction from `_meta.ui.csp` resourceDomains (R) and connectDomains (C), after
// the host's filter. frameDomains and baseUriDomains are ignored, a further restriction the MCP Apps spec allows.

export const BOT_HTML_CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"] as const;
const FONT_STYLES = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

export const BOT_HTML_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${BOT_HTML_CDNS.join(" ")}`,
  `style-src 'unsafe-inline' ${BOT_HTML_CDNS.join(" ")} ${FONT_STYLES}`,
  `font-src data: ${BOT_HTML_CDNS.join(" ")} ${FONT_FILES}`,
  `img-src data: blob: ${BOT_HTML_CDNS.join(" ")}`,
  "media-src data: blob:",
  `connect-src ${BOT_HTML_CDNS.join(" ")}`,
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "manifest-src 'none'",
].join("; ");

export const BOT_HTML_NETWORK: { connect: string[]; resources: string[] } = {
  connect: [...BOT_HTML_CDNS],
  resources: [...BOT_HTML_CDNS, FONT_STYLES, FONT_FILES],
};

/** DuckDB-WASM fetches its readers, Parquet's among them, from here when a query first needs one. */
const DUCKDB_EXTENSIONS = "https://extensions.duckdb.org";

/** A web origin, scheme and host (and port) only, or null. */
export function webOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

/** A folder page: the bot-page policy, plus its own files under `files` (the token route's folder URL, ending in "/",
 * which is also its base) and DuckDB's readers. Security: the path keeps the page off the rest of the app's own
 * origin, its API included. */
export function folderPageCsp(files: string): string {
  const add = (directive: string, extra: string) => directive.replace(/^([a-z-]+) (.*)$/, `$1 $2 ${extra}`);
  return BOT_HTML_CSP.split("; ").map((directive) => {
    if (/^(script|style|font|img|media)-src /.test(directive)) return add(directive, files);
    if (directive.startsWith("connect-src ")) return add(directive, `${files} ${DUCKDB_EXTENSIONS}`);
    if (directive === "base-uri 'none'") return `base-uri ${files}`;
    return directive;
  }).join("; ");
}

export function folderPageNetwork(files: string): { connect: string[]; resources: string[] } {
  return { connect: [...BOT_HTML_NETWORK.connect, files, DUCKDB_EXTENSIONS], resources: [...BOT_HTML_NETWORK.resources, files] };
}

export const APP_DOMAIN_LIMIT = 16;
const REFUSED_SHOWN_CHARS = 120;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Two or more DNS labels; an IPv4 address passes too. */
const DOTTED_HOST = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
const PORT = /^(?:[1-9]\d{0,4})$/;

export interface AppDomainFilter {
  websockets: boolean;
  /** Keeps http://localhost and http://127.0.0.1 (any port): only for a command or loopback MCP server. */
  loopback: boolean;
}

export interface FilteredDomains {
  kept: string[];
  refused: string[];
}

/** Refuses a path, a query, a fragment, a quote, a semicolon, a comma or whitespace, `*` alone, a wildcard
 * anywhere but the leftmost label, userinfo, and a host without a dot (outside the loopback rule). */
export function normalizeAppDomain(entry: string, filter: AppDomainFilter): string | null {
  if (entry.length > 300 || /[\s'";,\\]/.test(entry)) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]+?)(?::(\d+))?\/?$/i.exec(entry);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  const port = match[3];
  if (port !== undefined && (!PORT.test(port) || Number(port) > 65535)) return null;
  const suffix = port !== undefined ? `:${port}` : "";
  if (scheme === "http") {
    if (!filter.loopback || (host !== "localhost" && host !== "127.0.0.1")) return null;
    return `http://${host}${suffix}`;
  }
  if (scheme !== "https" && !(scheme === "wss" && filter.websockets)) return null;
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  // `*.example.com` keeps a dotted host after the star; `*.com` does not.
  if (!DOTTED_HOST.test(bare)) return null;
  return `${scheme}://${host}${suffix}`;
}

export function filterAppDomains(list: unknown, filter: AppDomainFilter): FilteredDomains {
  const kept: string[] = [];
  const refused: string[] = [];
  if (!Array.isArray(list)) return { kept, refused };
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const normal = normalizeAppDomain(entry, filter);
    if (normal && kept.includes(normal)) continue;
    if (normal && kept.length < APP_DOMAIN_LIMIT) kept.push(normal);
    else {
      const shown = [...entry].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("").trim();
      refused.push(shown.length > REFUSED_SHOWN_CHARS ? `${shown.slice(0, REFUSED_SHOWN_CHARS - 1)}…` : shown);
    }
  }
  return { kept, refused };
}

/** No `'self'`: the frame's origin is opaque. */
export function mcpAppCsp(network: { connect: readonly string[]; resources: readonly string[] }): string {
  const R = network.resources.length ? ` ${network.resources.join(" ")}` : "";
  const C = network.connect.length ? network.connect.join(" ") : "'none'";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'${R}`,
    `style-src 'unsafe-inline'${R}`,
    `font-src data:${R}`,
    `img-src data: blob:${R}`,
    `media-src data: blob:${R}`,
    `connect-src ${C}`,
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function mcpAppNetwork(csp: unknown, loopbackServer: boolean): { csp: string; network: { connect: string[]; resources: string[]; refused?: string[] } } {
  const record = csp && typeof csp === "object" && !Array.isArray(csp) ? csp as Record<string, unknown> : {};
  const connect = filterAppDomains(record.connectDomains, { websockets: true, loopback: loopbackServer });
  const resources = filterAppDomains(record.resourceDomains, { websockets: false, loopback: loopbackServer });
  const refused = [...connect.refused, ...resources.refused];
  const network = { connect: connect.kept, resources: resources.kept, ...(refused.length ? { refused } : {}) };
  return { csp: mcpAppCsp(network), network };
}
