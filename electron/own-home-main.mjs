// The one-time move that makes a server of the person's own their only home, as My Cloud is: chosen once on that server's
// circle ("Make … my home"), then run by one-home.mjs over cloud-send.mjs, which carry everything, stop this computer for
// good and switch on there what was on here, so no routine ever runs in two places. Every pass goes over this window's own
// sign-in at that server, as the person's: never a sign-in of its own, and never signed out here.
//
// Security: only a server that says this sign-in is its one owner's (server/own-home.ts) is ever chosen or written to, and
// the choice is bound to that server's identity, so another server behind the same address takes nothing of this
// computer's and is never lent it.
import { createCloudSend } from "./cloud-send.mjs";
import { freezeAnswer } from "./one-home-main.mjs";
import { awayIn, createOneHome, parseJournal } from "./one-home.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ORIGIN = /^https?:\/\/[^/\s]+$/u;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** How long a server's word on who owns it is kept for the rail. */
export const OWNER_KNOWN_MS = 10 * 60_000;
/** A chosen move that could not begin (this computer's server did not answer) looks again this often. */
const START_RETRY_MS = 30_000;

const tagged = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

async function answer(response) {
  const text = await response.text();
  try { return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }; }
  catch { return { ok: response.ok, status: response.status, body: null }; }
}

/** The person's choice of home, read back; null when there is none or it is damaged. */
export function parseChoice(value) {
  if (!record(value) || value.v !== 1 || typeof value.id !== "string" || typeof value.origin !== "string" || !ORIGIN.test(value.origin)
    || typeof value.environmentId !== "string" || !ENVIRONMENT_ID.test(value.environmentId) || typeof value.name !== "string" || !value.name.trim()) return null;
  return value;
}

/** A saved place that is a server the person connected by hand: never This computer, My Cloud or a team's Cloud. */
export const handSaved = (entry) => record(entry) && entry.kind === "remote" && typeof entry.origin === "string" && !entry.home && !entry.team && !entry.cloud;

/**
 * This window's sign-in at a server, as one request after another: the session cookie, same-origin. `who()` is that
 * server's word on it: its identity, and whether it is this person's own.
 * @param {{ origin: string }} place
 * @param {typeof fetch} fetchImpl
 */
export function serverRequests(place, fetchImpl) {
  const request = (method, route, init = {}) => fetchImpl(`${place.origin}${route}`, {
    method, redirect: "error", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(120_000), ...init,
    headers: { accept: "application/json", origin: place.origin, ...init.headers },
  });
  return {
    request,
    call: async (method, route, body) => answer(await request(method, route, body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    async who() {
      const [session, described] = await Promise.all([request("GET", "/api/auth/session").then(answer), request("GET", "/.well-known/openmausbot/environment").then(answer)]);
      const signedIn = session.ok && session.body?.kind === "session";
      return { signedIn, own: signedIn && session.body.own === true, environmentId: typeof described.body?.environmentId === "string" ? described.body.environmentId : null,
        takesMove: Number(described.body?.capabilities?.move) >= 1, status: session.status };
    },
  };
}

/** The move's session at the chosen server: this window's own sign-in, checked to be its owner's, at the server chosen. */
export async function openServerSession(chosen, fetchImpl) {
  const server = serverRequests(chosen, fetchImpl);
  const who = await server.who();
  if (!who.signedIn) throw tagged(`This app isn't signed in to ${chosen.name}. Open ${chosen.name} in this app, then try again.`, "signed_out", { status: who.status === 403 ? 403 : 401 });
  if (who.environmentId !== chosen.environmentId) throw tagged(`The server at ${chosen.name}'s address is another one now, so nothing more goes there.`, "other_server");
  if (!who.own) throw tagged(`${chosen.name} has other people on it now, so your bots can't move there.`, "not_own");
  return {
    call: server.call,
    upload: async (route, bytes, type) => answer(await server.request("POST", route, { headers: { "content-type": type }, body: bytes })),
    fetch: (route, init = {}) => server.request(init.method ?? "GET", route, { ...init, headers: init.headers ?? {} }),
    close: async () => {},
  };
}

function jsonStore(store) {
  return { read: () => { try { return store.read(); } catch { return null; } }, write: (value) => store.write(value) };
}

/**
 * @param {{
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   fetch: typeof fetch,
 *   environments(): any[],
 *   handoff(what: { kind: string, [key: string]: unknown }): Promise<any>,
 *   journal: { read(): unknown, write(value: unknown): void },
 *   choice: { read(): unknown, write(value: unknown): void },
 *   sendState: { read(): unknown, write(value: unknown): void },
 *   cloudJournal(): unknown,
 *   lend?(projects: string[], place: any): Promise<unknown>,
 *   phone?: { paired(): boolean, stop(): Promise<void>, start(): Promise<void> },
 *   openHome?(place: any): void,
 *   lastInput?(): number,
 *   version?: string,
 *   onChange?(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `localRequest`: this computer's server, as its owner. `fetch`: this window's own requests, with its sign-ins.
 * `handoff`: this computer's server's private port, which hands a moving secret to main alone. `cloudJournal()`: the move
 * to My Cloud's journal: while it is under way or done, no server of the person's own is chosen.
 */
export function installOwnHome({ localRequest, fetch: fetchImpl, environments, handoff, journal: journalStore, choice: choiceStore, sendState, cloudJournal, lend, phone, openHome, lastInput,
  version, onChange = () => {}, now = Date.now, log = () => {} }) {
  const journal = jsonStore(journalStore), choice = jsonStore(choiceStore);
  const chosen = () => parseChoice(choice.read());
  const placeOf = (picked = chosen()) => (picked ? environments().find((entry) => handSaved(entry) && entry.origin === picked.origin) ?? null : null);
  const owners = new Map();

  const local = {
    call: async (method, route, body) => answer(await localRequest(route, { method, signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })),
    async json(route) {
      const got = await local.call("GET", route);
      if (!got.ok) throw new Error("OpenMausBot on this computer did not answer. Try again in a moment.");
      return got.body;
    },
  };
  const send = createCloudSend({
    local: (route, init) => localRequest(route, { method: init?.method ?? "GET", signal: AbortSignal.timeout(30_000) }),
    cloud: {
      origin: () => chosen()?.origin ?? null,
      asleep: () => false,
      read: (route) => serverRequests(chosen(), fetchImpl).request("GET", route),
      open: () => openServerSession(chosen(), fetchImpl),
    },
    handoff,
    store: jsonStore(sendState),
    onChange: () => onChange(),
  });
  /** The chosen server as the move sees a Cloud: always ready, never ended once home is there, since nothing ends it; until
   * then, a server forgotten in this app ends the move before anything runs there. */
  const target = () => {
    const picked = chosen();
    if (!picked) return null;
    return { origin: picked.origin, account: `own:${picked.environmentId}`, machine: picked.origin, ready: true, moves: true, paid: false, name: picked.name,
      ended: !placeOf(picked) && !awayIn(parseJournal(journal.read())) };
  };
  const home = createOneHome({
    journal,
    cloud: target,
    send: { move: (options) => send.send({ reason: "move", final: options?.final === true }), check: () => send.check(), switches: () => send.switches(), snapshot: () => send.snapshot() },
    local: {
      ...local,
      freeze: async (origin) => freezeAnswer(await local.call("POST", "/api/move/freeze", { cloud: origin, place: chosen()?.name })),
      async unfreeze(options) {
        const got = await local.call("DELETE", "/api/move/freeze", options?.automations === "off" ? { automations: "off" } : undefined);
        if (!got.ok) throw Object.assign(new Error("OpenMausBot on this computer could not go on again."), { status: got.status });
      },
      frozen: async () => (await local.json("/api/move/freeze"))?.frozen === true,
    },
    session: () => openServerSession(chosen(), fetchImpl),
    ...(lend ? { lend: (projects) => lend(projects, placeOf()) } : {}),
    ...(phone ? { phone } : {}),
    openHome: () => { const place = placeOf(); if (place) openHome?.(place); },
    ...(lastInput ? { lastInput } : {}),
    ...(version ? { version } : {}),
    onChange: () => onChange(),
    log,
  });

  /** The server's own word on whether this window's sign-in there is its one owner's, kept OWNER_KNOWN_MS. */
  async function owner(place) {
    try {
      const who = await serverRequests(place, fetchImpl).who();
      const known = { own: who.own && who.takesMove && who.environmentId !== null, environmentId: who.environmentId, at: now() };
      const before = owners.get(place.id);
      owners.set(place.id, known);
      if (before?.own !== known.own) onChange();
      return known;
    } catch (error) {
      log(`own home: ${place.name} did not say who owns it (${error?.message ?? error})`);
      owners.delete(place.id);
      return { own: false, environmentId: null, at: now() };
    }
  }
  const owns = (place) => {
    const known = handSaved(place) ? owners.get(place.id) : null;
    return Boolean(known?.own) && now() - known.at < OWNER_KNOWN_MS;
  };
  const moving = () => { const kept = parseJournal(journal.read()); return Boolean(kept) && kept.phase !== "back"; };
  const cloudMoving = () => { const kept = parseJournal(cloudJournal()); return Boolean(kept) && kept.phase !== "back"; };
  let retry = null;
  /** Goes on with the move; a choice whose server was forgotten here before anything ran there is let go of, and one whose
   * move could not begin yet begins once it can. */
  async function kick() {
    if (retry) { clearTimeout(retry); retry = null; }
    await home.kick();
    const picked = chosen();
    if (!picked || moving()) return;
    if (!placeOf(picked)) { choice.write(null); onChange(); return; }
    retry = setTimeout(() => { retry = null; void kick().catch((error) => log(`own home: ${error?.message ?? error}`)); }, START_RETRY_MS);
    retry.unref?.();
  }

  return {
    kick,
    view: () => home.view(),
    seen: () => home.seen(),
    retry: () => home.retry(),
    busy: () => home.busy(),
    /** Home is the chosen server: its switch happened. */
    away: () => home.away(),
    /** A server of the person's own is chosen as home: no move to My Cloud starts. */
    active: () => Boolean(chosen()),
    /** The chosen server's address while home is there: This computer is no place of its own then. */
    origin: () => (home.away() ? chosen()?.origin ?? null : null),
    /** The move under way, by its phase and the server's name: this computer's own screen says it while it is stopped. */
    underWay() {
      const kept = parseJournal(journal.read()), picked = chosen();
      return kept && picked && !awayIn(kept) && kept.phase !== "back" ? { phase: kept.phase, name: picked.name } : null;
    },
    /** The chosen server while home is there: this computer is lent to it as it is to My Cloud. */
    home() {
      const picked = chosen(), place = placeOf(picked);
      return picked && place && home.away() ? { id: place.id, origin: picked.origin, environmentId: picked.environmentId, name: place.name } : null;
    },
    /** A server connected by hand whose own word, fresh, is that it is this person's alone (read again now and then,
     * `refresh`). */
    owns,
    /** A server whose circle may offer "Make … my home": theirs alone, and no move under way or done, to it or to My Cloud. */
    offers(place) {
      return !moving() && !chosen() && !cloudMoving() && owns(place);
    },
    /** Asks each server connected by hand who owns it, unless it said so lately. */
    refresh() {
      for (const place of environments().filter(handSaved)) {
        const known = owners.get(place.id);
        if (!known || now() - known.at >= OWNER_KNOWN_MS) void owner(place);
      }
    },
    /** The person chose this server as their home: asked once more, then the move starts. */
    async start(id) {
      const place = environments().find((entry) => entry.id === id && handSaved(entry));
      if (!place) throw new Error("That server isn't in this app any more.");
      if (moving() || chosen()) throw new Error("Your bots are already moving.");
      if (cloudMoving()) throw new Error("Your bots are moving to My Cloud.");
      const who = await serverRequests(place, fetchImpl).who().catch(() => null);
      if (!who?.signedIn) throw new Error(`This app isn't signed in to ${place.name}. Open ${place.name} in this app, then try again.`);
      if (!who.own) throw new Error(`${place.name} has other people on it, so your bots stay here. Only a server that's yours alone can be your bots' home.`);
      if (!who.takesMove || !who.environmentId) throw new Error(`Update OpenMausBot on ${place.name} first, then try again.`);
      choice.write({ v: 1, id: place.id, origin: place.origin, environmentId: who.environmentId, name: place.name, at: now() });
      onChange();
      void kick().catch((error) => log(`own home: ${error?.message ?? error}`));
      return { started: true };
    },
    close() { if (retry) clearTimeout(retry); retry = null; home.close(); },
    journal: () => journal.read(),
    /** The person's choice, as kept. */
    chosen,
  };
}
