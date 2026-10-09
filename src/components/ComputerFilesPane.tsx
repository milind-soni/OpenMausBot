// The Files tab of the bot's computer panel (Simple mode): where the bot
// keeps its working files, and the files this conversation's turns created
// or changed. The list is read from the turn digests the chat already
// holds, so the tab costs no request of its own.
import { FileText, FolderOpen } from "lucide-react";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { shortPath } from "@/lib/short-path";
import { t } from "@/lib/i18n";

const MAX_FILES = 20;

/** Newest first, each path once; a path whose latest turn deleted it is left out. */
export function recentChangedFiles(bot: Bot, limit = MAX_FILES): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const messages = visibleMessages(bot);
  for (let index = messages.length - 1; index >= 0 && files.length < limit; index -= 1) {
    const digestFiles = messages[index]!.digest?.files;
    if (!digestFiles) continue;
    for (const path of digestFiles.deleted) seen.add(path);
    for (const path of [...digestFiles.added, ...digestFiles.changed]) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

function splitPath(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? { name: path, folder: "" } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

export function ComputerFilesPane({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const files = recentChangedFiles(bot);
  return (
    <div className="flex-1 overflow-y-auto px-5 pb-5" data-testid="computer-files">
      <div className="mt-2 rounded-xl bg-card p-4">
        <div className="text-[13px] font-medium text-ink">{t("computer.files.folder")}</div>
        <div className="mt-2 flex items-center gap-2">
          <FolderOpen size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={bot.cwd ?? undefined}>
            {bot.cwd ? shortPath(bot.cwd, home) : t("computer.files.privateFolder", { name: bot.name })}
          </span>
          <button
            type="button"
            onClick={() => {
              // Same entry as the Advanced header's gear: the working folder
              // lives in the bot's Access settings.
              dispatch({ type: "toggleComputer", open: false });
              dispatch({ type: "toggleSettings", open: true, section: "access" });
            }}
            className="shrink-0 rounded-lg bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
          >
            {t("computer.files.changeFolder")}
          </button>
        </div>
      </div>
      <div className="mt-3 rounded-xl bg-card p-4">
        <div className="text-[13px] font-medium text-ink">{t("computer.files.recent")}</div>
        {files.length === 0 ? (
          <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{t("computer.files.empty", { name: bot.name })}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {files.map((path) => {
              const { name, folder } = splitPath(path);
              return (
                <li key={path} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1" title={path}>
                  <FileText size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  <span className="min-w-0 truncate text-[12.5px] text-ink">{name}</span>
                  {folder && <span className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-tertiary">{shortPath(folder, home)}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
