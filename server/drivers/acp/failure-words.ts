import { noticeFailure } from "../../chat-notices.ts";
import { engineFailure, stopFailure } from "../engine-errors.ts";

export function acpStopFailure(result: { error?: unknown; message?: unknown; stopReason?: string | null }, provider: string) {
  const message = typeof result?.error === "string" && result.error ? result.error
    : typeof result?.message === "string" && result.message ? result.message : undefined;
  if (message) return engineFailure(provider, message) ?? { message };
  const failure = stopFailure(result?.stopReason, provider) ?? noticeFailure("chat.notice.acpNoReason", { provider });
  return engineFailure(provider, failure.message) ?? failure;
}
