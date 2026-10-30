import { noticeFailure } from "../chat-notices.ts";

export function codexActionFailure(message: string, mayHaveRun: boolean) {
  return mayHaveRun ? noticeFailure("chat.notice.codexActionMayHaveRun", { message }) : { message };
}
