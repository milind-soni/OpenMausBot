import { api } from "@/state/store";
import type { WidgetOther, WidgetValues } from "../../../shared/widget";

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

export type WidgetSendResult =
  | { ok: true }
  /** `refused`: the server said no, in `error`. Otherwise no answer came, and the same sendId may be sent again. */
  | { ok: false; refused: boolean; error?: string };

export const newWidgetSendId = (): string => crypto.randomUUID();

export async function sendWidgetAction(press: WidgetPress): Promise<WidgetSendResult> {
  try {
    await api(`/api/bots/${press.botId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        threadId: press.threadId,
        sendId: press.sendId,
        widgetAction: { messageId: press.messageId, ref: press.ref, rev: press.rev, ...(press.values ? { values: press.values } : {}), ...(press.other ? { other: press.other } : {}) },
      }),
    });
    return { ok: true };
  } catch (error) {
    const refused = typeof (error as { status?: unknown } | null)?.status === "number";
    return { ok: false, refused, ...(refused && error instanceof Error && error.message ? { error: error.message } : {}) };
  }
}
