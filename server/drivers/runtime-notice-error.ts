import type { ServerText } from "../../shared/server-text.ts";
import { noticeFailure, type ChatNoticeKey } from "../chat-notices.ts";

export class RuntimeNoticeError extends Error {
  readonly text: ServerText;

  constructor(message: string, key: ChatNoticeKey, params?: Record<string, string>) {
    super(message);
    this.text = noticeFailure(key, params).text;
  }
}

export function runtimeErrorText(error: unknown): ServerText | undefined {
  return error instanceof RuntimeNoticeError ? error.text : undefined;
}
