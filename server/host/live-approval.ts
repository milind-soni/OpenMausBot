import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { BotRecord, Store } from "../store.ts";

export interface LiveApprovalDeps {
  store: Pick<Store, "projectBotForTask">;
  /** The level a bot's turn in a thread runs at. */
  turnLevel: (bot: BotRecord, peerInitiated: boolean, threadId: string) => ApprovalMode;
}

/** A running turn's approval decisions use the conversation's saved level at the moment each one is made, never a copy
 * taken when the turn started, judged on the engine the turn runs on. */
export function createLiveApprovalMode(deps: LiveApprovalDeps) {
  return (running: BotRecord, threadId: string, peerInitiated: boolean): ApprovalMode => {
    const saved = deps.store.projectBotForTask(running.id, threadId);
    return deps.turnLevel(saved ? { ...saved, modelSelection: running.modelSelection } : running, peerInitiated, threadId);
  };
}
