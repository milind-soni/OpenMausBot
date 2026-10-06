import { isPersistentQuestionCard } from "../shared/ask-question.ts";
import type { WireMessage } from "../shared/wire.ts";
import { channelCardFingerprint, type ChannelAnswerTarget, type ChannelSnapshot } from "./channel-conversation.ts";
import { assertRequestTarget, requestConflict } from "./guarded-requests.ts";

/** Outbound holds are harness requests, never provider permission cards.
 * Their original private capability must still own the exact live execution. */
export function assertChannelOutboundLease(target: ChannelAnswerTarget, botId: string,
  capability: { botId: string; threadId: string; generation: string } | undefined, active: boolean): void {
  if (!capability || !active || capability.botId !== botId || capability.threadId !== target.threadId ||
      capability.generation !== target.executionId) {
    throw requestConflict("That outbound approval no longer owns a live action.");
  }
}

/** Re-read the guarded branch immediately before answering. A remembered
 * channel prompt is a comparison target, never authority by itself. */
export function assertChannelCardTarget(
  current: ChannelSnapshot,
  target: ChannelAnswerTarget,
  behavior: "allow" | "deny" | "answer",
): WireMessage {
  const source = current.messages[0];
  const candidates = current.messages.filter(message => message.card?.requestId === target.requestId);
  const message = candidates[0];
  const card = message?.card;
  if (current.messageId !== target.messageId || source?.id !== target.messageId || source.requestCancelled ||
      source.sendId !== target.sendId || candidates.length !== 1 || message?.id !== target.cardMessageId ||
      !card || card.answered || card.dismissed || card.expired || channelCardFingerprint(card) !== target.cardFingerprint ||
      !message.turnId || message.requestMessageId !== target.messageId ||
      current.messages.slice(1).some(item => item.turnId && item.requestMessageId !== target.messageId)) {
    throw requestConflict("That channel request has changed or is no longer open.");
  }
  if (card.skillRequest || card.routineRequest || card.profileRequest || card.modelRequest || card.teamSetupRequest ||
      card.teamMemoryRequest) {
    throw requestConflict("This request needs review in the workspace.");
  }
  const question = isPersistentQuestionCard(card);
  if (question !== (behavior === "answer")) throw requestConflict("That reply does not match this request.");
  if (!question) {
    if (source.requestPending !== true || current.phase !== "waiting" || !current.executionId || !current.activeTurnId ||
        message.turnId !== current.activeTurnId) throw requestConflict("That approval is no longer waiting.");
    assertRequestTarget(current, { messageId: target.messageId, expectedActiveLeafId: target.activeLeafId,
      expectedTurnId: target.activeTurnId, expectedExecutionId: target.executionId });
  } else {
    // Questions may outlive their provider, but never cross to another live
    // turn or execution. The exact question and original branch stay pinned.
    if ((target.activeTurnId && message.turnId !== target.activeTurnId) ||
        (current.activeTurnId && (current.activeTurnId !== message.turnId || current.executionId !== target.executionId)) ||
        current.messages.slice(current.messages.indexOf(message) + 1).some(item => item.turnId && item.turnId !== message.turnId)) {
      throw requestConflict("That question belongs to a different turn.");
    }
  }
  return message;
}
