// Main's side of the one-time move to My Cloud (one-home.mjs) and of the send it runs (cloud-send-main.mjs): its
// journal, this computer's server's freeze, My Cloud's owner sessions, the person's typing, and coming home when My
// Cloud ends (one-home-again.mjs). The Admin's word decides: a move starts only for an account it lets move, to a Cloud
// that is ready, and a Cloud it holds after it ended is the one signal that brings everything home. The person's own
// choice to keep this computer's bots here (Settings → MausBot Cloud, Advanced) is kept beside the journal.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { installCloudSend, openOwnerSession } from "./cloud-send-main.mjs";
import { createMoveSession } from "./move-session.mjs";
import { createHomeAgain } from "./one-home-again.mjs";
import { awayIn, createOneHome, parseJournal, underWay } from "./one-home.mjs";
import { teamPlan } from "./cloud-team-plan.mjs";
import { installTeamMove } from "./team-move-main.mjs";

const MOVE_LABEL = "Move to My Cloud";
const HOME_LABEL = "Bring My Cloud home";
const KEEP_LABEL = "Bring this computer's bots home";

/** This computer as the Admin knows it, the same across sign-outs and sign-ins: a hash of its own server's identity, so
 * the identity itself never leaves it. */
export function installationOf(environmentId) {
  return createHash("sha256").update(`openmausbot-installation:${environmentId}`).digest("base64url");
}

/** One home's view of the person's Cloud, from the Admin's last verified word; null while nobody is signed in. An ended
 * Cloud's `homecoming` is the computer its things come home to; `signIn`, this app's sign-in. */
export function oneHomeCloud(state) {
  const account = state?.account?.id;
  if (typeof account !== "string" || !account) return null;
  const connected = state.status === "connected", machine = connected ? state.machine ?? null : null;
  const trialOn = ["active", "ending"].includes(state.trial?.state ?? "");
  const homecoming = machine?.hold?.homecoming ?? null;
  return {
    origin: machine?.origin ?? null,
    account,
    machine: machine?.origin ?? null,
    ready: connected && machine?.status === "ready" && Boolean(machine.origin),
    moves: connected && machine?.moves === true,
    ended: connected && Boolean(machine?.hold),
    paid: connected && state.entitlement?.status === "active" && !trialOn && !teamPlan(state),
    ...(homecoming ? { homecoming: { installationId: homecoming.installationId, name: homecoming.name } } : {}),
    ...(connected && typeof state.deviceId === "string" && state.deviceId ? { signIn: state.deviceId } : {}),
  };
}

function jsonFile(file) {
  return {
    read: () => { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return null; } },
    write: (value) => {
      const target = file();
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(`${target}.tmp`, JSON.stringify(value ?? null), { mode: 0o600 });
      renameSync(`${target}.tmp`, target);
    },
  };
}

async function answer(response) {
  const text = await response.text();
  try { return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }; }
  catch { return { ok: response.ok, status: response.status, body: null }; }
}

/**
 * @param {Omit<Parameters<typeof installCloudSend>[0], "local" | "move"> & {
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   account(): { state(): any, pairHome(): Promise<{ origin: string, code: string }>, exportHome(): Promise<any> } | null,
 *   journalFile(): string,
 *   tempRoot(): string,
 *   lend?(projects: string[]): Promise<unknown>,
 *   offer?(): unknown,
 *   phone?: { paired(): boolean, stop(): Promise<void>, start(): Promise<void> },
 *   openHome?(): void,
 *   openLocal?(): void,
 *   restart?(): void,
 *   version?: string,
 *   log?(line: string): void,
 *   journal?: { read(): unknown, write(value: unknown): void },
 *   openTeam?(team: { id: string, name: string }): void,
 *   teamJournal?: { read(): unknown, write(value: unknown): void },
 *   keep?: { read(): unknown, write(value: unknown): void },
 * }} deps `localRequest`: this computer's server, as its owner (main adds the owner's header). `account`: the MausBot
 * Cloud sign-in (cloud-account.mjs). `journal`: where the move's journal is kept, journalFile by default; `keep`: the
 * person's choice to keep this computer's bots here, one-home-keep.json beside it by default. `openTeam`:
 * shows a team's page, where a bot moved into it from My Cloud now lives (team-move-main.mjs, whose journal is
 * `teamJournal`, team-moves.json beside this one by default). The rest are installCloudSend's.
 */
export function installOneHome({ localRequest, account, journalFile, tempRoot, lend, offer, phone, openHome, openLocal, restart, version, log = () => {}, journal: kept, keep: keptChoice, openTeam, teamJournal, ...sendDeps }) {
  const fetchImpl = sendDeps.fetch ?? globalThis.fetch;
  let home = null;
  let lastInput = 0;
  const watched = new WeakSet();
  let teamMove = null;
  // One owner session for the whole move, every pass and check and the switch: each new one is one of the Admin's codes.
  const moveSession = createMoveSession({ open: (target) => openOwnerSession(target, fetchImpl, { label: MOVE_LABEL, background: false }) });
  const send = installCloudSend({ ...sendDeps, local: (route, init) => localRequest(route, { method: init?.method ?? "GET", signal: AbortSignal.timeout(30_000) }), move: () => home, teamMove: () => teamMove,
    moveSession });
  teamMove = installTeamMove({ ipcMain: sendDeps.ipcMain, cloudPage: sendDeps.cloudPage, home: sendDeps.home, account: () => account(), fetch: fetchImpl, openTeam,
    file: () => join(dirname(journalFile()), "team-move-send.json"), journalFile: () => join(dirname(journalFile()), "team-moves.json"), ...(teamJournal ? { journal: teamJournal } : {}),
    onChange: () => send.publish(), log });
  const journal = kept ?? jsonFile(journalFile);
  const keep = keptChoice ?? jsonFile(() => join(dirname(journalFile()), "one-home-keep.json"));
  /** When the person last typed or clicked in the window. */
  const typed = () => {
    const win = sendDeps.window?.();
    if (win && !win.isDestroyed?.() && !watched.has(win.webContents)) {
      watched.add(win.webContents);
      win.webContents.on?.("before-input-event", () => { lastInput = Date.now(); });
      // A watch set up just now has seen nothing yet: it counts as a key now, never as "typed long ago".
      lastInput = Math.max(lastInput, Date.now());
    }
    return lastInput;
  };

  const local = {
    call: async (method, route, body) => answer(await localRequest(route, { method, signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })),
    async json(route) {
      const got = await local.call("GET", route);
      if (!got.ok) throw new Error("OpenMausBot on this computer did not answer. Try again in a moment.");
      return got.body;
    },
  };
  const cloudOrigin = () => journal.read()?.cloud?.origin ?? null;
  let known = null;
  /** This computer's installation (`installationOf`), once its server has said who it is; null until then. */
  const installation = async () => {
    if (known) return known;
    const id = (await local.json("/.well-known/openmausbot/environment").catch(() => null))?.environmentId;
    if (typeof id === "string" && id) known = installationOf(id);
    return known;
  };
  const target = () => {
    const client = account(), origin = cloudOrigin() ?? oneHomeCloud(client?.state())?.origin;
    if (!client || !origin) throw new Error("This computer has no My Cloud yet.");
    return { origin, grant: () => client.pairHome() };
  };

  const backupLocal = {
    json: local.call,
    upload: async (file, bytes) => answer(await localRequest("/api/workspace-backup/upload", { method: "POST", duplex: "half", signal: AbortSignal.timeout(60 * 60_000),
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes) }, body: Readable.toWeb(createReadStream(file)) })),
  };
  const again = createHomeAgain({
    async exportGrant() {
      const asked = await account()?.exportHome({ installation: (await installation()) ?? undefined });
      if (!asked) throw new Error("Sign in to MausBot Cloud first.");
      // The code goes only to the Cloud this computer moved to.
      if ("grant" in asked && asked.grant.origin !== cloudOrigin()) throw new Error("This is not the Cloud this computer moved to.");
      return asked;
    },
    open: (grant) => openOwnerSession({ origin: grant.origin, grant: async () => grant }, fetchImpl, { label: HOME_LABEL, background: false }),
    local: backupLocal,
    tempRoot: tempRoot(),
  });
  const keepHome = createHomeAgain({
    async exportGrant() {
      // My Cloud goes on: its owner's own code, for the Cloud this computer moved to only.
      const grant = await target().grant();
      if (grant?.origin !== cloudOrigin()) throw new Error("This is not the Cloud this computer moved to.");
      return { grant };
    },
    open: (grant) => openOwnerSession({ origin: grant.origin, grant: async () => grant }, fetchImpl, { label: KEEP_LABEL, background: false }),
    local: backupLocal,
    tempRoot: tempRoot(),
  });

  home = createOneHome({
    journal,
    // Every run starts here: the key watch is set up before any wait asks, so a key pressed since then counts.
    cloud: () => { typed(); return oneHomeCloud(account()?.state()); },
    send,
    local: {
      ...local,
      async freeze(origin) {
        const got = await local.call("POST", "/api/move/freeze", { cloud: origin });
        if (got.status === 409 && typeof got.body?.busy === "string") return { busy: got.body.busy };
        if (!got.ok || got.body?.frozen !== true) throw Object.assign(new Error("OpenMausBot on this computer could not pause."), { status: got.status });
        return { frozen: true };
      },
      async unfreeze(options) {
        const got = await local.call("DELETE", "/api/move/freeze", options?.automations === "off" ? { automations: "off" } : undefined);
        if (!got.ok) throw Object.assign(new Error("OpenMausBot on this computer could not go on again."), { status: got.status });
      },
      frozen: async () => (await local.json("/api/move/freeze"))?.frozen === true,
      async forget() {
        const got = await local.call("POST", "/api/move/forget");
        if (!got.ok) throw Object.assign(new Error("This computer's copy could not be deleted."), { status: got.status });
      },
    },
    session: () => moveSession.open(target()),
    release: () => moveSession.end(),
    lend, offer, phone, openHome, openLocal, restart, version, log,
    again,
    keep,
    keepHome,
    installation,
    async reportMove() {
      const client = account(), mine = await installation();
      return Boolean(client?.reportMove && mine && await client.reportMove({ installation: mine }));
    },
    async reportKept() {
      const client = account(), mine = await installation();
      return Boolean(client?.reportKept && mine && await client.reportKept({ installation: mine }));
    },
    lastInput: typed,
    onChange: () => send.publish(),
  });

  /** The switch "Keep this computer's bots on this computer": `shown` only to someone with a Cloud of their own the move
   * applies to; `moved`, turning it on brings this computer's bots home; `coming`, they are on their way past turning back. */
  const keepState = () => {
    const cloud = oneHomeCloud(account()?.state()), moving = parseJournal(journal.read());
    return { shown: Boolean(cloud?.origin) && (cloud.moves || Boolean(moving) || home.keeps()), on: home.keeps(), moved: awayIn(moving) && moving.phase !== "keeping",
      coming: underWay(moving) };
  };
  const onPage = (channel, handler) => (event, ...args) => {
    if (!sendDeps.cloudPage(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(...args);
  };
  sendDeps.ipcMain.handle("one-home:keep", onPage("one-home:keep", keepState));
  sendDeps.ipcMain.handle("one-home:keep-set", onPage("one-home:keep-set", (on) => {
    if (on === true && !keepState().shown) throw new Error("This computer has no My Cloud to keep its bots from.");
    void home.keep(on === true).catch((error) => log(`one home: ${error?.message ?? error}`));
    return keepState();
  }));

  return {
    ...send,
    /** The switch "Keep this computer's bots on this computer", as Settings shows it, and the person turning it. */
    keep: { state: keepState, set: (on) => home.keep(on === true) },
    /** Goes on with the move, and with any bot moving into a team: at launch, and whenever the MausBot Cloud sign-in changes. */
    kick: () => { void teamMove.kick(); return home.kick(); },
    /** Home is My Cloud: this computer's own server is frozen for good, and its phone link stays off. */
    away: () => home.away(),
    view: () => home.view(),
    close: () => { teamMove.close(); home.close(); void moveSession.end(); },
    /** A bot moving from My Cloud into a team (team-move-main.mjs). */
    teamMove,
    oneHome: home,
    /** The journal as it is on disk. */
    journal: () => journal.read(),
    /** This computer's server's freeze marker: `{ frozen, cloud? }`. */
    marker: () => local.json("/api/move/freeze"),
    lastInput: typed,
  };
}
