// A routine's run that tried to hand work to a bot it may not reach. coordinate_bots refuses while the turn runs, and the
// model may say anything after, so the run keeps who it was refused and ends saying so plainly, instead of "completed":
// nothing arrived. The person who wrote the routine reads it in their inbox, whoever else the bot's failures reach.
import { namesTeammate, unreachableTeammate, type RosterMember } from "../peer-roster.ts";
import { serverLine } from "../server-lines.ts";
import type { Delivery } from "./person-inbox.ts";

type Refused = { target: RosterMember; from: RosterMember };

export interface RefusedHandoffDeps {
  bots(): readonly RosterMember[];
  /** A bot `from` may never be told of (personal-reach.ts hides). */
  hides?(from: RosterMember, target: RosterMember): boolean;
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

  function words(threadId: string, seen: readonly Refused[]): string {
    const language = deps.language(threadId), bot = seen[0]!.from.name;
    const named = (some: readonly Refused[]) => some.map(({ target }) => target.name).join(", ");
    return serverLine(language, "server.runs.handoffApart", { bot, target: named(seen) });
  }

  return {
    /** A coordinate_bots call in a routine's run came back: remembers the bots it could not reach, and forgets one it has reached since. */
    settled(threadId: string, from: RosterMember, named: readonly string[], status: number): void {
      if (!deps.runOf(threadId)) return;
      const seen = refused.get(threadId) ?? new Map<string, Refused>();
      for (const raw of named) {
        const target = status >= 400 ? unreachableTeammate(deps.bots(), from, raw, (bot) => deps.hides?.(from, bot) === true) : null;
        if (target) seen.set(target.id, { target, from });
        if (status < 400) for (const [id, was] of seen) if (namesTeammate(was.target, raw)) seen.delete(id);
      }
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
