import { api } from "@/state/store";
import type { WidgetOther, WidgetValues } from "../../../shared/widget";
import { isWebUrl, threadActionTarget, type WidgetAction } from "../../../shared/widget";
import { randomUuid } from "@/lib/random-uuid";

export interface WidgetPress {
  botId: string;
  threadId?: string;
  messageId: string;
  ref: string;
  rev: number;
  values?: WidgetValues;
  other?: WidgetOther;
  sendId: string;
}

/** Where a posted press says to go: the server's answer for an action the device handles. */
export type DeviceAnswer =
  | { openThread: { botId: string; threadId: string } | { groupId: string; threadId: string } }
  | { openUrl: string };

export type WidgetSendResult =
  | { ok: true; device?: DeviceAnswer }
  /** `refused`: the server said no, in `error`. Otherwise no answer came, and the same sendId may be sent again. */
  | { ok: false; refused: boolean; error?: string };

export const newWidgetSendId = (): string => randomUuid();

/** The ids in the answer are written by a bot, so only their shape is trusted here. */
function deviceAnswer(answer: unknown): DeviceAnswer | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const record = answer as Record<string, unknown>;
  if ("openThread" in record) {
    const target = threadActionTarget({ type: "open_thread", payload: record.openThread } as WidgetAction);
    if (!target) return undefined;
    if (target.groupId !== undefined) return { openThread: { groupId: target.groupId, threadId: target.threadId } };
    if (target.botId !== undefined) return { openThread: { botId: target.botId, threadId: target.threadId } };
    return undefined;
  }
  if (isWebUrl(record.openUrl, ["http:", "https:"])) return { openUrl: record.openUrl };
  return undefined;
}

export async function sendWidgetAction(press: WidgetPress): Promise<WidgetSendResult> {
  try {
    const answer = await api<Record<string, unknown>>(`/api/bots/${press.botId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        threadId: press.threadId,
        sendId: press.sendId,
        widgetAction: { messageId: press.messageId, ref: press.ref, rev: press.rev, ...(press.values ? { values: press.values } : {}), ...(press.other ? { other: press.other } : {}) },
      }),
    });
    const device = deviceAnswer(answer);
    return device ? { ok: true, device } : { ok: true };
  } catch (error) {
    const refused = typeof (error as { status?: unknown } | null)?.status === "number";
    return { ok: false, refused, ...(refused && error instanceof Error && error.message ? { error: error.message } : {}) };
  }
}
