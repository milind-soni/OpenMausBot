import { runningApprovalMode, supportsLiveApprovalMode, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { Store, BotRecord } from "../store.ts";
import type { ModelSelection } from "../contracts.ts";

export function createSourceApprovalMode(deps: {
  store(): Pick<Store, "projectBotForTask">;
  owner(botId: string, threadId: string): { bot: BotRecord; group?: unknown } | null;
  driverKind(selection: ModelSelection): string | undefined;
  forRequest(threadId: string, botId: string, fallback: () => ApprovalMode): ApprovalMode;
  approvalModeForTurn(bot: BotRecord, peerInitiated?: boolean, threadId?: string): ApprovalMode;
  isInternalTurn(threadId: string): boolean;
  directTurnBots: Pick<Map<string, BotRecord>, "get">;
  dispatchedApprovalModes: Pick<WeakMap<BotRecord, ApprovalMode>, "get">;
}) {
  return (botId: string, threadId: string): ApprovalMode => {
    const owner = deps.owner(botId, threadId);
    if (!owner) return "ask";
    const bot = deps.store().projectBotForTask(botId, threadId) ?? owner.bot;
    if (owner.group) return deps.forRequest(threadId, botId, () => deps.approvalModeForTurn(bot, false, threadId));
    // Native turns retain their dispatched ceiling; revocation still applies.
    if (!supportsLiveApprovalMode(deps.driverKind(bot.modelSelection))) {
      const dispatched = deps.directTurnBots.get(threadId);
      const mode = dispatched && deps.dispatchedApprovalModes.get(dispatched);
      if (dispatched?.id === botId && mode !== undefined) return runningApprovalMode(
        mode, deps.approvalModeForTurn(bot, deps.isInternalTurn(threadId), threadId), false);
    }
    return deps.approvalModeForTurn(bot, deps.isInternalTurn(threadId), threadId);
  };
}

export function effectiveRoomApprovalModeFor(input: {
  driverKind: string | undefined;
  selected(): ApprovalMode;
  dispatched(fallback: () => ApprovalMode): ApprovalMode;
}): ApprovalMode {
  return supportsLiveApprovalMode(input.driverKind) ? input.selected() : input.dispatched(input.selected);
}
