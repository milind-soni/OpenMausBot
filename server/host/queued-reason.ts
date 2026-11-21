import type { PersonWaitKind } from "../../shared/person-wait.ts";
import type { HandoffView } from "../coordinator.ts";

export interface QueuedReasonDeps {
  botName(botId: string): string | undefined;
  /** The handoff already ran and is parked until the computer it needs is free of other turns and of a person's hold. */
  waitsForComputer(node: HandoffView): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  /** The bot's threads that hold a slot now, and how many it may run at once when a bot starts the work. */
  slots(botId: string): { busy: { threadId: string; title: string }[]; limit: number };
  groupTurn(botId: string): boolean;
  behindPerson(node: HandoffView): { kind: PersonWaitKind; title: string } | undefined;
}

/** `showTitle`: name the busy threads it allows; only for the receiver itself, whose own threads they are. Otherwise just the count. */
export function createQueuedReason(deps: QueuedReasonDeps) {
  return (node: HandoffView, showTitle?: (threadId: string) => boolean): string => {
    const card = deps.behindPerson(node);
    if (card) return `waiting for a free slot: that teammate is waiting on the person's ${card.kind === "question" ? "answer" : card.kind} in its thread ${JSON.stringify(card.title)}; tell the person to open it`;
    // A room's handoff waits on the room, not on these.
    if (node.groupId) return "waiting for that teammate to be free";
    const name = deps.botName(node.botId) ?? "that teammate";
    if (deps.waitsForComputer(node)) return "waiting for the computer it needs, which another turn or a person is using";
    if (deps.threadBusy(node.botId, node.threadId)) return "waiting for an earlier turn in that thread to finish";
    const { busy, limit } = deps.slots(node.botId);
    if (busy.length >= limit) {
      const named = showTitle ? busy.filter((thread) => showTitle(thread.threadId)) : [];
      const which = named.length ? `: ${named.map((thread) => JSON.stringify(thread.title)).join(", ")}` : "";
      return `waiting for a free thread slot: ${name} is already running ${busy.length} of ${limit} threads at once${which}`;
    }
    if (deps.groupTurn(node.botId)) return `waiting for ${name} to finish its turn in a room`;
    return "waiting for that teammate to be free";
  };
}
