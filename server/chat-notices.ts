import { failedTurnTool, type FailedTurnTool } from "../shared/failed-turn.ts";
import { formatServerText, isReferenceParam, type ServerText, type ServerTextParams } from "../shared/server-text.ts";
import { redactParams } from "../shared/redact.ts";
import { DRIVER_NOTICE } from "./drivers/driver-notices.ts";

/** The client translates by key and falls back to this English, which the row keeps for phones, exports and older clients. */
export const CHAT_NOTICE = {
  ...DRIVER_NOTICE,
  "chat.notice.restartInterrupted": "turn interrupted — OpenMausBot restarted",
  "chat.notice.resumingAfterRestart": "Resuming after a restart",
  "chat.notice.cutOffByRestart": "{name} was cut off by a restart; resuming",
  "chat.notice.stalled": "no activity for {minutes} minutes — the turn was stopped",
  "chat.notice.stalledCommand": "the command `{command}` ran for {minutes} minutes without finishing and looks stuck — the turn was stopped",
  "chat.notice.followupInterrupted":
    "Queued follow-up interrupted by restart or restore — it may have already run. Review the result before sending it again.",
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
  "chat.notice.acpRestarted": "{provider} was restarted because a session sharing its process ignored Stop",
  "chat.notice.acpStopFailed": "{provider} ignored Stop and its process could not be ended",
  "chat.notice.toolCount": "{provider} refused this turn because this model takes at most {limit} tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.",
  "chat.notice.toolCountUnknown": "{provider} refused this turn because this model takes at most a limited number of tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.",
  "chat.notice.modelNoRoute": "{provider} can't use the model {model} here, so choose another model for this bot.",
  "chat.notice.modelNoRouteUnnamed": "{provider} can't use this bot's model here, so choose another model for this bot.",
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
  "chat.notice.acpMcpAppsFailed": "Connected apps couldn't be set up, so {provider} couldn't start this reply. Try again, or switch this bot to another AI.",
  "chat.notice.acpMcpServerFailed": "The \"{server}\" MCP server couldn't be set up, so {provider} couldn't start this reply. Try again, or switch this bot to another AI.",
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

  "chat.notice.copilotAccountRefused": "GitHub Copilot refused this request for the signed-in account. Check its Copilot plan and premium request allowance, then try again.",
  "chat.notice.commandCodeAccountRefused": "Command Code refused this request for the signed-in account. Check its plan and credits on commandcode.ai, then try again.",
  "chat.notice.kiroAccountRefused": "Kiro refused this request for the signed-in account. Check its Kiro plan and credits, then try again.",
  "chat.notice.devinAccountRefused": "Devin refused this request for the signed-in account. Check its Devin plan and credits, then try again.",
  "chat.notice.acpQuietUsageLimit": "{name} reached a usage limit{said} and is waiting it out without replying, so this turn was stopped.",
  "chat.notice.acpQuietStuck": "{name} sent nothing for {quiet} with no tool running, no open request to its model and no CPU use, so the turn was stopped as stuck. Send the message again to retry.",
  "chat.notice.acpModelRequestFailed": "{name}'s model request failed: \"{message}\" {name} may retry or stop; no reply for {quiet} so far.",
  "chat.notice.acpModelFallback": "{displayName} no longer offers {wanted}, so this conversation uses {fallback}. Choose another model for this bot to stop seeing this.",
  "chat.notice.codexActionMayHaveRun": "{message} A tool action may have run. Check its effects before trying again.",
  "chat.notice.modelServerStoppedAnswering": "The model server at {host} stopped answering, so the reply was stopped.",
  "chat.notice.piModelNotConfirmed": "Pi did not confirm the selected model",
  "chat.notice.waitingApprovalElsewhere": "Waiting on your approval in @{name}",
  "chat.notice.waitingAnswerElsewhere": "Waiting on your answer in @{name}",
  "chat.notice.teammateNeedsInput": "{name} needs your input: {question}",
  "chat.notice.relayCouldNotContinue": "this conversation could not carry on — {error}",
  "chat.notice.engineSignedOut": "{name} is signed out.",
  "chat.notice.failoverSignedInAgain": "{engine} is signed in again, so this conversation is back on {engine}.",
  "chat.notice.failoverSignedOut": "{from} is signed out, so {to} took over.",
  "chat.notice.backupCardWaiting": "switched to {name}. Your request waits on a card above and continues on {name} once you act on it.",
  "chat.notice.backupRequestUnderWay": "switched to {name}. Your request is still under way here and continues on {name}.",
  "chat.notice.backupConversationBusy": "switched to {name}. This conversation is working, so your message was not sent again.",
  "chat.notice.backupQuestionWaiting": "switched to {name}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again. Answer it, then send your message again.",
  "chat.notice.backupMessageMissing": "switched to {name}, but your message could not be found to send again. Send it again.",
  "chat.notice.backupContinuingLimit": "continuing on {name} after hitting the usage limit",
  "chat.notice.backupContinuingSignedOut": "continuing on {name} while {engine} is signed out",
  "chat.notice.backupCouldNotContinue": "could not continue on {name}: {error}",
  "chat.notice.waitDone.urlContains": "{label}: done. {url} now says “{text}”.",
  "chat.notice.waitDone.urlMissing": "{label}: done. {url} no longer says “{text}”.",
  "chat.notice.waitDone.fileExists": "{label}: done. {path} is there now.",
  "chat.notice.waitDone.fileMissing": "{label}: done. {path} is gone.",
  "chat.notice.waitDone.fileChanged": "{label}: done. {path} changed.",
  "chat.notice.waitDone.processRunning": "{label}: done. {process} is running.",
  "chat.notice.waitDone.processGone": "{label}: done. {process} stopped.",
  "chat.notice.waitDone.botIdle": "{label}: done. {botName} finished.",
  "chat.notice.waitBotGone": "Stopped waiting for {label}: {botName} no longer exists.",
  "chat.notice.waitExpiredOne": "Stopped waiting for {label} after {hours} hour.",
  "chat.notice.waitExpiredMany": "Stopped waiting for {label} after {hours} hours.",
  "chat.notice.computerDesktopOnly": "Only the OpenMausBot app on this computer can let a bot use it. Open the app here, or let the bot work in its own browser or on a cloud desktop instead.",
  "chat.notice.computerPermissionsThenRestart": "OpenMausBot can't use this computer yet — make sure OpenMausBot has the permissions it asks for, then restart it",
  "chat.notice.computerNotReadyDetail": "OpenMausBot can't use this computer yet — {reason}",
  "chat.notice.computerNotReadyMacPermission": "OpenMausBot can't use this computer yet — {reason}. Relaunch OpenMausBot after granting the missing macOS permission.",
  "chat.notice.computerSystemUnsupported": "bots can't use this computer on this system — choose another place for this bot to work",
  "chat.notice.computerAiUnsupported": "this bot's AI can't use this computer — pick another AI for this bot, or choose another place for it to work",
  "chat.notice.memoryReclaimedBrowser": "Ran out of room, so I closed the browser to keep everything else running.",
  "chat.notice.memoryReclaimedTask": "Ran out of room, so I stopped this task to keep everything else running.",
  "chat.notice.memoryReclaimedBrowserDetail": "Ran out of room, so I closed the browser to keep everything else running. ({detail})",
  "chat.notice.memoryReclaimedTaskDetail": "Ran out of room, so I stopped this task to keep everything else running. ({detail})",
} as const;

export type ChatNoticeKey = keyof typeof CHAT_NOTICE;

export function chatNotice(key: ChatNoticeKey, params?: ServerTextParams): string {
  const words = params && Object.fromEntries(Object.entries(params).map(([name, value]) =>
    [name, isReferenceParam(name, value) && Object.hasOwn(CHAT_NOTICE, value) ? CHAT_NOTICE[value as ChatNoticeKey] : value]));
  return formatServerText(CHAT_NOTICE[key], words);
}

export function noticeLine<Key extends ChatNoticeKey, Params extends ServerTextParams = ServerTextParams>(key: Key, params?: Params) {
  const safe = params && redactParams(params);
  return { text: chatNotice(key, safe), textCode: key, ...(safe ? { textParams: safe } : {}) };
}

export function runtimeNoticeTool(event: { message: string; text?: ServerText }) {
  return { name: `notice: ${event.message.slice(0, 240)}`, ok: true,
    ...(event.text ? { nameCode: event.text.key, ...(event.text.params ? { nameParams: redactParams(event.text.params) } : {}) } : {}) };
}

export function noticeSummary<Params extends ServerTextParams = ServerTextParams>(key: ChatNoticeKey, params?: Params) {
  const line = noticeLine(key, params);
  return { summary: line.text, summaryCode: key, ...(line.textParams ? { summaryParams: line.textParams } : {}) };
}

export function noticeFailure(key: ChatNoticeKey, params?: ServerTextParams): { message: string; text: ServerText } {
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

export function failedNoticeTool(key: ChatNoticeKey, params?: ServerTextParams): FailedTurnTool {
  const safe = params && redactParams(params);
  return failedTurnTool(chatNotice(key, safe), { text: { key, ...(safe ? { params: safe } : {}) } });
}
