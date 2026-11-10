// Moving some of this computer's bots to My Cloud, while the rest go on here. This computer stays home, kept there by the
// switch that keeps its bots here, and never freezes: only the bots that go are held, each by its own hold on this
// computer's server (server/bot-moves.ts). Moving a bot from My Cloud into a team runs on the same phases (team-move.mjs):
// here one move carries a whole choice of bots to the "team" My Cloud, with the send kept to those bots (cloud-send.mjs).
import { randomUUID } from "node:crypto";

import { createTeamMove, parseTeamMoves } from "./team-move.mjs";
import { QUEUE_POLL_MS, switchOn } from "./one-home.mjs";

export const MY_CLOUD = Object.freeze({ id: "my-cloud", name: "My Cloud" });
const ID = /^[\w-]{1,128}$/u;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const nap = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The bots a person can choose from: every bot of this computer's but the helper every place has, one that moved, and an
 * archived one. */
export const choosable = (bots) => list(bots).filter((bot) => record(bot) && ID.test(bot.id ?? "") && typeof bot.name === "string" && !bot.defaultBot && !bot.hidden && !bot.movedTo);

/**
 * @param {{
 *   journal: { read(): unknown, write(value: unknown): void },
 *   local: { call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }> },
 *   send: { move(options: { final?: boolean, scope: string }): Promise<unknown>, check(options: { scope: string }): Promise<{ ok: boolean }> },
 *   session(): Promise<{ call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }> }>,
 *   lease?: { take(): Promise<null | { name: string }>, release(): Promise<void> },
 *   ready(): boolean,
 *   lend?(projects: string[]): Promise<unknown>,
 *   onChange?(): void,
 *   sleep?(ms: number): Promise<void>,
 *   now?(): number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void },
 *   log?(line: string): void,
 * }} deps `ready`: My Cloud is there to move to. `lease`: one computer at a time runs the heavy part of a move there.
 */
export function createBotMove({ journal, local, send, session, lease = null, ready, lend, onChange = () => {}, sleep = nap, now, timers, log = () => {} }) {
  const moves = () => parseTeamMoves(journal.read()).moves;
  const note = (id, change) => {
    const kept = parseTeamMoves(journal.read());
    journal.write({ ...kept, moves: kept.moves.map((entry) => (entry.bot.id === id ? { ...entry, ...change } : entry)) });
  };
  /** My Cloud reaches the folders of the bots that moved through this computer; while lending can't take them yet, a later look does. */
  let lending = false;
  async function lendWaiting() {
    if (lending) return;
    lending = true;
    try {
      for (const move of moves().filter((entry) => Array.isArray(entry.lend) && entry.phase === "done")) {
        try { if (move.lend.length) await lend?.(move.lend); note(move.bot.id, { lend: undefined }); }
        catch (error) { log(`bot move: lending waits (${error?.message ?? error})`); }
      }
    } finally { lending = false; }
  }

  function open(move) {
    let token = null;
    const current = () => moves().find((entry) => entry.bot.id === move.bot.id) ?? move;
    const ids = () => list(current().bots).map((bot) => bot.id);
    /** The chosen bots, named to this computer's server for this run: it keeps them in memory only. */
    const scope = async () => {
      if (token) return token;
      const asked = await local.call("POST", "/api/cloud-send/scope", { v: 1, bots: ids() });
      if (!asked.ok || typeof asked.body?.scope !== "string") throw Object.assign(new Error("OpenMausBot on this computer did not answer."), { status: asked.status });
      token = asked.body.scope;
      return token;
    };
    return {
      engine: {
        move: async (options) => send.move({ final: options?.final === true, scope: await scope() }),
        check: async () => send.check({ scope: await scope() }),
      },
      /** A hold, or its end, for each bot of the choice; a bot still answering is what the move waits for. */
      myCloud: {
        async call(method, _route, body) {
          if (body?.state === "moving") await lease?.take().catch(() => null);
          const held = [];
          for (const id of ids()) {
            const answer = await local.call(method, `/api/bot-moves/${id}`, body);
            if (!answer.ok) return answer;
            held.push(...list(answer.body?.movedTo?.held));
          }
          return { ok: true, status: 200, body: { v: 1, released: true, movedTo: { held } } };
        },
      },
      /** Only bots a move would carry go: an untouched one has nothing to carry, and stays here. */
      async prepare() {
        const listed = await local.call("GET", `/api/cloud-send?move=1&scope=${await scope()}`);
        if (!listed.ok) throw Object.assign(new Error("OpenMausBot on this computer did not answer."), { status: listed.status });
        const carried = new Set(list(listed.body?.items).filter((item) => item?.kind === "bot").map((item) => item.id));
        const bots = list(current().bots).filter((bot) => carried.has(bot.id));
        if (!bots.length) throw Object.assign(new Error("These bots have nothing to move yet."), { final: true });
        return { bots };
      },
      team: {
        /** Waits its turn at My Cloud, behind another computer's move there. */
        async begin() {
          for (let other = await lease?.take() ?? null; other; other = await lease.take()) {
            log(`bot move: waiting for ${other.name || "another computer"} to finish moving to My Cloud`);
            await sleep(QUEUE_POLL_MS);
          }
          return { name: move.bot.name };
        },
        /** My Cloud switches on what was on here, and keeps which computer the bots came from. */
        async done() {
          const there = await session();
          const held = list(current().held).filter((key) => typeof key === "string");
          for (const key of held) {
            const change = switchOn(key);
            if (!change) continue;
            const answer = await there.call(change.method, change.route, change.body);
            if (!answer.ok && answer.status !== 404) throw Object.assign(new Error(answer.body?.error ?? "My Cloud did not switch on an automation."), { status: answer.status });
          }
          const computer = String((await local.call("GET", "/api/cloud-connections").catch(() => null))?.body?.computer?.label ?? "").trim() || "this computer";
          const webhooks = held.flatMap((key) => (key.startsWith("webhook:") ? [key.slice("webhook:".length)] : []));
          const arrived = await there.call("POST", "/api/cloud-send/arrived", { v: 1, computer, webhooks });
          if (!arrived.ok) throw Object.assign(new Error(arrived.body?.error ?? "My Cloud did not finish the move."), { status: arrived.status });
          const going = new Set(ids());
          const bots = list((await local.call("GET", "/api/bots?messages=0").catch(() => null))?.body?.bots);
          note(move.bot.id, { lend: [...new Set(bots.filter((bot) => going.has(bot?.id) && typeof bot.cwd === "string" && bot.cwd).map((bot) => bot.cwd))] });
        },
      },
      close: async () => { await lease?.release().catch(() => {}); },
    };
  }

  const engine = createTeamMove({ journal, open, inTeam: () => ready(), onChange: () => onChange(), log, ...(now ? { now } : {}), ...(timers ? { timers } : {}) });

  return {
    kick: () => engine.kick().finally(lendWaiting),
    /** Moves this choice of bots for this account; bots already on their way are left out. Null when none is left to move. */
    start(bots, account = null) {
      const moving = new Set(moves().filter((move) => move.phase !== "done" && !move.stopped).flatMap((move) => list(move.bots).map((bot) => bot.id)));
      const fresh = bots.filter((bot) => !moving.has(bot.id));
      if (!fresh.length) return null;
      const id = `bots-${randomUUID()}`;
      void engine.start({ bot: { id, name: fresh[0].name }, team: MY_CLOUD, bots: fresh, account }).finally(lendWaiting).catch((error) => log(`bot move: ${error?.message ?? error}`));
      return id;
    },
    view: () => engine.view(),
    seen: () => engine.seen(),
    retry: () => engine.retry(),
    /** The bots on their way now, by id. */
    moving: () => moves().filter((move) => move.phase !== "done").flatMap((move) => list(move.bots).map((bot) => bot.id)),
    /** Everything is moving now instead: a choice still on its way stops, and its bots go on here until that move takes them.
     * One at its switch is past the point of no return (My Cloud has switched its automations on), so it finishes: let go
     * here, its bots would run in both places. */
    async drop() {
      for (const move of moves().filter((entry) => entry.phase !== "done" && entry.phase !== "switch")) {
        for (const bot of list(move.bots)) await local.call("DELETE", `/api/bot-moves/${bot.id}`).catch(() => null);
        const left = parseTeamMoves(journal.read());
        journal.write({ ...left, moves: left.moves.filter((entry) => entry.bot.id !== move.bot.id) });
      }
      onChange();
    },
    /** This account's My Cloud ended: the bots that moved there are here again as they went. */
    async back(account) {
      for (const move of moves().filter((entry) => entry.phase === "done" && entry.account === account)) {
        for (const bot of list(move.bots)) {
          const answer = await local.call("POST", `/api/bot-moves/${bot.id}`, { v: 1, state: "back", team: MY_CLOUD }).catch(() => null);
          if (!answer?.ok) { log(`bot move: ${bot.name} comes back later`); return; }
        }
        const left = parseTeamMoves(journal.read());
        journal.write({ ...left, moves: left.moves.filter((entry) => entry.bot.id !== move.bot.id) });
      }
      onChange();
    },
    close: () => engine.close(),
  };
}
