// A routine's run refused the computer the person lends My Cloud, only because the routine isn't confirmed as theirs.
// The bot hears why and is told to say it, but may say anything after (that nothing was there to use, that files are
// gone), so the app says it itself, every run it applies to, until the person saves the routine:
// - a run that tried to use the computer and was refused, and never got it after, fails with the sentence (it reads
//   "didn't finish", it is said on every run, and it never spaces the routine out: only saving it helps);
// - a run that only listed the computers ends as it would, its reply posted as usual with the sentence under it.
// A call that gets the computer later in the same run (the person saved it meanwhile) forgets the refusal.
import { serverLine } from "../server-lines.ts";
import type { RefusedRunLine } from "../routine-recovery.ts";
import type { RoutineRunStatus } from "../../shared/routines.ts";

type Device = "PC" | "Mac" | "computer";
type Refusal = { name: string; device: Device; used: boolean; startedAt?: number };

/** What fits in a failed run's error (routines.ts keeps 500 characters): a long name gives way, never the instruction. */
const ERROR_ROOM = 500;
const NAME_ROOM = 80;

export interface RefusedLendingDeps {
  /** The run this conversation is, when it is one; `startedAt` tells a retry of it from the attempt that was refused. */
  runOf(threadId: string): { id: string; startedAt?: number } | undefined;
  /** Where the run with this id stands; nothing once its row left the history. */
  statusOf(runId: string): RoutineRunStatus | undefined;
  /** The kind of computer the person lends now; null when they lend none, and a refusal cost the run nothing. */
  lentDevice(): Device | null;
  /** The language of a line in this conversation. */
  language(threadId: string): string | undefined;
}

const NOT_FINISHED: ReadonlySet<RoutineRunStatus> = new Set<RoutineRunStatus>(["queued", "running", "waiting"]);

export function createRefusedLending(deps: RefusedLendingDeps) {
  const refused = new Map<string, Refusal>();
  /** Runs that completed after only listing: the line their report carries, by run id. */
  const notes = new Map<string, Omit<Refusal, "used" | "startedAt">>();

  const sentence = (language: string | undefined, { name, device }: Pick<Refusal, "name" | "device">) =>
    serverLine(language, "server.runs.lentComputerUnconfirmed", { name: name.length > NAME_ROOM ? `${name.slice(0, NAME_ROOM - 1).trimEnd()}…` : name, device });

  return {
    /** The run `runId`, in this conversation, was refused the lent computer for the routine `name`: `used` when it tried
     * to use it (a call, or asking for it), not only to list it. */
    refused(threadId: string, runId: string, name: string, used: boolean): void {
      const device = deps.lentDevice(), run = deps.runOf(threadId);
      if (!device || run?.id !== runId) return;
      // A run that has ended never takes its own, so it keeps none.
      for (const id of refused.keys()) {
        const status = id === runId ? undefined : deps.statusOf(id);
        if (id !== runId && (status === undefined || !NOT_FINISHED.has(status))) refused.delete(id);
      }
      const before = refused.get(runId);
      refused.set(runId, { name, device, used: used || (before !== undefined && before.startedAt === run.startedAt && before.used), startedAt: run.startedAt });
    },
    /** The run in this conversation got the lent computer: what it was refused before no longer holds. */
    allowed(threadId: string): void {
      const run = deps.runOf(threadId);
      if (run) refused.delete(run.id);
    },
    /** The run in this conversation is ending well, after `handoff` (a refused hand-off's words, or null): what it must
     * fail with instead, or null to end as it would; a run that only listed keeps its line for its report. */
    ending(threadId: string, handoff: string | null): string | RefusedRunLine | null {
      const run = deps.runOf(threadId), seen = run && refused.get(run.id);
      if (run) refused.delete(run.id);
      // A retry starts afresh: the attempt that was refused is not the one ending now.
      if (!run || !seen || seen.startedAt !== run.startedAt) return handoff;
      const said = sentence(deps.language(threadId), seen);
      if (!seen.used && !handoff) {
        if (notes.size >= 500) notes.delete(notes.keys().next().value!);
        notes.set(run.id, { name: seen.name, device: seen.device });
        return null;
      }
      const text = handoff ? `${said} ${handoff}`.slice(0, ERROR_ROOM) : said;
      return seen.used ? { text, partial: false, lendingRefused: true } : { text, partial: false };
    },
    /** The line a completed run's report carries under its reply, once (automation-reports.ts `notes`). */
    notes: {
      has: (runId: string): boolean => notes.has(runId),
      take(runId: string, language: string | undefined): string | null {
        const note = notes.get(runId);
        notes.delete(runId);
        return note ? sentence(language, note) : null;
      },
    },
  };
}

export type RefusedLending = ReturnType<typeof createRefusedLending>;
