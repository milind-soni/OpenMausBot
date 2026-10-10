import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";

/** Whether a room shows this activity chip with tool calls hidden (the
 * default). Failures always show. So does a bot⇄bot comm chip: "Messaged
 * @Ada" is the only trace, where the person is reading, that a teammate
 * was consulted — the 1:1 chat has kept that exemption all along, and a
 * room that dropped it made a silent-by-default exchange an invisible one.
 * An opened-thread chip is the same kind of trace: the only sign, here,
 * that a bot started a thread the person may want to look at. */
export function roomActivityVisible(message: Message, showToolCalls: boolean): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef || message.dataResult || isStatusActivity(message)) return true;
  return tool.ok === false || failedTurnCause(tool.name) !== null || showToolCalls;
}
