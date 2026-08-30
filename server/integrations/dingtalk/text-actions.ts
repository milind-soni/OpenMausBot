import type {
  DingTalkCardAction,
  DingTalkInboundMessage,
  DingTalkOwnerTextCommand,
  DingTalkOwnerTextCommandName,
} from "./types.ts";

const TEXT_ACTION = /(?:^|\s)(接受|拒绝)\s+([A-Za-z0-9_-]{32,128})(?:\s+([\s\S]{1,2000}))?\s*$/u;
const TEXT_COMMAND = /(?:^|\s)(状态|暂停|恢复|重试|取消|刷新验收码)\s+(WI-[A-F0-9]{12})\s*$/iu;
const COMMANDS: Readonly<Record<string, DingTalkOwnerTextCommandName>> = {
  状态: "status",
  暂停: "pause",
  恢复: "resume",
  重试: "retry",
  取消: "cancel",
  刷新验收码: "refresh_approval",
};

/**
 * Parses the deliberately small Owner text protocol. The opaque value is the
 * same server-issued, SHA/version-bound token used by interactive cards; no
 * privilege, Work Item or candidate claim is trusted from visible text.
 */
export function parseDingTalkOwnerTextAction(message: DingTalkInboundMessage): DingTalkCardAction | null {
  const matched = TEXT_ACTION.exec(message.text.trim());
  if (!matched) return null;
  const reject = matched[1] === "拒绝";
  const suppliedReason = matched[3]?.trim();
  return {
    transportEventId: message.sourceEventId,
    transportMessageId: message.transportMessageId,
    actionToken: matched[2]!,
    sender: message.sender,
    ...(reject
      ? { reason: suppliedReason || "Owner rejected candidate via DingTalk text command" }
      : {}),
    receivedAt: message.receivedAt ?? Date.now(),
    origin: "text",
  };
}

/** Parses WI-addressed control commands without delegating their meaning to the Planner. */
export function parseDingTalkOwnerTextCommand(message: DingTalkInboundMessage): DingTalkOwnerTextCommand | null {
  const matched = TEXT_COMMAND.exec(message.text.trim());
  if (!matched) return null;
  const command = COMMANDS[matched[1]!];
  if (!command) return null;
  return {
    transportEventId: message.sourceEventId,
    transportMessageId: message.transportMessageId,
    command,
    workItemId: matched[2]!.toUpperCase(),
    sender: message.sender,
    receivedAt: message.receivedAt ?? Date.now(),
  };
}
