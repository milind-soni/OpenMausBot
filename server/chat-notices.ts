import { failedTurnTool, type FailedTurnTool } from "../shared/failed-turn.ts";
import { formatServerText, isReferenceParam, type ServerText, type ServerTextParams } from "../shared/server-text.ts";
import { redactParams } from "../shared/redact.ts";

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
  "chat.notice.acpRestarted": "{provider} was restarted because a session sharing its process ignored Stop",
  "chat.notice.acpStopFailed": "{provider} ignored Stop and its process could not be ended",
  "chat.notice.toolCount": "{provider} refused this turn because this model takes at most {limit} tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.",
  "chat.notice.toolCountUnknown": "{provider} refused this turn because this model takes at most a limited number of tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.",
  "chat.notice.goalRetry": "{name}'s turn did not settle ({why}) — retrying once.",
  "chat.notice.part.providerFailed": "provider failed",
  "chat.notice.part.dispatchFailed": "dispatch failed",
  "chat.notice.part.goalStalled": "stalled",
  "chat.notice.part.goalTimedOut": "timed out",
  "chat.notice.goalWaiting": "{name} is finishing what it is doing. This goal will continue when it is free.",
  "chat.notice.goalBusyOne": "{name} stayed busy for {minutes} minute",
  "chat.notice.goalBusyMany": "{name} stayed busy for {minutes} minutes",
  "chat.notice.goalBusyOneAgain": "{name} stayed busy for {minutes} minute — send the goal again when they are free.",
  "chat.notice.goalBusyManyAgain": "{name} stayed busy for {minutes} minutes — send the goal again when they are free.",
  "chat.notice.goalWorking": "{name} is working on turn {turn} of {max}.",
  "chat.notice.goalEnded": "The goal run ended before the bot reported an outcome.",
  "chat.notice.teammateWorking": "Stopped here — {name} is still working; open to stop it too",
  "chat.notice.unknownTeammateWorking": "Stopped here — A teammate is still working; open to stop it too",
  "chat.notice.automationRecovered": "Recovered: {name} finished OK at {time}",
  "chat.notice.approve": "Approve: {what}",
  "chat.notice.exportedGoal.working": "{before}[Goal: working]{content}",
  "chat.notice.exportedGoal.completed": "{before}[Goal: completed]{content}",
  "chat.notice.exportedGoal.needs-input": "{before}[Goal: needs-input]{content}",
  "chat.notice.exportedGoal.blocked": "{before}[Goal: blocked]{content}",
  "chat.notice.exportedGoal.limit-reached": "{before}[Goal: limit-reached]{content}",
  "chat.notice.exportedGoal.paused": "{before}[Goal: paused]{content}",
  "chat.notice.exportedGoal.stopped": "{before}[Goal: stopped]{content}",
  "chat.notice.exportedGoal.failed": "{before}[Goal: failed]{content}",
  "chat.notice.phone.notOwner": "not the owner's own turn",
  "chat.notice.phone.noPhone": "no phone paired with its apps allowed",
  "chat.notice.phone.allowed": "allowed {tool}",
  "chat.notice.phone.denied.calendar": "Calendar is not allowed on the phone",
  "chat.notice.phone.denied.reminders": "Reminders is not allowed on the phone",
  "chat.notice.phone.denied.contacts": "Contacts is not allowed on the phone",
  "chat.notice.phone.denied.location": "Location is not allowed on the phone",
  "chat.notice.phone.denied.home": "Home is not allowed on the phone",
  "chat.notice.phone.denied.messages": "Messages is not allowed on the phone",
  "chat.notice.phone.write.PHONE_CREATE_EVENT": "Create event on {phone}",
  "chat.notice.phone.write.PHONE_UPDATE_EVENT": "Update event on {phone}",
  "chat.notice.phone.write.PHONE_DELETE_EVENT": "Delete event on {phone}",
  "chat.notice.phone.write.PHONE_RESPOND_TO_INVITE": "Respond to invite on {phone}",
  "chat.notice.phone.write.PHONE_CREATE_REMINDER": "Create reminder on {phone}",
  "chat.notice.phone.write.PHONE_UPDATE_REMINDER": "Update reminder on {phone}",
  "chat.notice.phone.write.PHONE_COMPLETE_REMINDER": "Complete reminder on {phone}",
  "chat.notice.phone.write.PHONE_DELETE_REMINDER": "Delete reminder on {phone}",
  "chat.notice.phone.write.PHONE_CREATE_CONTACT": "Create contact on {phone}",
  "chat.notice.phone.write.PHONE_UPDATE_CONTACT": "Update contact on {phone}",
  "chat.notice.phone.write.PHONE_SET_ACCESSORY": "Set accessory on {phone}",
  "chat.notice.phone.write.PHONE_RUN_SCENE": "Run scene on {phone}",
  "chat.notice.phone.write.PHONE_SEND_MESSAGE": "Send message on {phone}",
  "chat.notice.phone.write.PHONE_SEND_WHATSAPP": "Send whatsapp on {phone}",
  "chat.notice.acpEmpty": "{provider} finished without replying.",
  "chat.notice.acpNoReason": "{provider} stopped without saying why.",
  "chat.notice.stop.refusal": "{provider} refused to go on with this request (stop reason: {reason}). Try again, reword the request, or switch this bot to another AI.",
  "chat.notice.stop.refusalGeneric": "The AI refused to go on with this request (stop reason: {reason}). Try again, reword the request, or switch this bot to another AI.",
  "chat.notice.stop.maxTokens": "{provider}'s reply reached its maximum length before it finished (stop reason: {reason}). Ask it to continue, or ask for a shorter answer.",
  "chat.notice.stop.maxTokensGeneric": "The AI's reply reached its maximum length before it finished (stop reason: {reason}). Ask it to continue, or ask for a shorter answer.",
  "chat.notice.stop.maxRequests": "The turn made as many model requests as one turn may before it finished (stop reason: {reason}). Ask it to carry on from where it stopped, or split the task.",
  "chat.notice.unaskedStop": "The AI's request was cut off before it finished, and nobody stopped it (it said only \"{said}\"). Send the message again to try once more.",
  "chat.notice.piSessionSlow": "Pi is taking longer than usual to start this conversation's session. The turn goes on when Pi answers. Press Stop to cancel it.",
  "chat.notice.unreadMessage": "This turn ended before the model read a message sent while it ran. Send that message again.",
  "chat.notice.codexUnsupportedOne": "Codex could not run the tool {tools} (\"unsupported call\"): the AI provider sent the call back without the tool's app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.",
  "chat.notice.codexUnsupportedMany": "Codex could not run the tools {tools} (\"unsupported call\"): the AI provider sent the call back without the tool's app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.",
  "chat.notice.codexUnsupportedMore": "Codex could not run the tools {tools} and {count} more (\"unsupported call\"): the AI provider sent the call back without the tool's app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.",
  "chat.notice.toldPerson": "Told {name}",
  "chat.notice.handoffSent": "Sent to {name}",
  "chat.notice.handoffSentRoom": "Sent to {name} · {room}",
  "chat.notice.relayReply": "{name} replied: {message}",
  "chat.notice.relayFrom": "{name} asked me to pass this on: {message}",
  "chat.notice.relayMessage": "A message for you from {name}: {message}",
  "chat.notice.reportSent": "Sent to the MausBot team (report {id}). Milind and Omkar get it by email.",
  "chat.notice.reportSentContact": "Sent to the MausBot team (report {id}). Milind and Omkar get it by email and will reply to {contact}.",
  "chat.notice.reportLater": "Sent to the MausBot team (report {id}) after an earlier try did not go through. Milind and Omkar get it by email.",
  "chat.notice.reportLaterContact": "Sent to the MausBot team (report {id}) after an earlier try did not go through. Milind and Omkar get it by email and will reply to {contact}.",
  "chat.notice.part.reportLimited": "the MausBot team takes only a few reports an hour from each app",
  "chat.notice.reportWaiting": "Not sent yet: {why}. The report is saved and goes on its own as soon as it can, so there is no need to send it again.",
  "chat.notice.reportWaitingOne": "Not sent yet: {why}. The report is saved and goes on its own in about {minutes} minute, so there is no need to send it again.",
  "chat.notice.reportWaitingMany": "Not sent yet: {why}. The report is saved and goes on its own in about {minutes} minutes, so there is no need to send it again.",
  "chat.notice.reportFull": "Not sent: {count} bug reports are already waiting to go to the MausBot team. Type @devs again once they have gone.",
  "chat.notice.reportDropped": "A bug report from this conversation could not reach the MausBot team for a week, so it was dropped. Type @devs again to send a new one.",

} as const;

export type ChatNoticeKey = keyof typeof CHAT_NOTICE;

export function chatNotice(key: ChatNoticeKey, params?: ServerTextParams): string {
  const words = params && Object.fromEntries(Object.entries(params).map(([name, value]) =>
    [name, isReferenceParam(name, value) && Object.hasOwn(CHAT_NOTICE, value) ? CHAT_NOTICE[value as ChatNoticeKey] : value]));
  return formatServerText(CHAT_NOTICE[key], words);
}

export function noticeLine<Key extends ChatNoticeKey>(key: Key, params?: Record<string, string>) {
  const safe = params && redactParams(params);
  return { text: chatNotice(key, safe), textCode: key, ...(safe ? { textParams: safe } : {}) };
}

export function runtimeNoticeTool(event: { message: string; text?: ServerText }) {
  return { name: `notice: ${event.message.slice(0, 240)}`, ok: true,
    ...(event.text ? { nameCode: event.text.key, ...(event.text.params ? { nameParams: redactParams(event.text.params) } : {}) } : {}) };
}

export function noticeSummary(key: ChatNoticeKey, params?: Record<string, string>) {
  const line = noticeLine(key, params);
  return { summary: line.text, summaryCode: key, ...(line.textParams ? { summaryParams: line.textParams } : {}) };
}

export function noticeFailure(key: ChatNoticeKey, params?: Record<string, string>): { message: string; text: ServerText } {
  const line = noticeLine(key, params);
  return { message: line.text, text: { key, ...(line.textParams ? { params: line.textParams } : {}) } };
}

export function noticeTool<T extends object>(
  key: ChatNoticeKey,
  params: ServerTextParams | undefined,
  extra: T,
): T & { name: string; nameCode: ChatNoticeKey; nameParams?: ServerTextParams } {
  const safe = params && redactParams(params);
  return { ...extra, name: chatNotice(key, safe), nameCode: key, ...(safe ? { nameParams: safe } : {}) };
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
