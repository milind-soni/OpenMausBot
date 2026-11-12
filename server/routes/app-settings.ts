import { isWindowPrefId, WINDOW_PREFS, windowPrefReportSchema, type WindowPrefId } from "../../shared/app-settings.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const INTERNAL_APP_SETTINGS_PATH = "/api/internal/app-settings";
export const WINDOW_PREFS_PATH = "/api/window-prefs";

/** Only dispatch inside the internal capability gate, with its guarded body reader; never in the global route table. */
export function createInternalAppSettingsRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  handle(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== INTERNAL_APP_SETTINGS_PATH) return PASS;
    const result = await deps.handle(await deps.readBody());
    return json(res, result.status, result.body);
  };
}

/** The window's own preferences (skin, Simple or Advanced, font, chat width, send key, sounds) live in its
 * localStorage. The window reports them here; the server keeps the last report and pushes a change back as a
 * `window-pref` frame, which only an open window can apply. */
export function createWindowPrefs(deps: {
  broadcast(frame: Record<string, unknown>, options: { adminOnly: true }): void;
  ownerOrAdmin(auth: RequestAuth): boolean;
  /** An owner's app window holds its live event stream open now. */
  windowOpen(): boolean;
}) {
  const values = new Map<WindowPrefId, unknown>();
  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    if (method !== "PUT" || path !== WINDOW_PREFS_PATH) return PASS;
    if (!deps.ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner's window reports its preferences." });
    const parsed = windowPrefReportSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "values must be an object of preference id to value" });
    for (const [id, value] of Object.entries(parsed.data.values)) {
      if (isWindowPrefId(id) && WINDOW_PREFS[id].safeParse(value).success) values.set(id, value);
    }
    return json(res, 200, { ok: true });
  };
  return {
    routes,
    read: (id: WindowPrefId) => values.get(id),
    write(id: WindowPrefId, value: unknown): string | null {
      if (!deps.windowOpen()) return "Open MausBot on this computer first; this setting lives in the app window.";
      values.set(id, value);
      deps.broadcast({ kind: "window-pref", id, value }, { adminOnly: true });
      return null;
    },
  };
}
