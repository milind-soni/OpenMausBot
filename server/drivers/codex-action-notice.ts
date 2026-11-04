import type { ServerText } from "../../shared/server-text.ts";
import { noticeFailure } from "../chat-notices.ts";

export function codexActionFailure(message: string, mayHaveRun: boolean, text?: ServerText) {
  return mayHaveRun ? noticeFailure("chat.notice.codexActionMayHaveRun", { message }) : { message, ...(text ? { text } : {}) };
}
