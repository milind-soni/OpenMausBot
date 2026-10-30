import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";

export function roomActivityVisible(message: Message, showToolCalls: boolean): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef || message.relay || message.dataResult || isStatusActivity(message)) return true;
  return tool.ok === false || failedTurnCause(tool.name) !== null || showToolCalls;
}
