/** A page a bot published to a public link, as its chat card shows it (WireMessage.publishedPage). The message's `text`
 * says the same in words, with the link, for every client that does not draw the card. */
export interface PublishedPageCard {
  /** live: the link works, or may work when `uncertain` is true. unpublished: its owner took it down. limit: the plan's
   * pages are used up, so nothing was published; `message` says so and `upgrade` offers a bigger plan. */
  state: "live" | "unpublished" | "limit";
  /** The upload's answer was lost. The page may be live and can still be unpublished. */
  uncertain?: boolean;
  title: string;
  pageId?: string;
  url?: string;
  /** This account's pages and its plan's limit after this publish, as "3 of 5 pages". */
  usage?: { pages: number; limit: number };
  message?: string;
  upgrade?: boolean;
  /** limit cards: "free" (signed in, no Cloud) or the Cloud plan's tier. */
  plan?: string;
}

/** The MausBot pages Worker's page ids: one DNS label of lowercase letters and digits. */
export const PAGE_ID = /^[a-z0-9]{20,63}$/;

/** What a page's files may be, by extension, and the Content-Type each is served with: the same list as the pages
 * Worker's (openmaus-cloud pages-worker/src/files.ts refuses the rest). */
export const PAGE_FILE_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8", ndjson: "application/x-ndjson; charset=utf-8", md: "text/markdown; charset=utf-8",
  geojson: "application/geo+json", topojson: "application/json; charset=utf-8",
  parquet: "application/vnd.apache.parquet", arrow: "application/vnd.apache.arrow.file", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
export const PAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(PAGE_FILE_TYPES));
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PAGE_MAX_FILES = 200;
