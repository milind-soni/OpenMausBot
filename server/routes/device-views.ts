import { parseDeviceView, type DeviceView } from "../../shared/device-view.ts";
import { roomMemberMissing, type StreamSeen, type VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { pairingRequest as sessionPairingRequest, type PairingRequest, type SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";
import { userErrorFields } from "../user-errors.ts";
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

/** A session whose streams ended because what it may see changed: reconnecting from before the seq it ended at gets a
 * snapshot, since a replay cannot withdraw or add what it was never sent. */
export function snapshotsAfterViewChanges(sessions: Pick<SessionRegistry, "onSessionChanged" | "onSessionRevoked">, seq: () => number, closeStreams: (sessionId: string) => void) {
  const from = new Map<string, number>();
  sessions.onSessionChanged((sessionId) => {
    from.set(sessionId, seq());
    closeStreams(sessionId);
  });
  sessions.onSessionRevoked((sessionId) => { from.delete(sessionId); });
  const mark = (sessionId: string) => { from.set(sessionId, seq()); };
  return {
    mark,
    from: (sessionId: string) => from.get(sessionId) ?? -1,
    /** A listed room gained or lost a bot this stream knows only as its member: no frame of that bot's own adds or
     * withdraws it, so the stream ends and starts over from a snapshot. */
    roomChanged(payload: Record<string, unknown>, visible: Pick<VisibleSet, "bot" | "group" | "roomOnly">, client: { sessionId?: string; seen: StreamSeen; close(): void }): boolean {
      if (!roomMemberMissing(payload, visible, client.seen)) return false;
      if (client.sessionId) mark(client.sessionId);
      client.close();
      return true;
    },
    /** A device's view also follows departments and room members, which change without an audience change: a limited
     * device, or one whose view changed after `since`, always starts over. */
    startsOver: (auth: RequestAuth, since: number) => auth.kind === "session" && (Boolean(auth.session.view) || since <= (from.get(auth.session.id) ?? -1)),
  };
}

/** What a session holds open ends both when it is revoked and when its view changes, since either can take away what it shows. */
export function onSessionLosesAccess(sessions: Pick<SessionRegistry, "onSessionChanged" | "onSessionRevoked">, end: (sessionId: string) => void): void {
  sessions.onSessionRevoked(end);
  sessions.onSessionChanged(end);
}

/** The live side of device views: snapshots after a view changes, and views kept to the departments that exist. */
export function deviceViewStreams(sessions: Pick<SessionRegistry, "onSessionChanged" | "onSessionRevoked" | "dropMissingSections">, store: Pick<Store, "sections" | "onChange">, seq: () => number, closeStreams: (sessionId: string) => void) {
  const snapshots = snapshotsAfterViewChanges(sessions, seq, closeStreams);
  keepViewsToDepartments(sessions, store);
  return snapshots;
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
/** POST /api/auth/pairing's body as openPairing takes it: what sessions.ts reads of it, and the view it limits the device to. */
export function pairingRequest(body: unknown, store: DeviceViewRouteDeps["store"], team: boolean):
  { ok: true; pairing: PairingRequest & { view?: DeviceView } } | { ok: false; status: number; error: string } {
  const requested = sessionPairingRequest(body);
  if ("error" in requested) return { ok: false, status: 400, error: requested.error };
  const view = pairingView(body && typeof body === "object" ? (body as { view?: unknown }).view : undefined, store, team);
  if (!view.ok) return view;
  return { ok: true, pairing: { ...requested, ...(view.view ? { view: view.view } : {}) } };
}

/** POST /api/auth/pairing: the request read, then the pairing opened. A personal Cloud home refuses to pair a device. */
export function openDevicePairing(body: Parameters<typeof pairingRequest>[0], sessions: Pick<SessionRegistry, "openPairing">, store: DeviceViewRouteDeps["store"], team: boolean):
  { ok: true; opened: ReturnType<SessionRegistry["openPairing"]> } | { ok: false; status: number; error: string; code?: string } & ReturnType<typeof userErrorFields> {
  const request = pairingRequest(body, store, team);
  if (!request.ok) return request;
  try {
    return { ok: true, opened: sessions.openPairing(request.pairing) };
  } catch (error) {
    if ((error as { code?: unknown }).code === "cloud_personal") return { ok: false, status: 403, error: (error as Error).message, code: "cloud_personal", ...userErrorFields(error) };
    throw error;
  }
}

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
