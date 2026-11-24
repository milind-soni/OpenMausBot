import type { ServerFrame } from "../../shared/wire";
import { notificationsRead, playAppSound, replySound } from "@/lib/app-sounds";
import type { Action, AppState } from "./store";
import { visibleNotificationThread } from "./thread-navigation";

export function actionSound(action: Action): void {
  if (action.type === "send" || action.type === "sendGroup") void playAppSound("send");
  else if (action.type === "interrupt" || action.type === "interruptGroup") void playAppSound("stop");
}

/** An approval sounds like success only once the server says it carried it out; a refusal goes through `showError`. */
export function approvalSound<T>(response: T): T {
  const answer = response as { outcome?: unknown; settlementPending?: unknown } | null | undefined;
  if (answer?.outcome === "allowed-once" && !answer.settlementPending) void playAppSound("approved");
  return response;
}

export function frameSound(state: AppState, frame: ServerFrame): void {
  if (frame.kind === "notifications.read") return notificationsRead(frame.ids);
  if (frame.kind !== "message" || frame.message?.role !== "bot" || frame.message.kind !== "text") return;
  void replySound(frame.message.id, visibleNotificationThread(state, frame.threadId) === frame.threadId);
}

export function errorSound(): void {
  void playAppSound("error");
}
