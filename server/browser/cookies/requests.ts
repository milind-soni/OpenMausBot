// The person's sign-in imports, as the app's own window asks for them: which browsers, whether a site can be imported
// for a bot, and the import itself. They arrive only through the desktop app's main process, never over HTTP, so a
// bot's shell cannot start one; the main process takes them from the app window's top page only.
import type { CookieImportResult, CookieSource } from "../../../electron/browser-pane-wire.mjs";
import type { CookieRequests } from "../pane/link.ts";
import { importCookies, type CookieSink } from "./importer.ts";
import { googleCookie, importSite } from "./policy.ts";
import { listSources, type BrowserFiles, type KeyStore } from "./sources.ts";

export interface CookieRequestDeps {
  files(): BrowserFiles;
  keys(): KeyStore;
  /** A 0700 folder of the app's own for copies of another browser's database. */
  scratch: string;
  /** Where a bot's browser takes an import, or null where it takes none (temporary, My Chrome, or not this engine's). */
  destination(botId: string, threadId: string | null): CookieSink | null;
  log?(line: string): void;
}

export function cookieRequests(deps: CookieRequestDeps): CookieRequests {
  return {
    async sources(): Promise<CookieSource[]> {
      return listSources(deps.files());
    },
    async offer({ botId, threadId, site }) {
      const domain = importSite(site);
      if (!domain) return { offered: false, reason: "not-a-site" };
      if (googleCookie(domain, "")) return { offered: false, reason: "google" };
      return deps.destination(botId, threadId) ? { offered: true } : { offered: false, reason: "no-destination" };
    },
    async import({ botId, threadId, site, source, profile }): Promise<CookieImportResult> {
      const sink = deps.destination(botId, threadId);
      if (!sink) return { ok: false, reason: "no-destination" };
      return importCookies({ files: deps.files(), keys: deps.keys(), scratch: deps.scratch, source, profile, site, sink, ...(deps.log ? { log: deps.log } : {}) });
    },
  };
}
