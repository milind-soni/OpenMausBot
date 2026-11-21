// Where an imported sign-in is written: a desktop pane's partition (through the app's main process), or a launched
// Chrome profile (through CDP). Security: a refusal is counted, never described: Chromium's message can quote a value.
import type { CookieSink } from "./importer.ts";
import type { WritableCookie } from "./policy.ts";

const BATCH = 500;

/** A pane's partition: `write` is the app's own `cookies.set`, which counts what it refused. */
export function paneSink(write: (cookies: WritableCookie[]) => Promise<{ written: number; refused: number }>): CookieSink {
  return {
    async write(cookies) {
      let written = 0;
      let refused = 0;
      for (let at = 0; at < cookies.length; at += BATCH) {
        const done = await write(cookies.slice(at, at + BATCH));
        written += done.written;
        refused += done.refused;
      }
      return { written, refused };
    },
  };
}

const CDP_SAME_SITE = { lax: "Lax", strict: "Strict", no_restriction: "None" } as const;

/** CDP's Network.CookieParam: a host-only cookie by its URL, a domain cookie by its domain. */
export function cdpCookie(cookie: WritableCookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain ? { domain: cookie.domain } : { url: cookie.url }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite !== "unspecified" ? { sameSite: CDP_SAME_SITE[cookie.sameSite] } : {}),
    ...(cookie.expirationDate !== undefined ? { expires: cookie.expirationDate } : {}),
  };
}

/** A launched Chrome, through its browser-level `Storage.setCookies`; a batch it refuses is retried cookie by cookie. */
export function cdpSink(send: (method: string, params: Record<string, unknown>) => Promise<unknown>): CookieSink {
  return {
    async write(cookies) {
      let written = 0;
      let refused = 0;
      for (let at = 0; at < cookies.length; at += BATCH) {
        const batch = cookies.slice(at, at + BATCH);
        try {
          await send("Storage.setCookies", { cookies: batch.map(cdpCookie) });
          written += batch.length;
          continue;
        } catch {}
        for (const cookie of batch) {
          try {
            await send("Storage.setCookies", { cookies: [cdpCookie(cookie)] });
            written++;
          } catch {
            refused++;
          }
        }
      }
      return { written, refused };
    },
  };
}
