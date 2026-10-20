// Main's side of Send to My Cloud (cloud-send.mjs): its IPC, the Cloud sessions it uses, and where its state lives.
// A send the person asks for brings the chats too, through Bring newer chats (cloud-move.mjs), which only adds.
// This computer's Settings may ask for everything; My Cloud's own page, verified as the person's Cloud, learns only
// what waits (sendNotice) and may start a send from the person's click. Settings → Logins' "Also use on My Cloud" is the
// same send for one login.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";
import { createLoginHandoffClient, handoffWhat } from "./cloud-logins.mjs";
import { itemKey } from "./cloud-send-parts.mjs";
import { AUTO_SENDS_CHATS, createCloudSend, sendNotice } from "./cloud-send.mjs";

const SESSION_LABEL = "Send to My Cloud";
const NOT_READY = {
  outdated: "My Cloud needs an update before it can receive logins from this computer. It updates by itself; try again later.",
  asleep: "My Cloud is asleep. Open it once to wake it, then try again.",
  unreachable: "My Cloud didn't answer. Check it in Settings → MausBot Cloud, then try again.",
};
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
 * a Cloud that sleeps awake. */
export async function openOwnerSession(target, fetchImpl, label = SESSION_LABEL) {
  let grant;
  try { grant = await target.grant(); } catch (error) { throw new Error(sentence(error?.message) ?? "My Cloud is not ready. Check it in Settings → MausBot Cloud, then try again."); }
  if (!record(grant) || grant.origin !== target.origin || typeof grant.code !== "string") throw new Error("My Cloud is not ready. Check it in Settings → MausBot Cloud, then try again.");
  const paired = await answer(await fetchImpl(`${target.origin}/api/auth/pair`, {
    method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json", "content-type": "application/json", ...BACKGROUND_HEADERS }, body: JSON.stringify({ code: grant.code, label }),
  }));
  if (!paired.ok || typeof paired.body?.token !== "string" || !paired.body.token.startsWith("omb_sess_")) throw new Error("This app could not sign in to My Cloud. Try again.");
  const token = paired.body.token;
  const request = (method, route, init) => fetchImpl(`${target.origin}${route}`, {
    method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(120_000), ...init,
    headers: { accept: "application/json", authorization: `Bearer ${token}`, ...BACKGROUND_HEADERS, ...init.headers },
  });
  return {
    call: async (method, route, body) => answer(await request(method, route, body === undefined ? { headers: {} }
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    upload: async (route, bytes, type) => answer(await request("POST", route, { headers: { "content-type": type }, body: bytes })),
    close: async () => { await request("POST", "/api/auth/logout", { headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.body?.cancel()); },
  };
}

/** Whether this computer's messages with a bot reach My Cloud by themselves: Keep My Cloud up to date is on and sends
 * chats, the bot's own switch is on, and the last send neither failed nor left the chats or that bot out. */
export function chatsArrive(snapshot, botId, sendsChats = AUTO_SENDS_CHATS) {
  if (!sendsChats || snapshot?.auto !== true || !snapshot.last || snapshot.last.error) return false;
  const key = itemKey.bot(botId);
  if (snapshot.rows.some((row) => row.key === key && (row.state === "off" || row.state === "removed"))) return false;
  return !(snapshot.last.result?.failed ?? []).some((entry) => entry.kind === "chats" || entry.key === key);
}

/** What Settings → Logins compares: My Cloud's logins (site and username) and whether 1Password is connected there. */
export function loginsView(snapshot) {
  if (snapshot.cloud === "none") return { cloud: null };
  if (snapshot.cloud !== "ready") return { cloud: { reachable: false } };
  const onCloud = new Set(["on-both", "to-update", "differs"]);
  const there = [...snapshot.rows.filter((row) => row.kind === "login" && onCloud.has(row.state)), ...snapshot.cloudOnly.filter((row) => row.kind === "login")];
  const logins = there.map((row) => ({ site: /^login:([^|]+)\|/u.exec(row.key)?.[1], username: row.detail ?? "" })).filter((login) => login.site);
  const onePassword = snapshot.rows.some((row) => row.kind === "1password" && onCloud.has(row.state)) || snapshot.cloudOnly.some((row) => row.kind === "1password");
  return { cloud: { reachable: true, logins, onePassword: { connected: onePassword, vaults: [] } } };
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   localOnly: (channel: string, handler: (...args: any[]) => unknown) => (...args: any[]) => unknown,
 *   cloudPage: (event: unknown) => "local" | "cloud" | null,
 *   server: () => { postMessage(message: unknown): void } | null | undefined,
 *   local: (route: string) => Promise<Response>,
 *   home: () => { origin: string, grant: () => Promise<{ origin: string, code: string }> } | null,
 *   cookieFetch: typeof fetch,
 *   reconnect: (origin: string) => Promise<boolean>,
 *   power: { asleep(): boolean },
 *   file: () => string,
 *   window: () => { isDestroyed(): boolean, webContents: { send(channel: string, value: unknown): void, mainFrame: { url: string } } } | null,
 *   localOrigin: () => string,
 *   openSettings: () => void,
 *   fetch?: typeof fetch,
 *   bringChats?: () => Promise<{ phase: string, action?: string, brought?: { conversations: number, messages: number }, error?: { message?: string } }>,
 *   keepUpToDate?: boolean,
 * }} deps `keepUpToDate`: false leaves the switch's background sends unstarted (fixtures that show a comparison).
 * `bringChats`: Bring newer chats to My Cloud, as cloud-move.mjs's bring answers it.
 */
export function installCloudSend({ ipcMain, localOnly, cloudPage, server, local, home, cookieFetch, reconnect, power, file, window, localOrigin, openSettings,
  fetch: fetchImpl = globalThis.fetch, bringChats = null, keepUpToDate = true }) {
  const handoff = createLoginHandoffClient();
  const pageOf = () => {
    const win = window();
    if (!win || win.isDestroyed()) return null;
    try {
      const origin = new URL(win.webContents.mainFrame.url).origin;
      return origin === localOrigin() ? "local" : origin === home()?.origin ? "cloud" : null;
    } catch { return null; }
  };
  const deliver = (snapshot) => {
    const page = pageOf();
    if (page === "local") window().webContents.send("cloud-send:state-changed", snapshot);
    if (page === "cloud") window().webContents.send("cloud-send:notice-changed", sendNotice(snapshot));
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
      open: () => { const target = home(); return target ? openOwnerSession(target, fetchImpl) : Promise.reject(new Error("This computer has no My Cloud yet.")); },
    },
    handoff: (what) => handoff.request(server(), what),
    chats: bringChats && (async () => {
      const state = await bringChats();
      if (state?.phase === "done" && state.action === "bring" && record(state.brought)) return { conversations: state.brought.conversations, messages: state.brought.messages };
      throw new Error(sentence(state?.error?.message) ?? "Another copy to My Cloud is running. Send again when it has finished.");
    }),
    store: {
      read: () => { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return null; } },
      write: (value) => { const target = file(); writeFileSync(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${target}.tmp`, target); },
    },
    onChange: deliver,
  });
  const fresh = () => send.compare().catch(() => send.snapshot());
  const options = (input) => ({
    keys: Array.isArray(input?.keys) ? input.keys.filter((key) => typeof key === "string").slice(0, 5_000) : null,
    force: Array.isArray(input?.force) ? input.force.filter((key) => typeof key === "string").slice(0, 5_000) : [],
  });
  const onPage = (channel, handler) => (event, ...args) => {
    const asking = cloudPage(event);
    if (!asking) throw new Error(`${channel} is only available in this app's window`);
    return handler(asking, ...args);
  };

  ipcMain.handle("cloud-send:state", localOnly("cloud-send:state", () => send.snapshot()));
  ipcMain.handle("cloud-send:refresh", localOnly("cloud-send:refresh", () => fresh()));
  ipcMain.handle("cloud-send:send", localOnly("cloud-send:send", (_event, input) => send.send({ ...options(input), reason: "button" })));
  ipcMain.handle("cloud-send:auto", localOnly("cloud-send:auto", (_event, on) => send.setAuto(on === true)));
  ipcMain.handle("cloud-send:item", localOnly("cloud-send:item", (_event, key, on) => send.setItem(String(key), on === true)));
  ipcMain.handle("cloud-send:notice", onPage("cloud-send:notice", async () => sendNotice(await fresh())));
  // A send that fails as a whole is this send's outcome too: the notice carries why.
  ipcMain.handle("cloud-send:page-send", onPage("cloud-send:page-send", async (asking) => {
    await send.send({ reason: asking === "cloud" ? "my-cloud" : "button" }).catch(() => {});
    return sendNotice(send.snapshot());
  }));
  ipcMain.handle("cloud-send:dismiss", onPage("cloud-send:dismiss", (_event, signature) => sendNotice(send.dismiss(String(signature)))));

  // Settings → Logins: the same comparison and the same send, for one login or 1Password.
  ipcMain.handle("cloud-logins:state", localOnly("cloud-logins:state", async () => loginsView(await fresh())));
  ipcMain.handle("cloud-logins:send", localOnly("cloud-logins:send", async (_event, input) => {
    const what = handoffWhat(input);
    if (!what) throw new Error("Choose a login to send to My Cloud.");
    if (!home()) throw new Error("This computer has no My Cloud yet.");
    const before = await fresh();
    if (before.cloud !== "ready") throw new Error(NOT_READY[before.cloud] ?? NOT_READY.unreachable);
    const row = before.rows.find((entry) => what.kind === "1password" ? entry.kind === "1password" : entry.kind === "login" && entry.id === what.id);
    if (!row) throw new Error(what.kind === "1password" ? "1Password is not connected on this computer." : "This login is no longer saved on this computer.");
    if (row.state === "off" || row.state === "removed") send.setItem(row.key, true);
    const outcome = await send.send({ keys: [row.key], force: [row.key], reason: "logins" });
    const failed = outcome.result.failed.find((entry) => entry.key === row.key);
    if (failed) throw new Error(failed.error);
    return { sent: true, ...(outcome.result.notes.some((note) => note.kind === "narrowed") ? { narrowed: true } : {}), ...loginsView(send.snapshot()) };
  }));

  if (keepUpToDate) send.start();
  return {
    receive: handoff.receive,
    /** For the one workspace: whether this computer's messages with `botId` reach My Cloud by themselves. */
    chatsArrive: (botId) => chatsArrive(send.snapshot(), botId),
    /** The switcher: what waits, from the last comparison (refreshed in the background), and its Send. */
    menu: () => {
      void fresh();
      const waiting = send.waiting();
      return {
        waiting,
        onSend: () => { openSettings(); void send.send({ reason: "menu" }).catch(() => {}); },
        onOpen: () => openSettings(),
      };
    },
  };
}

