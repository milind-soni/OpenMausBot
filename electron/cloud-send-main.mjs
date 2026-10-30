// Main's side of the send that carries the one-time move to My Cloud (cloud-send.mjs): the Cloud sessions it uses, where
// its state lives, and the move's line on either page (the notice).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";
import { createLoginHandoffClient } from "./cloud-logins.mjs";
import { MOVE_LINE, TEAM_MOVE_LINE, resultKey } from "./cloud-send-parts.mjs";
import { createCloudSend, sendNotice } from "./cloud-send.mjs";

const SESSION_LABEL = "Send to My Cloud";
const MOVE_LABEL = "Move to My Cloud";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null);

async function answer(response) {
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) return { status: response.status, ok: false, body: null };
  try { return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null }; }
  catch { return { status: response.status, ok: response.ok, body: null }; }
}

/** One owner session at the person's own Cloud for one send: the Admin's one-time code for the Cloud it verified,
 * redeemed there alone; never an origin a grant names instead. A send is not someone using My Cloud, so it never keeps
 * a Cloud that sleeps awake; a move is (`background: false`), so My Cloud stays awake while it goes. */
export async function openOwnerSession(target, fetchImpl, { label = SESSION_LABEL, background = true } = {}) {
  const quiet = background ? BACKGROUND_HEADERS : {};
  let grant;
  try { grant = await target.grant(); } catch (error) { throw new Error(sentence(error?.message) ?? "My Cloud is not ready. Check it in Settings → MausBot Cloud, then try again.", { cause: error }); }
  if (!record(grant) || grant.origin !== target.origin || typeof grant.code !== "string") throw new Error("My Cloud is not ready. Check it in Settings → MausBot Cloud, then try again.");
  const paired = await answer(await fetchImpl(`${target.origin}/api/auth/pair`, {
    method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json", "content-type": "application/json", ...quiet }, body: JSON.stringify({ code: grant.code, label }),
  }));
  if (!paired.ok || typeof paired.body?.token !== "string" || !paired.body.token.startsWith("omb_sess_")) throw Object.assign(new Error("This app could not sign in to My Cloud. Try again."), { status: paired.status });
  const token = paired.body.token;
  const request = (method, route, init) => fetchImpl(`${target.origin}${route}`, {
    method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(120_000), ...init,
    headers: { accept: "application/json", authorization: `Bearer ${token}`, ...quiet, ...init.headers },
  });
  return {
    call: async (method, route, body) => answer(await request(method, route, body === undefined ? { headers: {} }
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    upload: async (route, bytes, type) => answer(await request("POST", route, { headers: { "content-type": type }, body: bytes })),
    /** The answer as it came, for a download. */
    fetch: (route, init = {}) => request(init.method ?? "GET", route, { ...init, headers: init.headers ?? {} }),
    close: async () => { await request("POST", "/api/auth/logout", { headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.body?.cancel()); },
  };
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   cloudPage: (event: unknown) => "local" | "cloud" | null,
 *   server: () => { postMessage(message: unknown): void } | null | undefined,
 *   local: (route: string, init?: { method?: string }) => Promise<Response>,
 *   home: () => { origin: string, grant: () => Promise<{ origin: string, code: string }> } | null,
 *   cookieFetch: typeof fetch,
 *   reconnect: (origin: string) => Promise<boolean>,
 *   power: { asleep(): boolean },
 *   file: () => string,
 *   window: () => { isDestroyed(): boolean, webContents: { send(channel: string, value: unknown): void, mainFrame: { url: string } } } | null,
 *   localOrigin: () => string,
 *   fetch?: typeof fetch,
 *   engineWaitMs?: number,
 *   space?: { disk(): unknown, grow(sizeGb: number): Promise<unknown> },
 *   move?: () => { view(): unknown, seen(): unknown, retry(): Promise<unknown> } | null,
 *   teamMove?: () => { view(): unknown, seen(): unknown } | null,
 *   moveSession?: { open(target: { origin: string, grant(): Promise<{ origin: string, code: string }> }): Promise<any> },
 * }} deps `engineWaitMs`: how long a
 * move waits for My Cloud's engines (cloud-connections.mjs). `space`: My Cloud's plan disk and the Admin's grow, so a
 * move makes room for the files it carries. `move`: the one-time move (one-home.mjs), whose line either page shows.
 * `teamMove`: a bot moving from My Cloud into a team (team-move-main.mjs), whose line My Cloud's page shows.
 * `moveSession`: the one session every pass of the move uses (move-session.mjs); without it each pass opens its own.
 */
export function installCloudSend({ ipcMain, cloudPage, server, local, home, cookieFetch, reconnect, power, file, window, localOrigin,
  fetch: fetchImpl = globalThis.fetch, engineWaitMs, space, move = () => null, teamMove = () => null, moveSession = null }) {
  const handoff = createLoginHandoffClient();
  const pageOf = () => {
    const win = window();
    if (!win || win.isDestroyed()) return null;
    try {
      const origin = new URL(win.webContents.mainFrame.url).origin;
      return origin === localOrigin() ? "local" : origin === home()?.origin ? "cloud" : null;
    } catch { return null; }
  };
  const moving = () => move()?.view() ?? null;
  /** The notice either page gets, with the one-time move's line when there is one. */
  const notice = (snapshot) => {
    const line = moving(), team = pageOf() === "cloud" ? teamMove()?.view() ?? null : null;
    return { ...sendNotice(snapshot), ...(line ? { move: line } : {}), ...(team ? { teamMove: team } : {}) };
  };
  const deliver = (snapshot) => {
    if (pageOf()) window().webContents.send("cloud-send:notice-changed", notice(snapshot));
  };
  const read = async (route) => {
    const target = home();
    if (!target) throw new Error("no Cloud");
    const ask = () => cookieFetch(`${target.origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", origin: target.origin, ...BACKGROUND_HEADERS } });
    const response = await ask();
    if (response.status !== 401 || !(await reconnect(target.origin))) return response;
    return ask();
  };
  const send = createCloudSend({
    local,
    cloud: {
      origin: () => home()?.origin ?? null,
      asleep: () => power.asleep(),
      read,
      open: (options) => {
        const target = home();
        if (!target) return Promise.reject(new Error("This computer has no My Cloud yet."));
        if (options?.move && moveSession) return moveSession.open(target);
        return openOwnerSession(target, fetchImpl, options?.move ? { label: MOVE_LABEL, background: false } : {});
      },
    },
    handoff: (what) => handoff.request(server(), what),
    store: {
      read: () => { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return null; } },
      write: (value) => { const target = file(); writeFileSync(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${target}.tmp`, target); },
    },
    onChange: deliver,
    engineWaitMs,
    space,
  });
  const onPage = (channel, handler) => (event, ...args) => {
    const asking = cloudPage(event);
    if (!asking) throw new Error(`${channel} is only available in this app's window`);
    return handler(asking, ...args);
  };

  ipcMain.handle("cloud-send:notice", onPage("cloud-send:notice", () => notice(send.snapshot())));
  ipcMain.handle("cloud-send:dismiss", onPage("cloud-send:dismiss", (_event, signature) => {
    if (String(signature) === TEAM_MOVE_LINE) { teamMove()?.seen(); return notice(send.snapshot()); }
    if (String(signature) === MOVE_LINE) {
      // The done line says what the move brought; the move's own send result is not said again after it.
      move()?.seen();
      const last = send.snapshot().last;
      return notice(last ? send.dismiss(resultKey(last)) : send.snapshot());
    }
    return notice(send.dismiss(String(signature)));
  }));
  // The move's Try again, after a day of failing.
  ipcMain.handle("cloud-send:move-retry", onPage("cloud-send:move-retry", async () => { await move()?.retry(); return notice(send.snapshot()); }));

  return {
    receive: handoff.receive,
    /** The one-time move to My Cloud (cloud-send.mjs): a pass that carries everything, `final` the one after this computer
     * stops, and the check of what arrived. */
    move: (options) => send.send({ reason: "move", final: options?.final === true }),
    check: () => send.check(),
    /** Each automation the move carried, and whether it was on here when it went. */
    switches: () => send.switches(),
    snapshot: () => send.snapshot(),
    /** The move's line changed: both pages get it again. */
    publish: () => deliver(send.snapshot()),
  };
}

