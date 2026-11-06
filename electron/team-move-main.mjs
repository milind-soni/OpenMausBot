// Main's side of moving a bot from My Cloud into one of its person's teams (team-move.mjs): for each run, one owner
// session at My Cloud and one move-in sign-in at the team (through the Admin's team pairing, as the window signs in
// there), the send kept to that one bot (cloud-send.mjs), and the move's channels for My Cloud's own page. The teams come
// only from the Admin's verified session, never from a page.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createCloudSend } from "./cloud-send.mjs";
import { openOwnerSession } from "./cloud-send-main.mjs";
import { createTeamMove, teamMoveRefusal } from "./team-move.mjs";
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

/** What a native confirm says when a team's own page asks to bring a bot in: main's words, so no page can soften them. */
export function teamMoveConfirmWords(names, t = nativeText.englishText.t) {
  return {
    message: t("teamMove.title", names),
    detail: [
      t("teamMove.everyone", names),
      t("teamMove.goes", names),
      t("teamMove.private"),
      t("teamMove.staysOnMyCloud", names),
      t("teamMove.noWayBack"),
    ].join("\n\n"),
    buttons: [t("teamMove.confirm", names), t("native.common.cancel")],
  };
}

const BRING_LIST_MS = 30_000;

/** The bots on My Cloud a team's page offers: in the order My Cloud lists them, each with why it can't go, if it can't. */
export function bringableBots(listed) {
  const here = (Array.isArray(listed) ? listed : []).filter((bot) => record(bot) && ID.test(bot.id ?? "") && typeof bot.name === "string" && !bot.hidden && !bot.movedTo);
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
  const request = (method, route, init) => fetchImpl(`${origin}${route}`, {
    method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(120_000), ...init,
    headers: { accept: "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  return {
    call: async (method, route, body) => answer(await request(method, route, body === undefined ? { headers: {} }
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
    upload: async (route, bytes, type) => answer(await request("POST", route, { headers: { "content-type": type }, body: bytes })),
    close: async () => { await request("POST", "/api/auth/logout", { headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.body?.cancel()); },
  };
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   cloudPage(event: unknown): "local" | "cloud" | null,
 *   pageOrigin?(event: unknown): string | null,
 *   confirmMove?(words: { message: string, detail: string, buttons: string[] }): Promise<boolean>,
 *   home(): { origin: string, grant(): Promise<{ origin: string, code: string }> } | null,
 *   account(): { state(): any, pairTeam(teamId: string): Promise<{ origin: string, code: string }> } | null,
 *   file(): string,
 *   journalFile(): string,
 *   openTeam?(team: { id: string, name: string }): void,
 *   onChange?(): void,
 *   fetch?: typeof fetch,
 *   journal?: { read(): unknown, write(value: unknown): void },
 *   log?(line: string): void,
 *   t?(key: string, params?: Record<string, string | number>): string,
 * }} deps `home`: My Cloud and the Admin's code for it. `account`: the MausBot Cloud sign-in, whose verified session
 * names the person's teams. `file`: the send's own state; `journalFile`: the moves'. `openTeam`: shows the team's page.
 * `pageOrigin`: the origin of the page asking, when it is this window's active server's main frame. `confirmMove`: asks
 * the person outside any page.
 */
export function installTeamMove({ ipcMain, cloudPage, pageOrigin = () => null, confirmMove = async () => false, home, account, file, journalFile, openTeam, onChange = () => {}, fetch: fetchImpl = globalThis.fetch, journal, log = () => {}, t = nativeText.englishText.t }) {
  const teams = () => moveTeams(account()?.state());
  const teamOf = (id) => teams().find((team) => team.id === id) ?? null;
  const sendStore = jsonFile(file);

  function open(move) {
    const label = `Move to ${move.team.name}`;
    const source = lazy(() => {
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
        if (!asked.ok) throw Object.assign(new Error(sentence(asked.body?.error) ?? `${team.name} did not take ${move.bot.name}.`), { status: asked.status });
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
      store: sendStore,
      team: scope,
      onChange: () => onChange(),
    });
    const myCloud = { call: async (method, route, body) => (await source.get()).call(method, route, body) };
    return {
      engine: { move: (options) => engine.send({ reason: "move", final: options?.final === true }), check: () => engine.check() },
      myCloud,
      /** The bot as My Cloud has it: still there, not moving elsewhere, not its Chief of Staff, and the person's name. */
      async prepare() {
        const listed = await myCloud.call("GET", "/api/bots?messages=0");
        const bot = Array.isArray(listed.body?.bots) ? listed.body.bots.find((entry) => entry?.id === move.bot.id) : null;
        if (!listed.ok) throw Object.assign(new Error("My Cloud did not answer."), { status: listed.status });
        if (!bot) throw Object.assign(new Error(`${move.bot.name} is no longer on My Cloud.`), { final: true });
        if (bot.movedTo && bot.movedTo.team?.id !== move.team.id) throw Object.assign(new Error(`${bot.name} is moving to ${bot.movedTo.team?.name}.`), { final: true });
        if (bot.chiefOfStaff) throw Object.assign(new Error(`${bot.name} is your Chief of Staff, which stays on My Cloud.`), { final: true });
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

  const myCloudPage = (channel, handler) => (event, ...args) => {
    if (cloudPage(event) !== "cloud") throw new Error(`${channel} is only available on My Cloud in this app`);
    return handler(...args);
  };
  // The page asks on every server, including a solo app and a custom base URL. Electron reports a throw from this
  // handler as "Error occurred in handler for 'cloud-send:teams'" and the desktop window dies, so anywhere but My Cloud the answer is no teams.
  ipcMain.handle("cloud-send:teams", (event) => {
    if (cloudPage(event) !== "cloud") return { teams: [] };
    return { teams: teams().map(({ id, name, ready }) => ({ id, name, ready })) };
  });
  const moveToTeam = (botId, teamId, name) => {
    const team = teamOf(String(teamId));
    if (!team) throw teamMoveRefusal("notInTeam");
    if (!ID.test(String(botId))) throw teamMoveRefusal("notABot");
    void moves.start({ bot: { id: String(botId), name: sentence(name) ?? "This bot" }, team: { id: team.id, name: team.name, origin: team.origin } });
    return moves.view();
  };
  ipcMain.handle("cloud-send:team-move", myCloudPage("cloud-send:team-move", moveToTeam));
  ipcMain.handle("cloud-send:team-move-coded", myCloudPage("cloud-send:team-move-coded", (...args) => {
    try { return { view: moveToTeam(...args) }; } catch (error) {
      if (!error?.refusal) throw error;
      return { refused: { ...error.refusal, message: error.message } };
    }
  }));
  ipcMain.handle("cloud-send:team-retry", myCloudPage("cloud-send:team-retry", () => { void moves.retry(); return moves.view(); }));
  ipcMain.handle("cloud-send:team-open", myCloudPage("cloud-send:team-open", (teamId) => {
    const team = teamOf(String(teamId));
    if (!team) throw new Error("You're not in that team.");
    openTeam?.({ id: team.id, name: team.name });
  }));

  // Security: a team's server is not the person's own, so its page reaches My Cloud's bots only through these. It names a
  // bot by id and learns its name and what can go; the team is the page's own by the Admin's word, the name comes from My
  // Cloud, and nothing goes until the person says so in a confirm no page draws.
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
    return { team: { id: team.id, name: team.name, ready: team.ready }, bots: await myCloudBots().catch(() => []) };
  });
  ipcMain.handle("cloud-send:team-bring-move", async (event, botId) => {
    const team = pageTeam(event);
    if (!team?.ready) throw new Error(t("native.teamMove.openTeam"));
    const bot = (await myCloudBots()).find((entry) => entry.id === String(botId));
    if (!bot || bot.stays) throw new Error(t("teamMove.refused.notABot"));
    if (!(await confirmMove(teamMoveConfirmWords({ bot: bot.name, team: team.name }, t)))) return { started: false, move: moves.view() };
    void moves.start({ bot: { id: bot.id, name: bot.name }, team: { id: team.id, name: team.name, origin: team.origin } });
    bringList = null;
    return { started: true, move: moves.view() };
  });
  ipcMain.handle("cloud-send:team-bring-status", (event) => {
    const team = pageTeam(event), move = moves.view();
    return team && move?.team.id === team.id ? move : null;
  });

  return {
    kick: () => moves.kick(),
    view: () => moves.view(),
    seen: () => moves.seen(),
    start: (input) => moves.start(input),
    retry: () => moves.retry(),
    close: () => moves.close(),
    journal: () => (journal ?? jsonFile(journalFile)).read(),
  };
}
