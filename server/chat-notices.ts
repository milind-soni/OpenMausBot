import { failedTurnTool, type FailedTurnTool } from "../shared/failed-turn.ts";
import { formatServerText, type ServerTextParams } from "../shared/server-text.ts";

/** The client translates by key and falls back to this English, which the row keeps for phones, exports and older clients. */
export const CHAT_NOTICE = {
  "chat.notice.restartInterrupted": "turn interrupted — OpenMausBot restarted",
  "chat.notice.resumingAfterRestart": "Resuming after a restart",
  "chat.notice.cutOffByRestart": "{name} was cut off by a restart; resuming",
  "chat.notice.stalled": "no activity for {minutes} minutes — the turn was stopped",
  "chat.notice.followupInterrupted":
    "Queued follow-up interrupted by restart or restore — it may have already run. Review the result before sending it again.",
  "chat.notice.roomHeld": "{name} is held (stopped by you) — @mention it or say resume",
  "chat.notice.answerPassed": "Answer passed to the waiting work",
} as const;

export type ChatNoticeKey = keyof typeof CHAT_NOTICE;

export function chatNotice(key: ChatNoticeKey, params?: ServerTextParams): string {
  return formatServerText(CHAT_NOTICE[key], params);
}

export function noticeTool<T extends object>(
  key: ChatNoticeKey,
  params: ServerTextParams | undefined,
  extra: T,
): T & { name: string; nameCode: ChatNoticeKey; nameParams?: ServerTextParams } {
  return { ...extra, name: chatNotice(key, params), nameCode: key, ...(params ? { nameParams: params } : {}) };
}

export function failedNoticeTool(key: ChatNoticeKey, params?: ServerTextParams): FailedTurnTool {
  return failedTurnTool(chatNotice(key, params), { text: { key, ...(params ? { params } : {}) } });
}
