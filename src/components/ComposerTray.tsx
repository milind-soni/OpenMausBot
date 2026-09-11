import { Folder, Wrench } from "lucide-react";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

/** A pinned task can keep a different folder from the bot's default. */
export function workingFolderLabel(folder: string, botId: string, threadId: string): string {
  const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.endsWith(`/task-workspaces/${botId}/${threadId}`)) return t("composer.tray.privateWorkspace");
  return normalized.split("/").pop() || folder;
}

export function ComposerTray({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const task = bot.tasks?.find((item) => item.threadId === bot.threadId);
  const folder = task?.cwd === undefined ? bot.cwd : (task.cwd ?? undefined);
  const openAccess = () => dispatch({ type: "toggleSettings", open: true, section: "access" });
  const chip = "flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 text-xs text-ink-secondary hover:bg-raised-hover hover:text-ink";

  return (
    <div className="flex items-center gap-1 px-1 pt-1">
      <button type="button" onClick={openAccess} className={chip}
        aria-label={t("composer.tray.folderSettings")}
        title={folder ? t("chat.workingFolder", { folder }) : t("composer.tray.folderSettings")}>
        <Folder size={13} aria-hidden="true" />
        <span className="max-w-[200px] truncate">
          {folder ? workingFolderLabel(folder, bot.id, bot.threadId)
            : task?.cwd === null ? t("composer.tray.homeFolder") : t("composer.tray.privateWorkspace")}
        </span>
      </button>
      <button type="button" onClick={openAccess} className={chip} title={t("composer.tray.toolsHint")}>
        <Wrench size={13} aria-hidden="true" />
        {t("composer.tray.tools")}
      </button>
    </div>
  );
}
