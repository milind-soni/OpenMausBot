// The server's side of moving one of its bots to another home: from My Cloud into one of its person's teams
// (electron/team-move.mjs runs the move), from this computer to My Cloud (electron/bot-move-main.mjs), or from My Cloud to
// one of the person's computers. While the bot goes it takes no turns here and its automations are off, and which ones were
// on is kept, so they come back on if the move stops. Once it lives there the bot stays here archived, as the line that
// opens it there. Its routines are gone from here when it went into a team; a bot that went to a place of the person's
// own (My Cloud, or one of their computers) keeps them here switched off, and comes back as it was if My Cloud ends.
//
// A bot coming back to a place it left is held there too ("returning"): its line stays hidden and takes no turns, but a
// move compares it, so what it has here is brought up to date rather than made again beside it, and the newer side wins.
// Stopped, it is the line it was. Arrived, it is live here again: routines that were on there are on, and on a computer a
// webhook or app event stays off, as does an MCP server that runs a command here the bot did not use here before
// (move-back.ts keeps what was done, to be told). A bot is never live in two places and nothing of it is deleted.
//
// A hold that asks to lapse (`lapse`) lets the bot go on by itself unless it is held again within HOLD_LAPSE_MS: the
// computer that runs a move may sleep half-way, and the bot then goes on working where it is. Only My Cloud's own hold of
// a bot leaving it lapses: My Cloud is the side that switches first on the way to a computer, so before its switch the bot
// is live there and nowhere else. A computer's hold, and a returning hold anywhere, never lapses: by the time it would,
// the other side may already have switched, and letting go then would make two live copies, or none.
//
// The invariant, at every point of any order of holds, copies, switches, arrivals, lapses, crashes and retries the two
// sides can see: the bot is never live in two places. It is live in none only while a move holds it: paused at its place
// until the move goes on or (My Cloud's hold) lapses, or between the two switch steps, from where the move only goes
// forward. Between moves it is live in exactly one, and a try always finishes (bot-moves.test.ts, "the invariant").
import type { BotMovedTo } from "../shared/wire.ts";
import type { AppTriggerManager } from "./app-triggers.ts";
import type { Arrivals, ArrivedFacts, MovedAutomation, StaysOnCloud } from "./move-back.ts";
import type { RoutineManager } from "./routines.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import type { WaitManager } from "./waits.ts";
import type { WebhookManager } from "./webhooks.ts";

/** The "team" a bot moving from this computer to My Cloud goes to. */
export const MY_CLOUD_TEAM = "my-cloud";
/** The "team" a bot moving from My Cloud to one of the person's computers goes to: `computer-<installation>`, as several
 * computers share one Cloud. A team's own id is the Admin's UUID, never this shape. */
export const COMPUTER_TEAM_PREFIX = "computer-";
/** A place of the person's own: My Cloud, or one of their computers. */
export const personalTeam = (id: string) => id === MY_CLOUD_TEAM || (id.startsWith(COMPUTER_TEAM_PREFIX) && id.length > COMPUTER_TEAM_PREFIX.length);
/** How long a hold that asked to lapse holds without being asked again. */
export const HOLD_LAPSE_MS = 30 * 60_000;

export interface BotMovesDeps {
  store: { bot(id: string): BotRecord | null | undefined; patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
    bots?: readonly BotRecord[]; groups?: ReadonlyArray<Pick<GroupRecord, "id" | "memberIds" | "dm">>; patchGroup?(id: string, patch: { memberIds: string[] }): unknown };
  routines(): Pick<RoutineManager, "listRoutines" | "update" | "removeForBot"> | null;
  webhooks(): Pick<WebhookManager, "list" | "update"> | null;
  appEvents(): Pick<AppTriggerManager, "list" | "update"> | null;
  waits(): Pick<WaitManager, "all" | "cancel"> | null;
  /** A turn or a routine run of this bot is going. */
  busy(botId: string): boolean;
  now?: () => number;
  /** This server is one of the person's computers, not My Cloud: what arrives here keeps webhooks, app events and new
   * command MCP servers off. */
  computer?: boolean;
  /** The MCP servers this server mounts for the bot, and which run a command here (move-back.ts mcpServersHere). */
  mcp?(botId: string): { all: string[]; command: string[] };
  /** Where what each arrival did is kept (move-back.ts arrivalsFile). */
  arrivals?: Arrivals;
  /** What My Cloud keeps of the person's when this bot leaves it for a computer. */
  stays?(botId: string): StaysOnCloud;
  /** How often lapsing holds are looked at; none: only when sweep() is called. */
  lapseCheckMs?: number;
  log?(line: string): void;
}

type Team = BotMovedTo["team"];
/** What the move switched off here, by key ("routine:<id>"), to switch back on if it stops; the rest is the server's own
 * and never read by a phone. */
type Held = BotMovedTo & {
  held?: string[];
  /** A lapsing hold lets the bot go on by itself at this time unless it is held again first. */
  lapseAt?: number;
  /** The bot is coming back here: hidden, no turns, compared by the move. */
  back?: true;
  /** A first arrival, made here already held (arrivalMark): stopped, it is the line of where it lives. */
  arrival?: true;
  /** What this place had of it before it came back: the MCP servers it used here (null: every one). */
  had?: { mcp: string[] | null };
  /** The archived switch the move sent while it came back, set once it arrived. */
  archived?: boolean;
};
/** A first arrival's hold, set as the move makes the bot here (POST /api/bots `arriving`): hidden and held from its first
 * write, with nothing here before it. */
export function arrivalMark(team: Team, at: number): Held { return { team, state: "moving", at, back: true, arrival: true, had: { mcp: [] } }; }

type HoldAnswer = { movedTo: Held } | { busy: string } | { refused: string; here?: true };

/** Why this bot takes no turn here, or null. */
export function botMoveRefusal(bot: Pick<BotRecord, "name"> & { movedTo?: BotMovedTo; home?: BotRecord["home"] } | null | undefined): string | null {
  if (bot?.home) return `${bot.name} lives on ${bot.home.placeName}: its turns run there, not here.`;
  const moved = bot?.movedTo;
  if (!moved) return null;
  if ((moved as Held).back) return `${bot!.name} is coming here from ${moved.team.name}. It's ready here in a moment.`;
  return moved.state === "moved" ? `${bot!.name} lives in ${moved.team.name} now.` : `${bot!.name} is moving to ${moved.team.name}. It's ready there in a moment.`;
}

/** A turn of this bot starts here only while it is not moving or moved. */
export function assertBotHere(bot: Pick<BotRecord, "name"> & { movedTo?: BotMovedTo; home?: BotRecord["home"] } | null | undefined): void {
  const said = botMoveRefusal(bot);
  if (said) throw Object.assign(new Error(said), { status: 409, code: "moved" });
}

export function createBotMoves(deps: BotMovesDeps) {
  const now = deps.now ?? Date.now;
  const automations = (botId: string) => [
    ...(deps.routines()?.listRoutines() ?? []).filter((routine) => routine.botId === botId).map((routine) => ({ key: `routine:${routine.id}`, on: routine.enabled })),
    ...(deps.webhooks()?.list() ?? []).filter((hook) => hook.botId === botId).map((hook) => ({ key: `webhook:${hook.id}`, on: hook.enabled })),
    ...(deps.appEvents()?.list() ?? []).filter((trigger) => trigger.botId === botId).map((trigger) => ({ key: `app-event:${trigger.id}`, on: trigger.enabled })),
  ];
  async function switchTo(key: string, on: boolean): Promise<void> {
    const [kind, id] = key.split(":") as [string, string];
    if (kind === "routine") deps.routines()?.update(id, { enabled: on });
    else if (kind === "webhook") deps.webhooks()?.update(id, { enabled: on });
    else if (kind === "app-event") await deps.appEvents()?.update(id, { enabled: on });
  }
  /** Each kind's keeper is there to switch these back on: none is dropped unswitched while the server starts. */
  const ready = (keys: readonly string[]) => keys.every((key) => (key.startsWith("routine:") ? deps.routines() : key.startsWith("webhook:") ? deps.webhooks()
    : key.startsWith("app-event:") ? deps.appEvents() : true) !== null);
  const movedOf = (bot: BotRecord | null | undefined): Held | undefined => (bot as (BotRecord & { movedTo?: Held }) | null | undefined)?.movedTo;
  const cancelWaits = (botId: string) => {
    const waits = deps.waits();
    for (const wait of waits?.all() ?? []) if (wait.botId === botId) waits!.cancel(wait.id, botId);
  };
  const lapsing = (lapse: boolean) => (lapse ? { lapseAt: now() + HOLD_LAPSE_MS } : {});
  /** A lapsing hold past its time no longer holds, whether or not the sweep has let the bot go yet. */
  const lapsed = (held: Held | undefined) => held?.state === "moving" && held.lapseAt !== undefined && held.lapseAt <= now();
  const set = (botId: string, movedTo: Held | undefined, more: Partial<BotRecord> = {}) => deps.store.patchBot(botId, { movedTo, ...more } as Partial<BotRecord>);

  /** A room some of whose bots stay goes on here without this one; one all of whose bots left is kept as it was. */
  const leaveRooms = (botId: string) => {
    for (const room of deps.store.groups ?? []) {
      if (room.dm || !room.memberIds.includes(botId)) continue;
      if (room.memberIds.every((id) => id === botId || deps.store.bot(id)?.movedTo || deps.store.bot(id)?.defaultBot)) continue;
      deps.store.patchGroup?.(room.id, { memberIds: room.memberIds.filter((id) => id !== botId) });
    }
  };

  /** The bot comes back here: its line is held as returning; a bot live here with this id is not taken over. */
  function holdReturning(bot: BotRecord, held: Held | undefined, team: Team): HoldAnswer {
    if (held?.back) return held.team.id === team.id ? { movedTo: held } : { refused: botMoveRefusal(bot)! };
    if (held?.state === "moved") {
      if (held.team.id !== team.id) return { refused: botMoveRefusal(bot)! };
      const { lapseAt: _lapse, ...kept } = held;
      const next: Held = { ...kept, state: "moving", at: now(), back: true, had: held.had ?? { mcp: bot.mcpServers ? [...bot.mcpServers] : null } };
      set(bot.id, next, { hidden: true });
      return { movedTo: next };
    }
    if (held) return { refused: botMoveRefusal(bot)! };
    // A bot live here with this id is the person's own: the move never hides it. A first arrival is made already held
    // (arrivalMark, by POST /api/bots over the move's own caller), so it is never live here first.
    return { refused: `${bot.name} is already here.`, here: true };
  }

  /** The automations of this bot, of one kind, by id and name. */
  const named = (list: ReadonlyArray<{ id: string; name: string; botId: string }> | undefined, botId: string, keys: Set<string>, kind: string): MovedAutomation[] =>
    (list ?? []).filter((entry) => entry.botId === botId && keys.has(`${kind}:${entry.id}`)).map((entry) => ({ id: entry.id, name: entry.name }));

  /** The command MCP servers the bot would use here that it did not use here before (`had`; none known: none new). */
  function newCommandServers(bot: BotRecord, had: Held["had"]): string[] {
    if (!deps.mcp || !had) return [];
    const here = deps.mcp(bot.id);
    const uses = (list: readonly string[] | null) => (list === null ? here.command : here.command.filter((name) => list.includes(name)));
    const before = new Set(uses(had.mcp));
    return uses(bot.mcpServers ?? null).filter((name) => !before.has(name));
  }
  const switchOffServers = (bot: BotRecord, off: readonly string[]) => {
    if (!off.length) return;
    const gone = new Set(off);
    deps.store.patchBot(bot.id, { mcpServers: (bot.mcpServers ?? deps.mcp?.(bot.id).all ?? []).filter((name) => !gone.has(name)) });
  };

  /** What arriving does here, decided once and kept before any of it is done. */
  function arrivalFacts(bot: BotRecord, held: Held, on: readonly string[]): ArrivedFacts {
    const keys = new Set(on);
    const routines = named(deps.routines()?.listRoutines(), bot.id, keys, "routine");
    const webhooks = named(deps.webhooks()?.list(), bot.id, keys, "webhook");
    const appEvents = named(deps.appEvents()?.list(), bot.id, keys, "app-event");
    const mcpServers = deps.computer ? newCommandServers(bot, held.had) : [];
    const computer = deps.computer === true;
    return { v: 1, from: held.team, hold: held.at, at: now(), place: computer ? "computer" : "cloud",
      on: { routines, webhooks: computer ? [] : webhooks, appEvents: computer ? [] : appEvents },
      offHere: { webhooks: computer ? webhooks : [], appEvents: computer ? appEvents : [], mcpServers } };
  }

  const moves = {
    /** The bot stops here for the move: no turns, its automations off and its waits cancelled. Busy while it answers; a
     * bot already moved stays moved. Holding it again keeps what the first hold switched off, and renews a lapsing hold.
     * `back`: it is coming back here instead (holdReturning). */
    //
    // For the engine that runs a move (slice B): holding again after a lapse is not a renewal but a new hold, with a new
    // `at`, and the bot may have worked in between; whenever the `at` it gets back changes, the move copies again before
    // it switches. `lapse` is honoured only on My Cloud's hold of a bot leaving it (see the top of this file).
    async hold(botId: string, team: Team, { lapse = false, back = false }: { lapse?: boolean; back?: boolean } = {}): Promise<HoldAnswer> {
      const bot = deps.store.bot(botId);
      if (!bot) return { refused: "This bot is no longer here." };
      if (bot.defaultBot) return { refused: `${bot.name} stays here: everyone on a team gets their own.` };
      // Past its time, a hold is let go of first: holding again is a new hold, with a new `at`.
      if (lapsed(movedOf(bot)) && ready(movedOf(bot)!.held ?? [])) await moves.release(botId);
      const held = movedOf(deps.store.bot(botId) ?? bot);
      if (back) return holdReturning(deps.store.bot(botId) ?? bot, held, team);
      lapse &&= !deps.computer;
      if (held?.back) return { refused: botMoveRefusal(bot)! };
      if (held?.state === "moved") return held.team.id === team.id ? { movedTo: held } : { refused: botMoveRefusal(bot)! };
      if (held && held.team.id !== team.id) return { refused: botMoveRefusal(bot)! };
      if (!held && deps.busy(botId)) return { busy: bot.name };
      const off = held?.held ?? [];
      const next: Held = { team, state: "moving", at: held?.at ?? now(), held: off, ...lapsing(lapse) };
      set(botId, next);
      for (const automation of automations(botId)) {
        if (!automation.on) continue;
        // Kept before it is switched off, so a stop half-way still switches it back on.
        if (!off.includes(automation.key)) off.push(automation.key);
        set(botId, { ...next, held: [...off] });
        await switchTo(automation.key, false);
      }
      cancelWaits(botId);
      return { movedTo: movedOf(deps.store.bot(botId))! };
    },
    /** The move stopped before the bot arrived: it is here again as it was, its automations back on. A bot that was coming
     * back is the line of where it lives again, nothing of it switched on: it is live there. */
    async release(botId: string): Promise<{ released: true } | { refused: string }> {
      const bot = deps.store.bot(botId);
      const held = movedOf(bot);
      if (!bot || !held) return { released: true };
      if (held.state === "moved") return { refused: botMoveRefusal(bot)! };
      if (held.back) {
        // What it had here before stays known, so a later try still tells what is new here.
        const { back: _back, arrival: _arrival, archived: _archived, lapseAt: _lapse, ...kept } = held;
        set(botId, { ...kept, state: "moved" }, { hidden: true });
        return { released: true };
      }
      for (const key of held.held ?? []) await switchTo(key, true);
      set(botId, undefined);
      return { released: true };
    },
    /** The bot lives in the team now: archived here as the line that opens it there, its routines and waits gone from here.
     * One that went to a place of the person's own keeps its routines here, off; leaving My Cloud for a computer, the
     * answer says what My Cloud keeps of the person's. */
    moved(botId: string, team: Team): { movedTo: Held; stays?: StaysOnCloud } | { refused: string } {
      const bot = deps.store.bot(botId);
      const held = movedOf(bot);
      if (!bot || !held || held.back || held.team.id !== team.id || lapsed(held)) return { refused: "This bot is not moving to that team." };
      if (held.state !== "moved") {
        if (personalTeam(team.id)) leaveRooms(botId); else deps.routines()?.removeForBot(botId);
        cancelWaits(botId);
        const { lapseAt: _lapse, ...kept } = held;
        set(botId, { ...kept, state: "moved", at: now() }, { hidden: true });
      }
      const stays = team.id.startsWith(COMPUTER_TEAM_PREFIX) ? deps.stays?.(botId) : undefined;
      return { movedTo: movedOf(deps.store.bot(botId))!, ...(stays ? { stays } : {}) };
    },
    /** The bot that was coming back is here: live again, as the move made it. `on`: what was on where it came from (the
     * hold's `held` there). Asked again, the same answer. */
    async arrived(botId: string, team: Team, on: readonly string[]): Promise<{ arrived: ArrivedFacts } | { refused: string }> {
      const bot = deps.store.bot(botId);
      if (!bot) return { refused: "This bot is no longer here." };
      const held = movedOf(bot);
      const kept = deps.arrivals?.get(botId) ?? null;
      if (!held) return kept && kept.from.id === team.id ? { arrived: kept } : { refused: "This bot is not coming here." };
      if (!held.back || held.team.id !== team.id || lapsed(held)) return { refused: "This bot is not coming here from there." };
      // Kept before anything is done: a server stopped half-way does the rest, the same way, when asked again.
      const facts = kept && kept.from.id === team.id && kept.hold === held.at ? kept : arrivalFacts(bot, held, on);
      if (facts !== kept) deps.arrivals?.put(botId, facts);
      switchOffServers(bot, facts.offHere.mcpServers);
      for (const routine of facts.on.routines) await switchTo(`routine:${routine.id}`, true);
      for (const hook of facts.on.webhooks) await switchTo(`webhook:${hook.id}`, true);
      for (const trigger of facts.on.appEvents) await switchTo(`app-event:${trigger.id}`, true);
      set(botId, undefined, { hidden: held.archived ?? false });
      return { arrived: facts };
    },
    /** My Cloud ended: a bot that moved there is here again as it was when it went, its automations left off. */
    back(botId: string): { released: true } | { refused: string } {
      const bot = deps.store.bot(botId);
      const held = movedOf(bot);
      if (!bot || !held) return { released: true };
      if (!personalTeam(held.team.id)) return { refused: botMoveRefusal(bot)! };
      // A try to bring it back that stopped left the newer side's fields on its line: command servers it did not use here
      // before stay off.
      if (deps.computer) switchOffServers(bot, newCommandServers(bot, held.had));
      set(botId, undefined, { hidden: false });
      return { released: true };
    },
    /** The bot's hold, or its line, as this server keeps it (`holding`: a hold or line that still holds), and what its last
     * arrival here did. */
    state(botId: string): { movedTo: Held | null; holding: boolean; arrived: ArrivedFacts | null } | null {
      const bot = deps.store.bot(botId);
      const held = movedOf(bot);
      return bot ? { movedTo: held ?? null, holding: Boolean(held) && !lapsed(held), arrived: deps.arrivals?.get(botId) ?? null } : null;
    },
    /** When the first lapsing hold here runs out, so a sleeping Cloud wakes to let its bot go on; null when none. */
    nextLapseAt(): number | null {
      const times = (deps.store.bots ?? []).map((bot) => movedOf(bot)).filter((held) => held?.state === "moving" && held.lapseAt !== undefined).map((held) => held!.lapseAt!);
      return times.length ? Math.min(...times) : null;
    },
    /** Lapsing holds not renewed in time let their bots go on, as a stopped move does. The ids let go of. */
    async sweep(): Promise<string[]> {
      const gone: string[] = [];
      for (const bot of deps.store.bots ?? []) {
        const held = movedOf(bot);
        if (!lapsed(held) || !ready(held!.held ?? [])) continue;
        await moves.release(bot.id);
        deps.log?.(`bot move: ${bot.name} was held for a move that did not go on, and goes on here`);
        gone.push(bot.id);
      }
      return gone;
    },
    close() { if (timer) clearInterval(timer); },
  };
  const timer = deps.lapseCheckMs ? setInterval(() => { void moves.sweep().catch((error) => deps.log?.(`bot move: ${(error as Error)?.message ?? error}`)); }, deps.lapseCheckMs) : null;
  timer?.unref?.();
  return moves;
}

export type BotMoves = ReturnType<typeof createBotMoves>;
