// Which note a person's line carries in this conversation: on a place several people sign in to, each person's line in a
// chat more than one of them can write in is named; a member's private chat and a one-person place keep the bare line.
import { labelledLine } from "../peer-provenance.ts";
import { AUTHORITY, fromNoteWith, routineWho, type LineLabels } from "../provenance-label.ts";
import { speakerOf, type PersonName } from "../replies.ts";
import type { RoutineRunTrigger } from "../routines.ts";
import type { ResolvedSender } from "../../shared/wire.ts";

export interface LineLabelDeps {
  sharedChat(threadId: string): boolean;
  userName(threadId: string): PersonName;
  teamRole(personKey: string | undefined): string | undefined;
  /** The routine whose run this conversation is, by name. */
  routineName(threadId: string): string | undefined;
}

const ROUTINE_RUNS: ReadonlySet<RoutineRunTrigger | undefined> = new Set<RoutineRunTrigger | undefined>(["schedule", "manual", "startup"]);

export function createLineLabels(deps: LineLabelDeps) {
  const lineLabels = (threadId: string): LineLabels => {
    const name = deps.userName(threadId);
    return { shared: deps.sharedChat(threadId), name: (line) => speakerOf(name, line), role: (line) => deps.teamRole(line.sender?.id) };
  };
  return {
    lineLabels,
    /** A line about to wait or join a running turn: its note goes with it, so a batch keeps each person's name. */
    personPrompt: (threadId: string, sender: ResolvedSender | undefined, text: string): string => labelledLine({ role: "user", sender }, text, lineLabels(threadId)),
    routineRunNote: (threadId: string, source: RoutineRunTrigger | undefined): string => ROUTINE_RUNS.has(source)
      ? `${fromNoteWith(routineWho(deps.routineName(threadId)), "run", AUTHORITY.behalf, "no one is present")}\n` : "",
  };
}
