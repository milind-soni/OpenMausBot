// Main's side of moving a bot from My Cloud, or from this computer, into one of its person's teams (team-move.mjs): for
// each run, one owner session at My Cloud (or this computer's own server, as its owner) and one move-in sign-in at the
// team (through the Admin's team pairing, as the window signs in there), the send kept to that one bot (cloud-send.mjs),
// and the move's channels for My Cloud's page, this computer's page and the team's own page. The teams come only from
// the Admin's verified session, never from a page; which place a bot comes from is the page that asked, never its word.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createCloudSend } from "./cloud-send.mjs";
import { openOwnerSession } from "./cloud-send-main.mjs";
import { BATCH_MAX, createTeamMove, sourceOf, TEAM_MOVE_TEXT, teamMoveRefusal } from "./team-move.mjs";
import nativeText from "./native-text.cjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 300) : null);
const ID = /^[\w-]{1,128}$/u;

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
  try { return { status: response.status, ok: response.ok, body: text ? JSON.parse(text) : null }; }
  catch { return { status: response.status, ok: response.ok, body: null }; }
}

/** The teams this person may move a bot into: from the Admin's last verified word, each with its Cloud's address. */
export function moveTeams(state) {
  if (state?.status !== "connected" || !Array.isArray(state.teams)) return [];
  return state.teams.filter((team) => record(team) && ID.test(team.id ?? "") && typeof team.name === "string" && typeof team.machine?.origin === "string")
    .map((team) => ({ id: team.id, name: team.name, origin: team.machine.origin, ready: team.machine.status === "ready" }));
}

/** What a native confirm says when a team's own page asks to bring a bot in: main's words, so no page can soften them.
 * `from`: where it comes from. With `bots`, several of this computer's bots, named. */
export function teamMoveConfirmWords(names, t = nativeText.englishText.t, { from = "cloud", bots = null } = {}) {
  const computer = from === "computer";
  const many = Array.isArray(bots) && bots.length > 1;
  const bot = many ? t("teamMove.theseBots") : names.bot;
  const said = { ...names, bot };
  return {
    message: many ? t("teamMove.manyTitle", { count: bots.length, team: names.team }) : t("teamMove.title", names),
    detail: [
      ...(many ? [bots.join(", ")] : []),
      t(many ? "teamMove.manyYours" : "teamMove.yours", said),
      t(many ? "teamMove.manyGoes" : "teamMove.goes", said),
      t("teamMove.private"),
      computer ? t(many ? "teamMove.manyStaysOnComputer" : "teamMove.staysOnComputer", said) : t("teamMove.staysOnMyCloud", said),
      ...(computer ? [] : [t("teamMove.dataStays", said)]),
      t(computer ? "teamMove.noWayBackComputer" : "teamMove.noWayBack"),
    ].join("\n\n"),
    buttons: [t("teamMove.confirm", names), t("native.common.cancel")],
  };
}

const BRING_LIST_MS = 30_000;

/** The bots on My Cloud (or this computer) a team's page offers: in the order that place lists them, each with why it
 * can't go, if it can't. A bot that lives in another place (`home`) is not that place's to move. */
export function bringableBots(listed) {
  const here = (Array.isArray(listed) ? listed : []).filter((bot) => record(bot) && ID.test(bot.id ?? "") && typeof bot.name === "string" && !bot.hidden && !bot.movedTo && !bot.home);
  return here.map((bot) => {
    const stays = bot.defaultBot ? "default" : bot.chiefOfStaff ? "chief" : here.length <= 1 ? "last" : null;
    return { id: bot.id, name: bot.name, ...(stays ? { stays } : {}) };
  });
}

/** A session opened once, when first used, and closed once. */
function lazy(open) {
  let opened = null;
  return {
    get: () => (opened ??= open()),
    async close() {
      const was = opened;
      opened = null;
      const session = was ? await was.catch(() => null) : null;
      await session?.close().catch(() => {});
    },
  };
}

/** The move-in sign-in the team handed out, as a session the send uses. */
function bearerSession(origin, token, fetchImpl) {
  const request = (method, route, { timeoutMs = 120_000, ...init }) => fetchImpl(`${origin}${route}`, {
    method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), ...init,
    headers: { accept: "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  return {
    call: async (method, route, body, options) => answer(await request(method, route, { ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(body === undefined ? { headers: {} }
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })),
    upload: async (route, bytes, type) => answer(await request("POST", route, { headers: { "content-type": type }, body: bytes })),
    close: async () => { await request("POST", "/api/auth/logout", { headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.body?.cancel()); },
  };
}

/** This computer's own server as a move reads it: its owner's requests, nothing to sign in to or out of. */
function computerSession(computer) {
  const request = (method, route, init = {}) => computer.request(route, { method, ...init });
  return {
    fetch: (route, init = {}) => request(init.method ?? "GET", route),
    call: async (method, route, body) => answer(await request(method, route, body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    close: async () => {},
  };
}

/** Why a bot of this computer stays on it, by what its own server lists now; null when it may go. A bot already held for
 * this very move is past these checks. */
export function computerStays(listed, botId, teamId) {
  const bots = (Array.isArray(listed) ? listed : []).filter(record);
  const bot = bots.find((entry) => entry.id === botId);
  if (!bot || bot.movedTo?.team?.id === teamId) return null;
  if (bot.defaultBot) return "default";
  if (bot.chiefOfStaff) return "chief";
  if (bot.home) return "elsewhere";
  return bots.filter((entry) => !entry.hidden && !entry.movedTo && !entry.home).length <= 1 ? "last" : null;
}

const STAYS_TEXT = {
  default: (name) => `${name} stays on this computer: everyone on a team gets their own.`,
  chief: (name) => `${name} is your Chief of Staff, which stays on this computer.`,
  elsewhere: (name) => `${name} lives in another place, not on this computer.`,
  last: () => "Keep at least one bot on this computer.",
};

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   cloudPage(event: unknown): "local" | "cloud" | null,
 *   pageOrigin?(event: unknown): string | null,
 *   confirmMove?(words: { message: string, detail: string, buttons: string[] }): Promise<boolean>,
 *   home(): { origin: string, grant(): Promise<{ origin: string, code: string }> } | null,
 *   computer?: { request(route: string, init?: RequestInit): Promise<Response>, available(): boolean, busy?(botId: string): boolean } | null,
 *   account(): { state(): any, pairTeam(teamId: string): Promise<{ origin: string, code: string }> } | null,
 *   file(): string,
 *   journalFile(): string,
 *   openTeam?(team: { id: string, name: string }): void,
 *   onChange?(): void,
 *   fetch?: typeof fetch,
 *   journal?: { read(): unknown, write(value: unknown): void },
 *   log?(line: string): void,
 *   t?(key: string, params?: Record<string, string | number>): string,
 * }} deps `home`: My Cloud and the Admin's code for it. `computer`: this computer's own server, as its owner, and whether
 * its bots are its own to move now (not while they move to My Cloud or live there), and whether one is on its way to My
 * Cloud by itself (`busy`). `account`: the MausBot Cloud sign-in,
 * whose verified session names the person's teams. `file`: the send's own state; `journalFile`: the moves'. `openTeam`:
 * shows the team's page. `pageOrigin`: the origin of the page asking, when it is this window's active server's main frame.
 * `confirmMove`: asks the person outside any page.
 */
export function installTeamMove({ ipcMain, cloudPage, pageOrigin = () => null, confirmMove = async () => false, home, computer = null, account, file, journalFile, openTeam, onChange = () => {}, fetch: fetchImpl = globalThis.fetch, journal, log = () => {}, t = nativeText.englishText.t }) {
  const teams = () => moveTeams(account()?.state());
  const teamOf = (id) => teams().find((team) => team.id === id) ?? null;
  const sendStore = jsonFile(file);
  const computerFile = () => file().replace(/(\.json)?$/u, (ext) => `-computer${ext || ".json"}`);
  const computerStore = jsonFile(computerFile);
  const computerReady = () => Boolean(computer?.available());

  function open(move) {
    const label = `Move to ${move.team.name}`;
    const fromComputer = sourceOf(move) === "computer";
    const place = fromComputer ? "this computer" : "My Cloud";
    const source = fromComputer
      ? { get: () => (computer ? Promise.resolve(computerSession(computer)) : Promise.reject(new Error("OpenMausBot on this computer is not running."))), close: async () => {} }
      : lazy(() => {
        const target = home();
        if (!target) return Promise.reject(new Error("This app has no My Cloud to move from."));
        return openOwnerSession(target, fetchImpl, { label, background: false });
      });
    let begun = null;
    const facts = { threadId: null, label: null };
    const target = lazy(async () => {
      const team = teamOf(move.team.id);
      if (!team) throw new Error(`You're no longer in ${move.team.name}.`);
      const client = account();
      if (!client) throw new Error("Sign in to MausBot Cloud first.");
      const member = await openOwnerSession({ origin: team.origin, grant: () => client.pairTeam(team.id) }, fetchImpl, { label, background: false });
      try {
        const asked = await member.call("POST", "/api/team-move-in", { v: 1, bot: { id: move.bot.id, name: move.bot.name, ...(facts.threadId ? { threadId: facts.threadId } : {}) },
          ...(facts.label ? { label: facts.label } : {}) });
        // From this computer, a team that has this bot already, or someone else moving it there, does not change by trying again.
        if (!asked.ok) throw Object.assign(new Error(sentence(asked.body?.error) ?? `${team.name} did not take ${move.bot.name}.`), { status: asked.status, ...(fromComputer && asked.status === 409 ? { final: true } : {}) });
        begun = asked.body?.done ? { done: true, name: asked.body.name } : { name: typeof asked.body?.name === "string" ? asked.body.name : move.bot.name };
        return asked.body?.done ? null : bearerSession(team.origin, asked.body.token, fetchImpl);
      } finally { await member.close().catch(() => {}); }
    });
    const scope = { bot: move.bot.id, label: move.label ?? "you", name: move.name ?? move.bot.name };
    const engine = createCloudSend({
      local: async (route, init) => (await source.get()).fetch(route, { method: init?.method ?? "GET" }),
      cloud: {
        origin: () => teamOf(move.team.id)?.origin ?? move.team.origin ?? null,
        asleep: () => false,
        read: () => Promise.reject(new Error("A move reads the team only over its own sign-in.")),
        open: async () => {
          const session = await target.get();
          if (!session) throw new Error(`${move.bot.name} is in ${move.team.name} already.`);
          return { ...session, close: async () => {} };
        },
      },
      handoff: () => Promise.reject(new Error("Nothing personal moves into a team.")),
      store: fromComputer ? computerStore : sendStore,
      team: scope,
      onChange: () => onChange(),
    });
    const myCloud = { call: async (method, route, body) => (await source.get()).call(method, route, body) };
    return {
      engine: { move: (options) => engine.send({ reason: "move", final: options?.final === true }), check: () => engine.check() },
      myCloud,
      /** The bot as its place has it: still there, not moving elsewhere, not one that stays there, and the person's name. */
      async prepare() {
        if (fromComputer && !computerReady()) throw Object.assign(new Error(TEAM_MOVE_TEXT.computerMoving()), { final: true });
        const listed = await myCloud.call("GET", "/api/bots?messages=0");
        const bots = Array.isArray(listed.body?.bots) ? listed.body.bots : [];
        const bot = bots.find((entry) => entry?.id === move.bot.id) ?? null;
        if (!listed.ok) throw Object.assign(new Error(`${fromComputer ? "OpenMausBot on this computer" : "My Cloud"} did not answer.`), { status: listed.status });
        if (!bot) throw Object.assign(new Error(`${move.bot.name} is no longer on ${place}.`), { final: true, why: "gone" });
        if (bot.movedTo && bot.movedTo.team?.id !== move.team.id) throw Object.assign(new Error(`${bot.name} is moving to ${bot.movedTo.team?.name}.`), { final: true, why: "elsewhere" });
        if (fromComputer) {
          if (computer?.busy?.(bot.id)) throw Object.assign(new Error(`${bot.name} is moving to My Cloud.`), { final: true, why: "elsewhere" });
          const stays = computerStays(bots, bot.id, move.team.id);
          if (stays) throw Object.assign(new Error(STAYS_TEXT[stays](bot.name)), { final: true, why: stays });
        } else if (bot.chiefOfStaff) throw Object.assign(new Error(`${bot.name} is your Chief of Staff, which stays on My Cloud.`), { final: true, why: "chief" });
        const config = await myCloud.call("GET", "/api/config").catch(() => null);
        facts.threadId = typeof bot.threadId === "string" ? bot.threadId : null;
        facts.label = sentence(config?.body?.profile?.name) ?? sentence(account()?.state()?.account?.email?.split("@")[0]) ?? "you";
        scope.label = facts.label;
        return { threadId: facts.threadId, label: facts.label };
      },
      team: {
        async begin() {
          await target.get();
          if (begun?.name) scope.name = begun.name;
          return begun;
        },
        async done(on) {
          const session = await target.get();
          if (!session) return;
          const switched = await session.call("POST", `/api/team-move-in/${move.bot.id}/done`, { v: 1, on });
          if (!switched.ok) throw Object.assign(new Error(sentence(switched.body?.error) ?? `${move.team.name} did not switch ${move.bot.name}'s routines on.`), { status: switched.status });
        },
      },
      close: async () => { await source.close(); await target.close(); },
    };
  }

  const moves = createTeamMove({ journal: journal ?? jsonFile(journalFile), open, inTeam: (id) => Boolean(teamOf(id)), onChange: () => onChange(), log });

  /** The page's place: My Cloud's page moves My Cloud's bots, this computer's page this computer's; any other asks nothing. */
  const placeOf = (event) => {
    const page = cloudPage(event);
    return page === "cloud" ? "cloud" : page === "local" && computer ? "computer" : null;
  };
  const myPage = (channel, handler) => (event, ...args) => {
    const from = placeOf(event);
    if (!from) throw new Error(`${channel} is only available on My Cloud or this computer in this app`);
    return handler(from, ...args);
  };
  // The page asks on every server, including a solo app and a custom base URL. Electron reports a throw from this
  // handler as "Error occurred in handler for 'cloud-send:teams'" and the desktop window dies, so anywhere else the answer is no teams.
  ipcMain.handle("cloud-send:teams", (event) => {
    const from = placeOf(event);
    if (!from || (from === "computer" && !computerReady())) return { teams: [] };
    return { teams: teams().map(({ id, name, ready }) => ({ id, name, ready })), from };
  });
  const moveToTeam = (from, botId, teamId, name) => {
    const team = teamOf(String(teamId));
    if (!team) throw teamMoveRefusal("notInTeam");
    if (!ID.test(String(botId))) throw teamMoveRefusal("notABot");
    if (from === "computer" && !computerReady()) throw teamMoveRefusal("computerMoving");
    void moves.start({ bot: { id: String(botId), name: sentence(name) ?? "This bot" }, team: { id: team.id, name: team.name, origin: team.origin }, ...(from === "computer" ? { from } : {}) });
    return moves.view(from);
  };
  const coded = (work) => async (...args) => {
    try { return { view: await work(...args) }; } catch (error) {
      if (!error?.refusal) throw error;
      return { refused: { ...error.refusal, message: error.message } };
    }
  };
  ipcMain.handle("cloud-send:team-move", myPage("cloud-send:team-move", moveToTeam));
  ipcMain.handle("cloud-send:team-move-coded", myPage("cloud-send:team-move-coded", coded(moveToTeam)));
  ipcMain.handle("cloud-send:team-retry", myPage("cloud-send:team-retry", (from) => { void moves.retry(); return moves.view(from); }));
  ipcMain.handle("cloud-send:team-open", myPage("cloud-send:team-open", (_from, teamId) => {
    const team = teamOf(String(teamId));
    if (!team) throw new Error("You're not in that team.");
    openTeam?.({ id: team.id, name: team.name });
  }));

  /** This computer's bots a move into a team offers, each with why it stays, if it does; none while they are not its own
   * to move. The list and names come from its own server, never from a page. */
  async function computerBots() {
    if (!computer || !computerReady()) return [];
    const listed = await computerSession(computer).call("GET", "/api/bots?messages=0");
    if (!listed.ok) throw new Error("OpenMausBot on this computer did not answer.");
    return bringableBots(listed.body?.bots).filter((bot) => !computer.busy?.(bot.id));
  }
  /** Of `ids`, this computer's bots that may go, by its own list: none of them names a bot that stays. */
  async function chosenComputerBots(ids) {
    const asked = new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => ID.test(id)).slice(0, BATCH_MAX));
    const going = new Map((await computerBots()).filter((bot) => !bot.stays).map(({ id, name }) => [id, { id, name }]));
    const bots = [...asked].map((id) => going.get(id)).filter(Boolean);
    if (!bots.length) throw teamMoveRefusal("notABot");
    return bots;
  }
  const startComputerBots = (bots, team) => {
    void moves.startMany(bots.map((bot) => ({ bot, team: { id: team.id, name: team.name, origin: team.origin }, from: "computer" })));
    return moves.view("computer");
  };
  // This computer's own page: its bots, and several of them moved into a team the person chose there, one after another.
  ipcMain.handle("cloud-send:team-choices", myPage("cloud-send:team-choices", async (from) => (from === "computer" ? { bots: await computerBots() } : { bots: [] })));
  ipcMain.handle("cloud-send:team-move-many", myPage("cloud-send:team-move-many", coded(async (from, ids, teamId) => {
    if (from !== "computer") throw teamMoveRefusal("notABot");
    const team = teamOf(String(teamId));
    if (!team) throw teamMoveRefusal("notInTeam");
    if (!computerReady()) throw teamMoveRefusal("computerMoving");
    return startComputerBots(await chosenComputerBots(ids), team);
  })));

  // Security: a team's server is not the person's own, so its page reaches My Cloud's and this computer's bots only
  // through these. It names a bot by id and learns its name and what can go; the team is the page's own by the Admin's
  // word, the names come from My Cloud and this computer, and nothing goes until the person says so in a confirm no page draws.
  const pageTeam = (event) => {
    const origin = pageOrigin(event);
    return origin ? teams().find((team) => team.origin === origin) ?? null : null;
  };
  let bringList = null;
  async function myCloudBots() {
    if (bringList && Date.now() - bringList.at < BRING_LIST_MS) return bringList.bots;
    const target = home();
    if (!target) return [];
    const session = await openOwnerSession(target, fetchImpl, { label: t("native.teamMove.sessionLabel"), background: false });
    try {
      const listed = await session.call("GET", "/api/bots?messages=0");
      if (!listed.ok) throw new Error(t("native.teamMove.homeNoAnswer"));
      bringList = { at: Date.now(), bots: bringableBots(listed.body?.bots) };
      return bringList.bots;
    } finally { await session.close().catch(() => {}); }
  }
  ipcMain.handle("cloud-send:team-bring", async (event) => {
    const team = pageTeam(event);
    if (!team) return { bots: [] };
    const [bots, fromComputer] = await Promise.all([myCloudBots().catch(() => []), computerBots().catch(() => [])]);
    return { team: { id: team.id, name: team.name, ready: team.ready }, bots, ...(fromComputer.length ? { computer: fromComputer } : {}) };
  });
  ipcMain.handle("cloud-send:team-bring-move", async (event, botId, from) => {
    const team = pageTeam(event);
    if (!team?.ready) throw new Error(t("native.teamMove.openTeam"));
    const fromComputer = from === "computer";
    const bot = (await (fromComputer ? computerBots() : myCloudBots())).find((entry) => entry.id === String(botId));
    if (!bot || bot.stays) throw new Error(t("teamMove.refused.notABot"));
    if (!(await confirmMove(teamMoveConfirmWords({ bot: bot.name, team: team.name }, t, { from: fromComputer ? "computer" : "cloud" })))) return { started: false, move: moves.view() };
    void moves.start({ bot: { id: bot.id, name: bot.name }, team: { id: team.id, name: team.name, origin: team.origin }, ...(fromComputer ? { from: "computer" } : {}) });
    bringList = null;
    return { started: true, move: moves.view() };
  });
  ipcMain.handle("cloud-send:team-bring-many", async (event, ids) => {
    const team = pageTeam(event);
    if (!team?.ready) throw new Error(t("native.teamMove.openTeam"));
    const bots = await chosenComputerBots(ids).catch(() => { throw new Error(t("teamMove.refused.notABot")); });
    const names = { bot: bots[0].name, team: team.name };
    if (!(await confirmMove(teamMoveConfirmWords(names, t, { from: "computer", bots: bots.map((bot) => bot.name) })))) return { started: false, move: moves.view() };
    return { started: true, move: startComputerBots(bots, team) };
  });
  ipcMain.handle("cloud-send:team-bring-status", (event) => {
    const team = pageTeam(event), move = moves.view();
    return team && move?.team.id === team.id ? move : null;
  });

  return {
    kick: () => moves.kick(),
    view: (from) => moves.view(from),
    seen: (from) => moves.seen(from),
    start: (input) => moves.start(input),
    startMany: (inputs) => moves.startMany(inputs),
    retry: () => moves.retry(),
    close: () => moves.close(),
    journal: () => (journal ?? jsonFile(journalFile)).read(),
    /** This bot is on its way into a team now: no other move takes it meanwhile. */
    moving: (botId) => { const held = moves.moving(botId); return Boolean(held) && !held.stopped; },
  };
}
