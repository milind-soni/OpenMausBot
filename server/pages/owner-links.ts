// The URL an owner-only page loads from inside its sandboxed frame. Its sandbox gives the page an opaque origin, which
// sends no session cookie with the page's own files, so the open page's files carry a token instead: minted only for an
// owner who opened the page's stable link, for that page and that viewer, and dropped after a day unused. A token is
// therefore a bearer for one page; the stable link itself never carries one.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { BOT_HTML_CSP } from "../../shared/app-frame/csp.ts";
import { PAGE_FILE_TYPES } from "../../shared/published-page.ts";
import { pageFilePath } from "../page-files.ts";
import { requestOrigin } from "../request-auth.ts";
import type { PublishedPageFiles } from "./owner-files.ts";

export const OWNER_PAGE_FILES_PREFIX = "/api/owner-page-files/";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60_000;
const MAX_TOKENS = 2_000;

/** An owner-only page opened directly: its own files load, inline code runs, and it stays in an opaque origin, so it can
 * reach neither the app's cookies nor its API. */
export function ownerPageCsp(origin: string): string {
  return BOT_HTML_CSP.split("; ").map((directive) => {
    if (/^(script|style|font|img|media|connect|worker)-src /.test(directive)) return `${directive} ${origin}`;
    return directive === "default-src 'none'" ? `default-src ${origin}` : directive;
  }).join("; ").concat("; sandbox allow-scripts allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation");
}

/** Who a token was minted for: `key` names them, and `allowed()` is asked again on every file. */
export interface OwnerPageViewer {
  key: string;
  allowed(): boolean;
}

export function createOwnerPageLinks(deps: {
  files: Pick<PublishedPageFiles, "read">;
  /** True while the page is still an owner-only page this server keeps. */
  ownerPage(pageId: string): boolean;
  now?(): number;
}) {
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, { pageId: string; viewer: string; allowed?: () => boolean; used: number }>();
  const byViewer = new Map<string, string>();
  const keyOf = (pageId: string, viewer: string) => `${pageId}\n${viewer}`;
  const forget = (token: string) => {
    const known = tokens.get(token);
    tokens.delete(token);
    if (known) byViewer.delete(keyOf(known.pageId, known.viewer));
  };
  const answer = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    res.end(text);
  };

  return {
    /** The folder URL this viewer's copy of the page loads from; the same token while it is in use. */
    folder(pageId: string, viewer: OwnerPageViewer): string {
      const at = now();
      for (const [token, known] of tokens) if (at - known.used > DAY_MS) forget(token);
      const existing = byViewer.get(keyOf(pageId, viewer.key));
      if (existing) {
        tokens.set(existing, { pageId, viewer: viewer.key, allowed: viewer.allowed, used: at });
        return `${OWNER_PAGE_FILES_PREFIX}${existing}/`;
      }
      while (tokens.size >= MAX_TOKENS) forget(tokens.keys().next().value!);
      const token = randomBytes(32).toString("base64url");
      tokens.set(token, { pageId, viewer: viewer.key, allowed: viewer.allowed, used: at });
      byViewer.set(keyOf(pageId, viewer.key), token);
      return `${OWNER_PAGE_FILES_PREFIX}${token}/`;
    },

    /** True when the request was this route's. */
    serve(req: IncomingMessage, res: ServerResponse, path: string, method: string): boolean {
      if (!path.startsWith(OWNER_PAGE_FILES_PREFIX)) return false;
      const rest = path.slice(OWNER_PAGE_FILES_PREFIX.length), slash = rest.indexOf("/");
      const token = slash === -1 ? rest : rest.slice(0, slash);
      if (method !== "GET" && method !== "HEAD") {
        answer(res, 405, "Read only.");
        return true;
      }
      const target = TOKEN.test(token) ? tokens.get(token) : undefined;
      if (!target || now() - target.used > DAY_MS || slash === -1 || (target.allowed && !target.allowed()) || !deps.ownerPage(target.pageId)) {
        answer(res, 404, "Not found.");
        return true;
      }
      target.used = now();
      const file = pageFilePath(rest.slice(slash + 1));
      if (file === null) {
        answer(res, 400, "Not a file of this page.");
        return true;
      }
      const body = deps.files.read(target.pageId, file);
      if (!body) {
        answer(res, 404, "Not found.");
        return true;
      }
      res.writeHead(200, {
        "content-type": PAGE_FILE_TYPES[extname(file).slice(1).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(body.byteLength),
        "content-security-policy": ownerPageCsp(requestOrigin(req) ?? "http://127.0.0.1"),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
        "access-control-allow-origin": "*",
      });
      res.end(method === "HEAD" ? undefined : body);
      return true;
    },
  };
}
export type OwnerPageLinks = ReturnType<typeof createOwnerPageLinks>;
