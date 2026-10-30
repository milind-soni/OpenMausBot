import { approvalCardOutcome } from "./ApprovalCard";
import type { Bot, Group, InstanceInfo, Message } from "@/state/store";
import type { RoutineRunCardData } from "../../shared/routine-run";
import { peerLine } from "@/lib/peer-message";
import { isReceipt } from "@/lib/receipts";
import { activityPreview, botEngine, failedTurnCause, STATUS_MARKER } from "@/lib/failed-turn";
import { t } from "@/lib/i18n";
import { sidebarConnectorPreview, sidebarGoalRunPreview } from "@/lib/sidebar-layout";
import { citationPreviewText } from "@/lib/citations";
import { plainPreviewText } from "@/lib/plain-preview";
import { isClientCancellation, isStoppedTurnName } from "../../shared/client-cancel";
import { roomWorkingPreview } from "@/lib/room-threads";

/** The newest message a preview can show. A receipt or a screen frame says nothing about the conversation on its own. */
export function lastPreviewable<T extends { kind: string }>(messages: readonly T[] | undefined): T | undefined {
  return messages?.findLast((message) => !isReceipt(message) && message.kind !== "screen");
}

export function botPreview(bot: Bot, visible: Message[], instances: InstanceInfo[], advanced: boolean): string {
  if (bot.activity === "waiting-on-you") return t("sidebar.preview.waiting");
  if (bot.waitingForTeammates) return t("sidebar.preview.waitingOnTeammate");
  if (bot.busy) return t("sidebar.preview.working");
  return lastLine(bot, visible, instances, advanced);
}

function plainStep(message: Message): boolean {
  const tool = message.kind === "activity" ? message.tool : undefined;
  return Boolean(tool) && !message.dataResult && failedTurnCause(tool!.name) === null && !isStoppedTurnName(tool!.name) && !STATUS_MARKER.test(tool!.name);
}

/** Simple mode quotes the bot: a step that went fine gives way to the newest thing said since the person last wrote. */
function quotedLine(messages: readonly Message[], last: Message, advanced: boolean): Message {
  if (advanced || !plainStep(last)) return last;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") break;
    if (message.kind !== "activity" && !isReceipt(message) && message.kind !== "screen") return message;
  }
  return last;
}

/** The conversation's newest line as a preview shows it, whatever the bot is doing now. */
export function lastLine(bot: Bot, visible: Message[], instances: InstanceInfo[], advanced: boolean): string {
  const newest = lastPreviewable(visible);
  if (!newest) return "";
  const last = quotedLine(visible, newest, advanced);
  if (last.kind === "options" && last.card) {
    // MausBot's intro by its first line, as each mode's intro says it.
    if (last.helperIntro) return t(advanced ? "helperIntro.title" : bot.chiefOfStaff ? "helperIntro.hello" : "helperIntro.hi.helper", { name: bot.name });
    return (last.card.requestId && last.card.tool && !last.card.questionRequest && approvalCardOutcome(last.card)) || last.card.title;
  }
  if (last.kind === "activity" && last.tool) return activityPreview(last.tool, botEngine(bot, instances), last.dataResult, advanced);
  if (last.kind === "connector" && last.connector) return sidebarConnectorPreview(last.connector, t);
  if (last.kind === "routine.run" && last.routineRun) return automationRunPreview(last.routineRun);
  const peer = peerLine(last);
  if (peer) return `${peer.name}: ${plainPreviewText(peer.body)}`;
  if (last.role !== "user" && isClientCancellation(last.text ?? "")) return t("chat.turnStopped");
  return plainPreviewText(citationPreviewText(last.text ?? ""));
}

const RUN_PREVIEW = {
  completed: "automations.preview.finished", failed: "automations.preview.failed", waiting: "automations.preview.needsYou",
  cancelled: "automations.preview.stopped", missed: "automations.preview.missed", running: "automations.preview.running", queued: "automations.preview.running",
} as const satisfies Record<RoutineRunCardData["status"], string>;

/** "“Morning summary” finished": an automation's run, in the page's words. */
export function automationRunPreview(run: Pick<RoutineRunCardData, "routineName" | "status">): string {
  return t(RUN_PREVIEW[run.status], { name: run.routineName });
}

export function groupPreview(group: Group, bots: Bot[], instances: InstanceInfo[], advanced: boolean): string {
  const working = roomWorkingPreview(group, (botId) => bots.find((b) => b.id === botId)?.name);
  if (working) return working;
  if (group.working) return t("sidebar.preview.teamWorking");
  const newest = lastPreviewable(group.messages);
  if (!newest) return t("sidebar.preview.noMessages");
  const last = quotedLine(group.messages, newest, advanced);
  if (last.kind === "text" && last.role !== "user" && isClientCancellation(last.text ?? "")) {
    const stopped = t("chat.turnStopped");
    return last.from ? `${last.from.name}: ${stopped}` : stopped;
  }
  const text = last.kind === "activity" && last.tool
    ? activityPreview(last.tool, botEngine(bots.find((bot) => bot.id === last.from?.botId), instances), last.dataResult, advanced)
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : last.kind === "connector" && last.connector
        ? sidebarConnectorPreview(last.connector, t)
        : (last.text ?? "");
  const readable = plainPreviewText(citationPreviewText(text));
  if (last.role === "user") return t("sidebar.preview.you", { text: readable });
  return last.from ? `${last.from.name}: ${readable}` : readable;
}
