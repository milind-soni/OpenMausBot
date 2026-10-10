// The Files tab of the bot's computer panel (Simple mode): where the bot
// keeps its working files, and the files this conversation's turns created
// or changed. The list is read from the turn digests the chat already
// holds, so the tab costs no request of its own.
import { FileText, FolderOpen } from "lucide-react";
import { useMemo } from "react";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { collectMessageFiles, fileIdentity, splitMessageAttachments, type GalleryFile } from "./AttachmentGallery";
import { AttachedFileChip, type MessageAttachmentContext } from "./AttachmentPreview";
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

interface SharedFile {
  file: GalleryFile;
  message: MessageAttachmentContext;
}

/** A digest records changes, not permission to read a path. Reuse only a
 * visible bot reply's existing file grant, keeping its original URL spelling
 * and exact message id for the server to validate on every click. */
export function sharedFileReferences(bot: Bot): Map<string, SharedFile> {
  const references = new Map<string, SharedFile>();
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const cwd = task?.cwd === undefined ? bot.cwd : task.cwd;
  const windows = cwd && (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\"));
  const spelling = (path: string) => windows ? path.replace(/\\/g, "/") : path;
  const prefix = typeof cwd === "string" ? `${spelling(cwd).replace(/\/+$/, "")}/` : undefined;
  for (const message of [...visibleMessages(bot)].reverse()) {
    if (message.role !== "bot" || message.kind !== "text") continue;
    const attached = splitMessageAttachments(message.attachments);
    const files = [
      ...attached.files,
      ...collectMessageFiles(message.text ?? "", [...attached.images, ...attached.files.map((file) => file.path)]),
    ];
    for (const file of files) {
      const identity = file.private ? file.path : fileIdentity(file.path);
      const reference = {
        file,
        message: { threadId: bot.threadId, messageId: message.id },
      };
      // Digests use paths relative to the turn's working folder. Only match
      // an absolute link beneath that exact folder; never guess by basename.
      const path = spelling(identity);
      // Windows drive/UNC prefixes are case-insensitive. Slice the original
      // spelling so Git's relative path and the shared URL keep their case.
      const inFolder = prefix && (windows
        ? path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
        : path.startsWith(prefix));
      const keys = [identity, ...(inFolder ? [path.slice(prefix.length)] : [])];
      if (identity.startsWith("./")) keys.push(identity.replace(/^(\.\/)+/, ""));
      for (const key of keys) if (!references.has(key)) references.set(key, reference);
    }
  }
  return references;
}

function splitPath(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? { name: path, folder: "" } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

export function ComputerFilesPane({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  // Match Access settings: absent means not pinned yet; null is a legacy
  // home-folder session, which must not inherit a later bot default.
  const pinned = task?.cwd;
  const cwd = pinned === undefined ? bot.cwd : pinned;
  const files = recentChangedFiles(bot);
  const shared = useMemo(() => sharedFileReferences(bot), [bot.messages, bot.activeLeafId, bot.threadId, bot.tasks, bot.cwd]);
  return (
    <div className="flex-1 overflow-y-auto px-5 pb-5" data-testid="computer-files">
      <div className="mt-2 rounded-xl bg-card p-4">
        <div className="text-[13px] font-medium text-ink">{t("computer.files.folder")}</div>
        <div className="mt-2 flex items-center gap-2">
          <FolderOpen size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={cwd ?? undefined}>
            {cwd ? shortPath(cwd, home) : cwd === null ? t("computer.files.homeFolder") : t("computer.files.privateFolder", { name: bot.name })}
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
            {t(pinned === undefined ? "computer.files.changeFolder" : "computer.files.changeDefaultFolder")}
          </button>
        </div>
        {pinned !== undefined && <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{t("computer.files.pinnedFolderHint")}</p>}
      </div>
      <div className="mt-3 rounded-xl bg-card p-4">
        <div className="text-[13px] font-medium text-ink">{t("computer.files.recent")}</div>
        {files.length === 0 ? (
          <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{t("computer.files.empty", { name: bot.name })}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {files.map((path) => {
              const { name, folder } = splitPath(path);
              const reference = shared.get(path);
              return (
                <li key={path} className="min-w-0 rounded-lg py-1" title={path}>
                  {reference ? (
                    <AttachedFileChip
                      key={`${reference.message.threadId}:${reference.message.messageId}:${reference.file.path}`}
                      file={{ ...reference.file, name }}
                      message={reference.message}
                      linked={reference.file.linked}
                      className="w-full max-w-none"
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2 px-2.5 py-2" title={t("computer.files.notSharedHint")}>
                      <FileText size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{name}</span>
                      <span className="shrink-0 text-[11px] text-ink-tertiary">{t("computer.files.notShared")}</span>
                    </div>
                  )}
                  {folder && <div className="mt-1 truncate px-2.5 text-[11px] text-ink-tertiary">{shortPath(folder, home)}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
