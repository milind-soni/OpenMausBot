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
  "chat.notice.recallCrossingOne": "{name} recalled {count} message from its private chat with you",
  "chat.notice.recallCrossingMany": "{name} recalled {count} messages from its private chat with you",
  "chat.notice.briefCrossingOne": "{name}'s recent-work brief covers {count} private chat with you",
  "chat.notice.briefCrossingMany": "{name}'s recent-work brief covers {count} private chats with you",
  "chat.notice.webhookMoved":
    "Now that I live on My Cloud, my webhook \"{name}\" has a new address. Open Automations, choose Copy address on \"{name}\", and paste it into the app that sends to it.",
  "chat.notice.usageLimit": "This {provider} account has reached its usage limit{detail}. Wait for it to reset, or switch this bot to another AI.",
  "chat.notice.claudeExtraUsage":
    "Claude refused this turn because this model runs on extra usage for your account, and those credits are used up. Your plan's own usage is not affected: switch this bot to a model your plan includes, or add extra usage in your Claude account.",
  "chat.notice.claudeLimitResets": "This Claude account has reached its {limit}, which resets {resets}. Until then, {meanwhile}.",
  "chat.notice.claudeLimitSaid": "This Claude account has reached its {limit} (Claude says: \"{said}\"). For now, {meanwhile}.",
  "chat.notice.claudeLimit": "This Claude account has reached its {limit}. For now, {meanwhile}.",
  "chat.notice.part.fiveHourLimit": "5-hour limit",
  "chat.notice.part.weeklyLimit": "weekly limit",
  "chat.notice.part.weeklyOpusLimit": "weekly Opus limit",
  "chat.notice.part.weeklySonnetLimit": "weekly Sonnet limit",
  "chat.notice.part.usageLimit": "usage limit",
  "chat.notice.part.chooseModel": "choose another model for this bot",
  "chat.notice.part.switchAccount": "switch this bot to another AI or Claude account",
  "chat.notice.webhookHome":
    "I'm back on this computer, so my webhook \"{name}\" has an address here again. Open Automations, choose Copy address on \"{name}\", and paste it into the app that sends to it.",
  "chat.notice.resumedQuestion": "Resumed with a question from {names}, reviewing",
  "chat.notice.resumedQuestionAfterRestart": "Resumed with a question from {names} after a restart, reviewing",
  "chat.notice.resumedResults": "Resumed with {names} results, reviewing",
  "chat.notice.resumedResultsAfterRestart": "Resumed with {names} results after a restart, reviewing",
  "chat.notice.resumedWork": "Resumed with delegated work results, reviewing",
  "chat.notice.resumedWorkAfterRestart": "Resumed with delegated work results after a restart, reviewing",
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

const RESUMED = {
  question: ["chat.notice.resumedQuestion", "chat.notice.resumedQuestionAfterRestart"],
  results: ["chat.notice.resumedResults", "chat.notice.resumedResultsAfterRestart"],
  work: ["chat.notice.resumedWork", "chat.notice.resumedWorkAfterRestart"],
} as const satisfies Record<string, readonly [ChatNoticeKey, ChatNoticeKey]>;

export function resumedTool(question: boolean, from: readonly string[], restart: boolean) {
  const keys = !from.length ? RESUMED.work : question ? RESUMED.question : RESUMED.results;
  return noticeTool(keys[restart ? 1 : 0], from.length ? { names: from.join(", ") } : undefined, { ok: true });
}

export function failedNoticeTool(key: ChatNoticeKey, params?: ServerTextParams): FailedTurnTool {
  return failedTurnTool(chatNotice(key, params), { text: { key, ...(params ? { params } : {}) } });
}
