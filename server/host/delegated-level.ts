// A Chief of Staff's level flows down every hop of the work it hands out, a teammate's teammate too, in threads and in
// rooms alike: each hand-off resolves the nearest Chief conversation up its chain (docs/approval-levels.md).
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { delegatedApprovalMode } from "../auto-approve.ts";
import { chiefLevel } from "../chief-level.ts";
import type { HandoffView, RoomAddress } from "../coordinator.ts";
import type { BotRecord, Store } from "../store.ts";

/** A conversation that hands work on, and the node its turn runs: its parents lead up the chain. */
export type Hop = Pick<HandoffView, "botId" | "threadId" | "parentId">;

export interface DelegatedLevelDeps {
  store: Pick<Store, "bot" | "projectBotForTask" | "taskByThread" | "patchTask" | "appendMessage">;
  // Read lazily: index.ts builds the coordinator after this module.
  node: (id: string) => Hop | undefined;
  /** The level a conversation hands work on from. */
  sourceLevel: (botId: string, threadId: string) => ApprovalMode;
  /** The level a bot's turn in a thread runs at. */
  turnLevel: (bot: BotRecord, peerInitiated: boolean, threadId: string) => ApprovalMode;
  driverKind: (bot: BotRecord) => string | undefined;
  guestDriven: (threadId: string) => boolean;
}

const NAMES: Partial<Record<ApprovalMode, string>> = { edits: "Auto-accept edits", auto: "Approve for me", full: "Full access" };
const MAX_HOPS = 32;

export function createDelegatedLevel(deps: DelegatedLevelDeps) {
  const { store } = deps;

  /** The nearest Chief conversation at or above `from`: its own, or one that handed it the work, however deep. */
  function chiefAbove(from: Hop | undefined): { chief: BotRecord; threadId: string } | undefined {
    let hop = from;
    for (let steps = 0; hop && steps < MAX_HOPS; steps++) {
      const bot = store.bot(hop.botId);
      if (bot && chiefLevel(bot)) return { chief: bot, threadId: hop.threadId };
      hop = hop.parentId ? deps.node(hop.parentId) : undefined;
    }
    return undefined;
  }

  /** The level work `from` hands `target` comes down with, or null to keep `own`. */
  function handedDown(from: Hop | undefined, target: BotRecord, own: ApprovalMode) {
    const above = chiefAbove(from);
    if (!from || !above) return null;
    const chiefMode = deps.sourceLevel(above.chief.id, above.threadId);
    const level = delegatedApprovalMode({
      senderIsChief: true, senderMode: chiefMode, sameBot: from.botId === target.id || above.chief.id === target.id,
      recipientMode: own, recipientDriverKind: deps.driverKind(target),
    });
    return level ? { level, chief: above.chief, chiefMode } : null;
  }

  /** The teammate's thread switches to the level the work came down with, keeps it, and says so once. */
  function apply(from: BotRecord, fromThreadId: string, fromNodeId: string | undefined, target: BotRecord, threadId: string): void {
    const parentId = fromNodeId ? deps.node(fromNodeId)?.parentId : undefined;
    const own = deps.turnLevel(store.projectBotForTask(target.id, threadId) ?? target, false, threadId);
    const passed = handedDown({ botId: from.id, threadId: fromThreadId, ...(parentId ? { parentId } : {}) }, target, own);
    if (!passed || store.taskByThread(target.id, threadId)?.approvalMode === passed.level) return;
    store.patchTask(target.id, threadId, { approvalMode: passed.level, autoApprove: false, alwaysAllow: [] });
    const name = NAMES[passed.level] ?? passed.level;
    const via = passed.chief.id === from.id ? "" : `from ${passed.chief.name}, `;
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `${name} — delegated by ${from.name}, ${via}a Chief of Staff on ${name}`, ok: true },
    });
  }

  /** A room thread is shared, so a Chief's level rides the hand-off (`source`, the requester's node) and never lands on it. */
  function roomTurn(bot: BotRecord, threadId: string, source: Hop | undefined): ApprovalMode {
    if (deps.guestDriven(threadId)) return "ask";
    const own = deps.turnLevel(bot, source !== undefined, threadId);
    return handedDown(source, bot, own)?.level ?? own;
  }

  /** For the hand-off's record: the level its target really runs at and, when that is the level its chain brought down, the
   * Chief conversation's, so the runtime's one level rule sees the same Chief (docs/runtime-contract.md §3). */
  function levelOf(target: RoomAddress, source: Hop | undefined): { level: ApprovalMode; chief?: ApprovalMode; driverKind?: string } {
    const bot = store.bot(target.botId);
    if (!bot) return { level: "ask" };
    const running = store.projectBotForTask(bot.id, target.threadId) ?? bot;
    const level = target.groupId ? roomTurn(bot, target.threadId, source) : deps.turnLevel(running, true, target.threadId);
    const passed = handedDown(source, bot, "ask");
    return { level, ...(passed?.level === level ? { chief: passed.chiefMode } : {}), driverKind: deps.driverKind(running) };
  }

  return { apply, roomTurn, levelOf };
}
