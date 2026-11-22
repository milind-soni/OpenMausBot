// One import: a site's cookies from a profile of another browser, into a bot's browser. Started only by the person,
// one site at a time. Security: the result, every log line and every error carry counts and reason codes only, never a
// cookie, a value or a key.
import { googleCookie, importSite as siteOf, writable, type SkipReason, type WritableCookie } from "./policy.ts";
import { readChromium, readFirefox, readSafari, type SiteRead } from "./readers.ts";
import { chromiumKey, KeyUnavailable, locate, type BrowserFiles, type KeyStore } from "./sources.ts";

/** Why nothing was imported, as a code the app words for the person. */
export type ImportRefusal =
  /** Not a site: an address with no registrable domain, a public suffix or a shared hosting suffix. */
  | "not-a-site"
  /** Google ties its sign-in to the browser it was made in; it is never copied. */
  | "google"
  /** That browser or profile is not here (any more). */
  | "no-source"
  /** The person turned down the system's request for the browser's key (macOS Keychain). */
  | "key-denied"
  /** Safari's cookies need Full Disk Access for this app (System Settings → Privacy & Security). */
  | "full-disk-access"
  /** Chrome's app-bound encryption on Windows: only that browser can read them; My Chrome is the way. */
  | "app-bound"
  /** The browser holds its file without sharing while it runs (Windows); quit it and try again. */
  | "locked"
  /** The browser's files could not be read. */
  | "unreadable"
  /** No sign-in for that site in that profile. */
  | "nothing-found"
  /** This bot's browser takes no imported sign-in (temporary, or the person's own Chrome). */
  | "no-destination";

export type ImportResult =
  | { ok: true; site: string; imported: number; sessionOnly: number; skipped: Partial<Record<SkipReason | "protected" | "failed" | "refused", number>> }
  | { ok: false; reason: ImportRefusal };

/** Where the cookies go: the pane's partition through the app, or a launched Chrome through CDP. */
export interface CookieSink {
  write(cookies: WritableCookie[]): Promise<{ written: number; refused: number }>;
}

export interface ImportRequest {
  files: BrowserFiles;
  keys: KeyStore;
  /** A 0700 folder of the app's own for the copies of the other browser's database. */
  scratch: string;
  source: string;
  profile: string;
  site: string;
  sink: CookieSink;
  now?: number;
  log?: (line: string) => void;
}

/** The key store answered no key: the person turned its prompt down, or it holds none. */
class KeyDenied extends Error {}

let running: Promise<unknown> = Promise.resolve();

/** One import at a time: copies of another browser's database never sit side by side. */
export function importCookies(request: ImportRequest): Promise<ImportResult> {
  const next = running.then(() => run(request), () => run(request));
  running = next.catch(() => undefined);
  return next;
}

async function run(request: ImportRequest): Promise<ImportResult> {
  const refused = (reason: ImportRefusal): ImportResult => {
    request.log?.(`cookie import: ${request.source} refused: ${reason}`);
    return { ok: false, reason };
  };
  const site = siteOf(request.site);
  if (!site) return refused("not-a-site");
  if (googleCookie(site, "")) return refused("google");
  const located = await locate(request.files, request.source, request.profile);
  if (!located) return refused("no-source");
  let read: SiteRead | null;
  try {
    if (located.source.engine === "safari") read = await readSafari(located.profile.cookies, site);
    else if (located.source.engine === "firefox") read = await readFirefox(located.profile.directory, request.scratch, site);
    else read = await readChromium(located.profile.cookies, request.scratch, site, () => chromiumKey(request.files, located, request.keys).catch((error: unknown) => {
      throw error instanceof KeyUnavailable ? error : new KeyDenied();
    }));
  } catch (error) {
    return refused(failure(error, located.source.engine));
  }
  if (!read) return refused("unreadable");
  const now = request.now ?? Date.now() / 1000;
  const skipped: Partial<Record<SkipReason | "protected" | "failed" | "refused", number>> = {};
  const count = (reason: SkipReason | "protected" | "failed" | "refused", by = 1) => { if (by) skipped[reason] = (skipped[reason] ?? 0) + by; };
  count("protected", read.protected);
  count("failed", read.failed);
  const cookies: WritableCookie[] = [];
  for (const cookie of read.cookies) {
    const mapped = writable(cookie, now);
    if ("skip" in mapped) count(mapped.skip);
    else cookies.push(mapped);
  }
  if (!cookies.length && read.cookies.length === 0) {
    if (read.protected > 0) return refused("app-bound");
    // Values that would not decrypt: a wrong or changed key, not a site without a sign-in.
    if (read.failed > 0) return refused("unreadable");
  }
  if (!cookies.length) return refused("nothing-found");
  const written = await request.sink.write(cookies);
  count("refused", written.refused);
  const sessionOnly = cookies.filter((cookie) => cookie.expirationDate === undefined).length;
  request.log?.(`cookie import: ${request.source} wrote ${written.written} of ${cookies.length}`);
  return { ok: true, site, imported: written.written, sessionOnly, skipped };
}

function failure(error: unknown, engine: string): ImportRefusal {
  if (error instanceof KeyUnavailable) return "unreadable";
  if (error instanceof KeyDenied) return "key-denied";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EBUSY") return "locked";
  if (code === "EPERM" || code === "EACCES") return engine === "safari" ? "full-disk-access" : "unreadable";
  if (code === "ENOENT") return "no-source";
  return "unreadable";
}
