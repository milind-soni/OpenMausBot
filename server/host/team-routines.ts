// A Team Cloud's routines and the audience rule (docs/team-cloud.md "Routines"): the person whose private chat a routine
// lives in (routine-home.ts), whether a bot's turn may know of it, where its results may go, and what happens to a
// leaver's routines (team-member-left.ts). Off a team no routine is anyone's, and every answer here is the plain one.
import { basename } from "node:path";

import type { createCloudRoutineAuthors } from "../cloud-lending.ts";
import { CLOUD_NOBODY_KEY } from "../cloud-sharing.ts";
import { routineHome, type RoutineHomeDeps, type RoutinePlace } from "../routine-home.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import type { TeamMemberLeftDeps } from "./team-member-left.ts";

export const NO_SUCH_TRIGGER = "No trigger with that id belongs to this bot. Call trigger_info without trigger_id to see its ids.";

export interface TeamRoutinesDeps extends RoutineHomeDeps {
  team: boolean;
  /** index.ts's routines, made after this host. */
  routines(): Pick<RoutineManager, "listRoutines" | "update" | "removeForBot"> | null;
  authors: Pick<ReturnType<typeof createCloudRoutineAuthors>, "forget" | "wrote" | "writer" | "remove"> | null;
  /** Runs `work` with `writer` as whoever opens the chats it makes (index.ts's withRoutineWriter). */
  withWriter<T>(writer: string, work: () => T): T;
}

export function createTeamRoutines(deps: TeamRoutinesDeps) {
  /** The person whose private chat a routine lives in on a Team Cloud; null anywhere else. */
  const home = (routine: RoutinePlace): string | null => (deps.team ? routineHome(routine, deps) : null);
  /** A turn's bot tools reach a private routine only in its person's own conversations. */
  const inTurn = (routine: RoutinePlace, threadId: string): boolean => {
    const person = home(routine);
    return person === null || person === deps.privateTo(threadId);
  };
  /** A routine whose writer left runs as `to`'s (a person key; null: nobody's, whose asks go to the Admins), and stops
   * reporting into a chat of the person who left. */
  const hand = (id: string, left: string, to: string | null): void => {
    const writer = to ?? CLOUD_NOBODY_KEY;
    deps.authors?.forget(id);
    deps.authors?.wrote(id, writer);
    const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id);
    if (routine?.resultsThreadId && deps.privateTo(routine.resultsThreadId) === left) deps.withWriter(writer, () => deps.routines()!.update(id, { resultsThreadId: null }));
  };
  return {
    home,
    inTurn,
    /** A private routine never reports into a chat outside its person's: its results get a new chat of theirs. */
    reportsElsewhere(routine: Routine): boolean {
      const person = home(routine);
      return Boolean(person && routine.resultsThreadId && deps.privateTo(routine.resultsThreadId) !== person);
    },
    /** Why a bot's change to a trigger by id is refused in this conversation: one that lives in someone else's private chat. */
    hiddenTrigger(request: { kind: string; proposal?: { routineId?: string } }, threadId: string): string | null {
      const id = request.kind === "schedule" ? request.proposal?.routineId : undefined;
      const named = id ? deps.routines()?.listRoutines().find((routine) => routine.id === id) : undefined;
      return named && !inTurn(named, threadId) ? NO_SUCH_TRIGGER : null;
    },
    /** The leave clean-up's part in routines. */
    leaving: {
      routines: () => (deps.routines()?.listRoutines() ?? []).map((routine) => ({ id: routine.id, name: routine.name, botId: routine.botId, home: home(routine),
        writer: deps.authors?.writer(routine.id), files: (routine.attachments ?? []).map((file) => basename(file.path)) })),
      deleteRoutine: (id: string) => { const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id); if (routine) { deps.routines()!.removeForBot(routine.botId, id); deps.authors?.remove(id); } },
      handRoutine: hand,
    } satisfies Pick<TeamMemberLeftDeps, "routines" | "deleteRoutine" | "handRoutine">,
  };
}

export type TeamRoutines = ReturnType<typeof createTeamRoutines>;
