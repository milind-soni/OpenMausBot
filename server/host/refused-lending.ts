// A routine's run refused the computer the person lends My Cloud, only because the routine isn't confirmed as theirs.
// The bot hears why and is told to say it, but may say anything after (that nothing was there to use, that files are
// gone), so the run keeps the refusal and ends saying it in the app's own words, instead of "completed": the line in the
// chat it reports to and the routine's failed notification carry the sentence, whatever the bot wrote.
import { serverLine } from "../server-lines.ts";
import type { RoutineRunStatus } from "../../shared/routines.ts";

type Device = "PC" | "Mac" | "computer";

export interface RefusedLendingDeps {
  /** The run this conversation is, when it is one. */
  runOf(threadId: string): { id: string } | undefined;
  /** Where the run with this id stands; nothing once its row left the history. */
  statusOf(runId: string): RoutineRunStatus | undefined;
  /** The kind of computer the person lends now; null when they lend none, and a refusal cost the run nothing. */
  lentDevice(): Device | null;
  /** The language of a line in this conversation. */
  language(threadId: string): string | undefined;
}

const NOT_FINISHED: ReadonlySet<RoutineRunStatus> = new Set<RoutineRunStatus>(["queued", "running", "waiting"]);

export function createRefusedLending(deps: RefusedLendingDeps) {
  const refused = new Map<string, { name: string; device: Device }>();
  return {
    /** The run `runId`, in this conversation, was refused the lent computer for the routine `name`. */
    refused(threadId: string, runId: string, name: string): void {
      const device = deps.lentDevice();
      if (!device || deps.runOf(threadId)?.id !== runId) return;
      // A run that has ended never takes its own, so it keeps none.
      for (const id of refused.keys()) {
        const status = id === runId ? undefined : deps.statusOf(id);
        if (id !== runId && (status === undefined || !NOT_FINISHED.has(status))) refused.delete(id);
      }
      refused.set(runId, { name, device });
    },
    /** The run in this conversation is ending well: what it must say instead, once; null when it was never refused. */
    take(threadId: string): string | null {
      const run = deps.runOf(threadId), seen = run && refused.get(run.id);
      if (!run || !seen) return null;
      refused.delete(run.id);
      return serverLine(deps.language(threadId), "server.runs.lentComputerUnconfirmed", { name: seen.name, device: seen.device });
    },
  };
}

export type RefusedLending = ReturnType<typeof createRefusedLending>;
