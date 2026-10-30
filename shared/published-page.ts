/** A page a bot published to a public link, as its chat card shows it (WireMessage.publishedPage). The message's `text`
 * says the same in words, with the link, for every client that does not draw the card. */
export interface PublishedPageCard {
  /** live: the link works. unpublished: its owner took it down. limit: the plan's pages are used up, so nothing was
   * published; `message` says so and `upgrade` offers a bigger plan. */
  state: "live" | "unpublished" | "limit";
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

/** What a page's files may be, as the pages Worker serves them (openmaus-cloud pages-worker/src/files.ts refuses the rest). */
export const PAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "html", "htm", "css", "js", "mjs", "json", "txt", "csv", "md", "parquet", "arrow",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf",
]);
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PAGE_MAX_FILES = 200;
