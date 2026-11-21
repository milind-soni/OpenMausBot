import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { ModelSelection, RuntimeEvent } from "../contracts.ts";
import { turnLimitScope } from "../quota-switch.ts";
import type { Store } from "../store.ts";
import { nothingRan, type TurnStops } from "../turn-outcome.ts";
import type { LimitTakeover } from "./limit-takeover.ts";

/** A room member: only the backups the bot has of its own carry it on, since Automatic recovery leaves channels out. */
type Member = { id: string; name: string; modelSelection: ModelSelection; fallback?: ModelSelection[] };
type TurnEnded = Extract<RuntimeEvent, { type: "turn.completed" }>;

export interface RoomLimitTakeoverDeps {
  store: Pick<Store, "activePath">;
  turnStops: Pick<TurnStops, "read" | "failureCause">;
  takeover(): Pick<LimitTakeover, "takeoverAtStart" | "heldAtStart" | "noteRuntimeEvent">;
}

export function createRoomLimitTakeover(deps: RoomLimitTakeoverDeps) {
  const selections = new Map<string, ModelSelection>();
  const resending = new Set<string>();

  return {
    atStart: (member: Member, approvalMode: ApprovalMode) =>
      deps.takeover().takeoverAtStart({ id: member.id, name: member.name, approvalMode }, member.modelSelection, member.fallback ?? []),
    dispatched(threadId: string, selection: ModelSelection): void {
      selections.set(threadId, selection);
    },
    selectionOf: (threadId: string): ModelSelection | undefined => selections.get(threadId),
    noteEvent(speakerId: string, event: RuntimeEvent): void {
      deps.takeover().noteRuntimeEvent(speakerId, selections.get(event.threadId), event);
    },
    /** Runs `again` once when this member's turn ended refused at a usage limit or a sign-out before it said or did
     * anything, and a backup now takes its next turn: a turn that ran anything would run it twice. */
    async resendOnce<T>(threadId: string, member: Member, approvalMode: ApprovalMode, ended: TurnEnded | undefined, since: number,
      again: () => Promise<T>): Promise<T | undefined> {
      const key = `${threadId}\u0000${member.id}`;
      if (!ended || ended.ok || resending.has(key)) return undefined;
      const said = deps.turnStops.failureCause(ended);
      if (!turnLimitScope(ended, deps.turnStops.read(threadId, ended.turnId)?.flags, said)) return undefined;
      if (!nothingRan(deps.store.activePath(threadId), since, ended.turnId, said)) return undefined;
      if (!deps.takeover().heldAtStart({ id: member.id, name: member.name, approvalMode }, member.modelSelection, false, member.fallback ?? [])) return undefined;
      resending.add(key);
      try {
        return await again();
      } finally {
        resending.delete(key);
      }
    },
  };
}

export type RoomLimitTakeover = ReturnType<typeof createRoomLimitTakeover>;
