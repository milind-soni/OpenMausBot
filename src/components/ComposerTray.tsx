import { t } from "@/lib/i18n";

/** A pinned task can keep a different folder from the bot's default. */
export function workingFolderLabel(folder: string, botId: string, threadId: string): string {
  const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.endsWith(`/task-workspaces/${botId}/${threadId}`)) return t("composer.tray.privateWorkspace");
  return normalized.split("/").pop() || folder;
}
