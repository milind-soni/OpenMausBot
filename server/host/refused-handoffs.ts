// A routine's run that tried to hand work to a bot it may not reach. coordinate_bots refuses while the turn runs, and the
// model may say anything after, so the run keeps who it was refused and ends saying so plainly, instead of "completed":
// nothing arrived. The person who wrote the routine reads it in their inbox, whoever else the bot's failures reach.
import { namesTeammate, unreachableTeammate, type RosterMember } from "../peer-roster.ts";
import { serverLine } from "../server-lines.ts";
import type { RoutineRunStatus } from "../../shared/routines.ts";
import type { Delivery } from "./person-inbox.ts";

/** The run that made a call, as it was before the call went out: a call can outlive it. */
type Run = { id: string; routineId: string; botId: string };
type Refused = { target: RosterMember; from: RosterMember };
/** Who each run was refused by, per run and per bot: another run's late answer is never this run's. */
type Refusals = Map<string, Map<string, Refused>>;
/** The statuses a run still to finish has: the repo's own set of unfinished rows (routine-run-history.ts, routine-due.ts).
 * Every other status ends the run, and a run that has ended never calls `take()` again. */
const NOT_FINISHED: ReadonlySet<RoutineRunStatus> = new Set<RoutineRunStatus>(["queued", "running", "waiting"]);
/** Whether the run with this status can still say a refusal: it has a row the manager would hand `take()`, and has not ended. */
const canSpeak = (status: RoutineRunStatus | undefined): boolean => status !== undefined && NOT_FINISHED.has(status);

export interface RefusedHandoffDeps {
  bots(): readonly RosterMember[];
  /** A bot `from` may never be told of (personal-reach.ts hides). */
  hides?(from: RosterMember, target: RosterMember): boolean;
  /** The run this conversation is, when it is one. */
  runOf(threadId: string): Run | undefined;
  /** Where the run with this id stands: `queued`, `running` or `waiting` while it can still say something, a finished
   * status or nothing at all (its row left the history) once it cannot. */
  statusOf(runId: string): RoutineRunStatus | undefined;
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
  const refused = new Map<string, Refusals>();
  const toldWriter = new Map<string, string>();

  function words(threadId: string, seen: readonly Refused[]): string {
    const language = deps.language(threadId), bot = seen[0]!.from.name;
    const named = (some: readonly Refused[]) => some.map(({ target }) => target.name).join(", ");
    return serverLine(language, "server.runs.handoffApart", { bot, target: named(seen) });
  }

  return {
    /** A coordinate_bots call came back: remembers the bots the run that made it could not reach, and forgets one it has reached since. */
    settled(threadId: string, from: RosterMember, named: readonly string[], status: number, run: Run | undefined): void {
      if (!run) return;
      // The run must still hold this conversation: another run's answer is not this one's.
      if (deps.runOf(threadId)?.id !== run.id) return;
      const byRun = refused.get(threadId) ?? new Map<string, Map<string, Refused>>();
      // A run that has ended can never say its refusal, so it keeps none; one still queued for its second start keeps its
      // id and conversation and can, so it does. The run that made this call keeps its own either way.
      for (const id of byRun.keys()) if (id !== run.id && !canSpeak(deps.statusOf(id))) byRun.delete(id);
      const mine = byRun.get(run.id) ?? new Map<string, Refused>();
      for (const raw of named) {
        const target = status >= 400 ? unreachableTeammate(deps.bots(), from, raw, (bot) => deps.hides?.(from, bot) === true) : null;
        if (target) mine.set(target.id, { target, from });
        if (status < 400) for (const [id, was] of mine) if (namesTeammate(was.target, raw)) mine.delete(id);
      }
      if (mine.size) byRun.set(run.id, mine);
      else byRun.delete(run.id);
      if (byRun.size) refused.set(threadId, byRun);
      else refused.delete(threadId);
    },
    /** The run in this conversation is ending well: what it must say instead, once; null when nothing was refused, or another run was. */
    take(threadId: string): string | null {
      const run = deps.runOf(threadId), byRun = refused.get(threadId);
      const seen = [...(run ? byRun?.get(run.id)?.values() ?? [] : [])];
      if (byRun) {
        // Said now or never: the run ending here keeps nothing, nor does one that has ended since. A run still queued for
        // its second start, or running, may yet say its own, so its records stay.
        for (const id of byRun.keys()) if (id === run?.id || !canSpeak(deps.statusOf(id))) byRun.delete(id);
        if (byRun.size) refused.set(threadId, byRun);
        else refused.delete(threadId);
      }
      if (!seen.length) return null;
      const said = words(threadId, seen);
      const writer = run && deps.writerOf(run.routineId);
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
