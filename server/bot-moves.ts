// My Cloud's side of moving one of its bots into one of its person's teams (electron/team-move.mjs runs the move). While
// the bot goes it takes no turns here and its automations are off, and which ones were on is kept, so they come back on
// if the move stops. Once it lives in the team its routines are gone from here (they run there), and the bot stays here
// archived, with its notes about the person, as the line that opens it in the team.
import type { BotMovedTo } from "../shared/wire.ts";
import type { AppTriggerManager } from "./app-triggers.ts";
import type { RoutineManager } from "./routines.ts";
import type { BotRecord } from "./store.ts";
import type { WebhookManager } from "./webhooks.ts";

export interface BotMovesDeps {
  store: { bot(id: string): BotRecord | null | undefined; patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null };
  routines(): Pick<RoutineManager, "listRoutines" | "update" | "removeForBot"> | null;
  webhooks(): Pick<WebhookManager, "list" | "update"> | null;
  appEvents(): Pick<AppTriggerManager, "list" | "update"> | null;
  /** A turn or a routine run of this bot is going. */
  busy(botId: string): boolean;
  now?: () => number;
}

type Team = BotMovedTo["team"];
/** What the move switched off here, by key ("routine:<id>"), to switch back on if it stops. */
type Held = BotMovedTo & { held?: string[] };

/** Why this bot takes no turn here, or null. */
export function botMoveRefusal(bot: Pick<BotRecord, "name"> & { movedTo?: BotMovedTo } | null | undefined): string | null {
  const moved = bot?.movedTo;
  if (!moved) return null;
  return moved.state === "moved" ? `${bot!.name} lives in ${moved.team.name} now.` : `${bot!.name} is moving to ${moved.team.name}. It's ready there in a moment.`;
}

/** A turn of this bot starts here only while it is not moving or moved. */
export function assertBotHere(bot: Pick<BotRecord, "name"> & { movedTo?: BotMovedTo } | null | undefined): void {
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
  const movedOf = (bot: BotRecord | null | undefined): Held | undefined => (bot as (BotRecord & { movedTo?: Held }) | null | undefined)?.movedTo;

  return {
    /** The bot stops here for the move: no turns, its automations off. Busy while it answers; a bot already moved stays
     * moved. Holding it again keeps what the first hold switched off. */
    async hold(botId: string, team: Team): Promise<{ movedTo: Held } | { busy: string } | { refused: string }> {
      const bot = deps.store.bot(botId);
      if (!bot) return { refused: "This bot is no longer here." };
      if (bot.defaultBot) return { refused: `${bot.name} stays here: everyone on a team gets their own.` };
      const held = movedOf(bot);
      if (held?.state === "moved") return held.team.id === team.id ? { movedTo: held } : { refused: botMoveRefusal(bot)! };
      if (held && held.team.id !== team.id) return { refused: botMoveRefusal(bot)! };
      if (!held && deps.busy(botId)) return { busy: bot.name };
      const off = held?.held ?? [];
      const next: Held = { team, state: "moving", at: held?.at ?? now(), held: off };
      deps.store.patchBot(botId, { movedTo: next } as Partial<BotRecord>);
      for (const automation of automations(botId)) {
        if (!automation.on) continue;
        // Kept before it is switched off, so a stop half-way still switches it back on.
        if (!off.includes(automation.key)) off.push(automation.key);
        deps.store.patchBot(botId, { movedTo: { ...next, held: [...off] } } as Partial<BotRecord>);
        await switchTo(automation.key, false);
      }
      return { movedTo: movedOf(deps.store.bot(botId))! };
    },
    /** The move stopped before the bot arrived: it is here again as it was, its automations back on. */
    async release(botId: string): Promise<{ released: true } | { refused: string }> {
      const bot = deps.store.bot(botId);
      const held = movedOf(bot);
      if (!bot || !held) return { released: true };
      if (held.state === "moved") return { refused: botMoveRefusal(bot)! };
      for (const key of held.held ?? []) await switchTo(key, true);
      deps.store.patchBot(botId, { movedTo: undefined } as Partial<BotRecord>);
      return { released: true };
    },
    /** The bot lives in the team now: archived here as the line that opens it there, its routines gone from here. */
    moved(botId: string, team: Team): { movedTo: Held } | { refused: string } {
      const bot = deps.store.bot(botId);
      const held = movedOf(bot);
      if (!bot || !held || held.team.id !== team.id) return { refused: "This bot is not moving to that team." };
      if (held.state !== "moved") {
        deps.routines()?.removeForBot(botId);
        deps.store.patchBot(botId, { movedTo: { ...held, state: "moved", at: now() }, hidden: true } as Partial<BotRecord>);
      }
      return { movedTo: movedOf(deps.store.bot(botId))! };
    },
  };
}

export type BotMoves = ReturnType<typeof createBotMoves>;
