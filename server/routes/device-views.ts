import { parseDeviceView, type DeviceView } from "../../shared/device-view.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface DeviceViewRouteDeps {
  sessions: Pick<SessionRegistry, "setView">;
  store: Pick<Store, "bot" | "group" | "sections">;
  team: boolean;
}

export const TEAM_VIEW_REFUSAL = "Device views are not available on a Team Cloud: each person's devices see what that person may.";

/** A view names a department by name: one deleted or renamed drops out of every view, so one made again later under that
 * name grants nothing. */
export function keepViewsToDepartments(sessions: Pick<SessionRegistry, "dropMissingSections">, store: Pick<Store, "sections" | "onChange">): void {
  const drop = () => {
    const known = new Set(store.sections);
    sessions.dropMissingSections((name) => known.has(name));
  };
  drop();
  store.onChange((change) => {
    if (change.type === "sections") drop();
  });
}

export function checkedDeviceView(value: unknown, store: DeviceViewRouteDeps["store"], options?: { allowNothing?: boolean }): { ok: true; view: DeviceView | null } | { ok: false; error: string } {
  const parsed = parseDeviceView(value, options);
  if (!parsed.ok || !parsed.view) return parsed;
  const view = parsed.view;
  if (!view.bots.every((id) => store.bot(id))) return { ok: false, error: "no such bot" };
  if (!view.groups.every((id) => store.group(id))) return { ok: false, error: "no such channel" };
  const departments = store.sections;
  if (!view.sections.every((name) => name === "" || departments.includes(name))) {
    return { ok: false, error: "no such department" };
  }
  return parsed;
}

/** The view a new pairing code grants (none when the body names none); a Team Cloud refuses one. */
export function pairingView(value: unknown, store: DeviceViewRouteDeps["store"], team: boolean): { ok: true; view?: DeviceView } | { ok: false; status: number; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (team) return { ok: false, status: 409, error: TEAM_VIEW_REFUSAL };
  const checked = checkedDeviceView(value, store);
  return checked.ok ? { ok: true, ...(checked.view ? { view: checked.view } : {}) } : { ok: false, status: 400, error: checked.error };
}

/** PATCH /api/auth/sessions/:id { view }: limits a paired device (every list empty: it sees nothing), or lifts its limit with null. Admin only; a session cannot
 * limit itself, so an admin cannot lock their own browser out mid-change. */
export function createDeviceViewRoutes(deps: DeviceViewRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
    if (!m || method !== "PATCH") return PASS;
    const body = await readBody(req, 64 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("view" in body) || Object.keys(body).length !== 1) {
      return json(res, 400, { error: "send { view }" });
    }
    if (deps.team) return json(res, 409, { error: TEAM_VIEW_REFUSAL });
    if (auth.kind === "session" && auth.session.id === m[1]) return json(res, 409, { error: "Change this device's view from another device." });
    const checked = checkedDeviceView((body as { view: unknown }).view, deps.store, { allowNothing: true });
    if (!checked.ok) return json(res, 400, { error: checked.error });
    let session: ReturnType<DeviceViewRouteDeps["sessions"]["setView"]>;
    try {
      session = deps.sessions.setView(m[1]!, checked.view);
    } catch (error) {
      const refused = error as { status?: number; code?: string; message?: string };
      if (refused.status !== 403) throw error;
      return json(res, 403, { error: refused.message, code: refused.code });
    }
    return session ? json(res, 200, { session }) : json(res, 404, { error: "no such session" });
  };
}
