import type { ServerText } from "../shared/server-text.ts";
import type { WaitNotice, WaitRecord } from "./waits.ts";

const FIRED_KEY = {
  url_contains: "urlContains", url_missing: "urlMissing", file_exists: "fileExists", file_missing: "fileMissing",
  file_changed: "fileChanged", process_running: "processRunning", process_gone: "processGone", bot_idle: "botIdle",
} as const;

export function waitNoticeText(wait: WaitRecord, notice: WaitNotice): ServerText | undefined {
  const params = { label: wait.label };
  if (notice.status === "expired") {
    const hours = Math.round((wait.expiresAt - wait.createdAt) / 3_600_000);
    return { key: hours === 1 ? "chat.notice.waitExpiredOne" : "chat.notice.waitExpiredMany", params: { ...params, hours } };
  }
  const condition = wait.condition;
  if (notice.status === "stopped") return condition.kind === "bot_idle" ? { key: "chat.notice.waitBotGone", params: { ...params, botName: condition.botName } } : undefined;
  const key = `chat.notice.waitDone.${FIRED_KEY[condition.kind]}`;
  switch (condition.kind) {
    case "url_contains": case "url_missing": return { key, params: { ...params, url: condition.url, text: condition.text } };
    case "file_exists": case "file_missing": case "file_changed": return { key, params: { ...params, path: condition.path } };
    case "process_running": case "process_gone": return { key, params: { ...params, process: condition.process } };
    case "bot_idle": return { key, params: { ...params, botName: condition.botName } };
  }
}
