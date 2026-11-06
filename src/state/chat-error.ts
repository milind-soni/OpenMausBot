import { useEffect } from "react";
import { ApiError } from "./api";

export const CHAT_ERROR_CLEAR_MS = 6_000;

/** The server's answer to a Send with no AI on a team: news for the person, not a failure of theirs. */
export function isNoAiRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.body?.code === "no_ai";
}

export function useChatErrorClear(error: string | null, clear: () => void): void {
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clear, CHAT_ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [error, clear]);
}
