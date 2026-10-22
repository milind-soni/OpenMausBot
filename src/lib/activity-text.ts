import { tFromServer } from "@/lib/i18n";
import type { Message } from "@/state/store";

type NoticeTool = Pick<NonNullable<Message["tool"]>, "nameCode" | "nameParams">;

export function isNoticeCode(code: string | undefined): code is string {
  return code?.startsWith("chat.notice.") === true;
}

/** Only `chat.notice.*` keys are taken, so a stored row cannot make the app show any other catalog string. */
export function activityText(tool: NoticeTool, english: string): string {
  return isNoticeCode(tool.nameCode) ? tFromServer(tool.nameCode, english, tool.nameParams) : english;
}
