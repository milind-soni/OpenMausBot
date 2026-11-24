import type { ServerFrame } from "../../shared/wire";
import { playAppSound, replySound } from "@/lib/app-sounds";
import type { Action, AppState } from "./store";
import { visibleNotificationThread } from "./thread-navigation";

export function actionSound(action: Action): void {
  if (action.type === "send" || action.type === "sendGroup") void playAppSound("send");
  else if (action.type === "interrupt" || action.type === "interruptGroup") void playAppSound("stop");
  else if (action.type === "decideRequest" && action.behavior === "allow") void playAppSound("approved");
}

export function frameSound(state: AppState, frame: ServerFrame): void {
  if (frame.kind !== "message" || frame.message?.role !== "bot" || frame.message.kind !== "text") return;
  void replySound(frame.message.id, visibleNotificationThread(state, frame.threadId) === frame.threadId);
}

export function errorSound(): void {
  void playAppSound("error");
}
