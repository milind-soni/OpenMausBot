// A routine's run that tried to hand work to a bot it may not reach. coordinate_bots refuses while the turn runs, and the
// model may say anything after, so the run keeps who it was refused and ends saying so plainly, instead of "completed":
// nothing arrived. The person who wrote the routine reads it in their inbox, whoever else the bot's failures reach.
import { resolveTeammate, unreachableTeammate, type RosterMember } from "../peer-roster.ts";
import { serverLine } from "../server-lines.ts";
import type { Delivery } from "./person-inbox.ts";

/** `shown`: this caller may already identify the bot, so its name may be said. A bot it may not be shown (another
 * audience's, an archived one, one a person's reach keeps from it) is recorded without a name: the refusal is still the
 * run's to report, but the bot is never named in it. */
type Refused = { target: RosterMember; from: RosterMember; shown: boolean };

/** One receipt from the call this bookkeeping is fed: the id the call really delivered to, and whether it arrived. The
 * text the model wrote is never used to decide that, since an id prefix can be shared. */
export interface HandoffReceipt { botId: string; outcome: string }

/** The receipts in a coordinate_bots answer, narrowed to the two fields the bookkeeping reads. The answer is the route's
 * own JSON, so nothing here asserts a shape it did not check or reads the text the model wrote. */
export function handoffReceipts(value: unknown): HandoffReceipt[] {
  return (Array.isArray(value) ? value as Array<{ botId?: unknown; outcome?: unknown }> : [])
    .flatMap((receipt) => typeof receipt.botId === "string" && typeof receipt.outcome === "string" ? [{ botId: receipt.botId, outcome: receipt.outcome }] : []);
}

export interface RefusedHandoffDeps {
  bots(): readonly RosterMember[];
  /** A bot `from` may never be told of (personal-reach.ts hides). */
  hides?(from: RosterMember, target: RosterMember): boolean;
  /** A bot the person's own reach shows `from` (personal-reach.ts listed): the coordinate route resolves a spelling to it,
   * so this bookkeeping names it too, and a bot it does not show stays unnamed. */
  listed?(from: RosterMember, target: RosterMember, threadId: string): boolean;
  /** The run this conversation is, when it is one. */
  runOf(threadId: string): { routineId: string; botId: string } | undefined;
  /** The person key of who wrote this routine; absent off a Cloud and for a routine nobody wrote. */
  writerOf(routineId: string): string | undefined;
  /** Who this bot's failures in this conversation are for. */
  askedPerson(botId: string, threadId: string): string | null;
  /** This conversation is that person's own, where their failures stay rather than reaching their inbox. */
  theirOwn(threadId: string, person: string): boolean;
  /** Every person's inbox, made after this. */
  inbox(): { deliver(person: string, delivery: Delivery): unknown };
  /** The language of a line in this conversation. */
  language(threadId: string): string | undefined;
}

export function createRefusedHandoffs(deps: RefusedHandoffDeps) {
  const refused = new Map<string, Map<string, Refused>>();
  const toldWriter = new Map<string, string>();

  /** The bot `raw` names that this caller may not reach, and whether it may identify it. A bot here that only another
   * audience answers to, or that a person's reach keeps from this bot, is a refusal that names nobody (`shown: false`):
   * it is still the run's to report, but its name never reaches the run's failure or the writer's notice. Whether the
   * caller may identify it is settled by the coordinate route's own rule (`resolveTeammate`, with the same reach), so a
   * bot `list_bots` shows is named and one it does not is not. A spelling naming no bot here at all — a typo — or a bot
   * this caller may reach records nothing: the call's own receipts are the only account of what was sent. */
  function identify(raw: string, from: RosterMember, threadId: string): Refused | null {
    const bots = deps.bots();
    const hides = (bot: RosterMember) => deps.hides?.(from, bot) === true;
    const apart = unreachableTeammate(bots, from, raw, hides);
    if (!apart) return null;
    const resolved = resolveTeammate(bots, from, raw, () => null, {
      reaches: (bot) => deps.listed?.(from, bot, threadId) === true,
      hides,
      refusal: () => null,
    });
    return { target: apart, from, shown: !("error" in resolved) && resolved.id === apart.id };
  }

  function words(threadId: string, seen: readonly Refused[]): string {
    const language = deps.language(threadId), bot = seen[0]!.from.name;
    const shown = seen.filter((one) => one.shown).map(({ target }) => target.name).join(", ");
    return [seen.some((one) => !one.shown) ? serverLine(language, "server.runs.handoffApartUnnamed", { bot }) : "",
      shown ? serverLine(language, "server.runs.handoffApart", { bot, target: shown }) : ""].filter(Boolean).join(" ");
  }

  return {
    /** A coordinate_bots call in a routine's run came back: remembers the bots it could not reach, and forgets one this
     * call's own receipts say it reached since, by the id the roster resolved to. */
    settled(threadId: string, from: RosterMember, named: readonly string[], status: number, receipts: readonly HandoffReceipt[] = []): void {
      if (!deps.runOf(threadId)) return;
      const seen = refused.get(threadId) ?? new Map<string, Refused>();
      for (const raw of named) {
        const target = status >= 400 ? identify(raw, from, threadId) : null;
        if (target) seen.set(target.target.id, target);
      }
      // Which bot a retry went to comes from the delivery itself: a receipt's canonical id, never the text the model wrote.
      // Text matching here let one bot's id prefix clear a refusal for a bot nothing was ever sent to.
      for (const { botId, outcome } of receipts) if (outcome === "queued" || outcome === "injected") seen.delete(botId);
      if (seen.size) refused.set(threadId, seen);
      else refused.delete(threadId);
    },
    /** The run in this conversation is ending well: what it must say instead, once; null when nothing was refused. */
    take(threadId: string): string | null {
      const seen = [...refused.get(threadId)?.values() ?? []];
      if (!seen.length) return null;
      refused.delete(threadId);
      const said = words(threadId, seen);
      const run = deps.runOf(threadId), writer = run && deps.writerOf(run.routineId);
      const asked = run ? deps.askedPerson(run.botId, threadId) : null, inboxedAnyway = writer === asked && !deps.theirOwn(threadId, asked!);
      if (run && writer && !inboxedAnyway && toldWriter.get(run.routineId) !== said) {
        toldWriter.set(run.routineId, said);
        const from = seen[0]!.from;
        deps.inbox().deliver(writer, {
          kind: "notice", from: { name: from.name, botId: from.id }, origin: { botId: run.botId, threadId }, notify: "routine-failed",
          title: serverLine(deps.language(threadId), "server.runs.handoffRefusedTitle", { bot: from.name }), text: said, quiet: writer === asked,
        });
      }
      return said;
    },
  };
}

export type RefusedHandoffs = ReturnType<typeof createRefusedHandoffs>;
