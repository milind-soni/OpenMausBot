import { createReadStream } from "node:fs";
import { z } from "zod";

import { SKIN_IDS } from "../../shared/app-settings.ts";
import { THEME_ID, THEME_LIMITS, themeExportSchema, themeFileSchema } from "../../shared/theme.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { isRefusal, type ThemeStore } from "./store.ts";

const THEME_PATH = /^\/api\/themes\/([a-z0-9][a-z0-9-]{0,47})(\/duplicate|\/export)?$/;
const ASSET_PATH = /^\/api\/theme-assets\/([a-z0-9][a-z0-9-]{0,47})\/([a-z0-9][a-z0-9._-]{0,99})$/;
const IMPORT_LIMIT = Math.ceil(THEME_LIMITS.themeBytes * 1.4) + THEME_LIMITS.cssChars * 4 + 100_000;

const activeBody = z.object({ id: z.string().regex(THEME_ID).nullable(), skin: z.enum([...SKIN_IDS, "system"]).optional() }).strict();
const saveBody = z.object({ theme: themeFileSchema }).strict();
const nameBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();

export interface ThemeRoutesDeps {
  store: ThemeStore;
  /** Whose themes a request reaches: the workspace's owner on their own server, each signed-in person on a Team Cloud; null for no one. */
  person(auth: RequestAuth): string | null;
  /** Tells that person's open windows to load their theme again, and to wear `skin` when given. */
  changed(person: string, skin?: string): void;
}

export function createThemeRoutes(deps: ThemeRoutesDeps): RouteHandler {
  const { store } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const asset = method === "GET" || method === "HEAD" ? ASSET_PATH.exec(path) : null;
    if (!asset && path !== "/api/themes" && !path.startsWith("/api/themes/")) return PASS;
    const person = deps.person(auth);
    if (!person) return json(res, 403, { error: "Themes belong to a signed-in person." });

    if (asset) {
      const file = store.asset(person, asset[1]!, asset[2]!);
      if (!file) return json(res, 404, { error: "No such theme file." });
      const etag = `"${file.bytes.toString(36)}-${Math.floor(file.mtimeMs).toString(36)}"`;
      // Security: an SVG opened on its own would run as a page of this origin; sandboxed with nothing allowed, it cannot.
      const headers = {
        "Content-Type": file.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache", ETag: etag,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
      };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "Content-Length": String(file.bytes) });
      if (method === "HEAD") return void res.end();
      createReadStream(file.path).pipe(res);
      return;
    }

    if (path === "/api/themes" && method === "GET") return json(res, 200, store.list(person));
    if (path === "/api/themes/active") {
      if (method === "GET") {
        const id = store.active(person);
        return json(res, 200, { id, theme: id ? store.read(person, id) : null });
      }
      if (method !== "PUT") return json(res, 405, { error: "GET or PUT" });
      const parsed = activeBody.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "id must be a saved theme's id or null" });
      const refusal = store.setActive(person, parsed.data.id);
      if (refusal) return json(res, 404, { error: refusal.refusal });
      deps.changed(person, parsed.data.skin);
      return json(res, 200, { ok: true });
    }
    if (path === "/api/themes/import" && method === "POST") {
      const parsed = themeExportSchema.safeParse(await readBody(req, IMPORT_LIMIT));
      if (!parsed.success) return json(res, 400, { error: "This is not a MausBot theme file." });
      const imported = store.importTheme(person, parsed.data);
      return isRefusal(imported) ? json(res, 400, { error: imported.refusal }) : json(res, 200, imported);
    }

    const match = THEME_PATH.exec(path);
    if (!match) return json(res, 404, { error: "No such theme route." });
    const id = match[1]!;
    if (match[2] === "/export" && method === "GET") {
      const data = store.exportTheme(person, id);
      return data ? json(res, 200, data) : json(res, 404, { error: "No such theme." });
    }
    if (match[2] === "/duplicate" && method === "POST") {
      const parsed = nameBody.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "name is required" });
      const copy = store.duplicate(person, id, parsed.data.name);
      return isRefusal(copy) ? json(res, 400, { error: copy.refusal }) : json(res, 200, copy);
    }
    if (match[2]) return json(res, 405, { error: "Method not allowed." });
    if (method === "GET") {
      const theme = store.read(person, id);
      return theme ? json(res, 200, { id, theme }) : json(res, 404, { error: "No such theme." });
    }
    if (method === "PUT") {
      const parsed = saveBody.safeParse(await readBody(req, THEME_LIMITS.cssChars * 4 + 50_000));
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      const refusal = store.save(person, id, parsed.data.theme);
      if (refusal) return json(res, 400, { error: refusal.refusal });
      if (store.active(person) === id) deps.changed(person);
      return json(res, 200, { ok: true });
    }
    if (method === "PATCH") {
      const parsed = nameBody.safeParse(await readBody(req));
      const theme = store.read(person, id);
      if (!parsed.success || !theme) return json(res, parsed.success ? 404 : 400, { error: parsed.success ? "No such theme." : "name is required" });
      const refusal = store.save(person, id, { ...theme, name: parsed.data.name });
      if (refusal) return json(res, 400, { error: refusal.refusal });
      return json(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      const wasActive = store.active(person) === id;
      store.remove(person, id);
      if (wasActive) deps.changed(person);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: "Method not allowed." });
  };
}
