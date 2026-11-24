import { AppWindow, Brain, ChevronDown, FileText, Folder, Globe, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { t } from "@/lib/i18n";
import { api } from "@/state/api";
import { usePageOpener } from "@/lib/page-open";
import { shortPath } from "@/lib/short-path";
import { useShowThreads } from "@/lib/thread-preferences";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { openBotThread, type Bot } from "@/state/store";
import { AttachedFileChip } from "../AttachmentPreview";
import { UndoToast } from "../bot-access/ShareBotButton";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { skillSwitchOn, useManagedSkills } from "../bot-settings/SkillsSection";
import type { SimplePageId } from "./page-registry";
import { Card, CardLabel, NavRow } from "./rows";
import { panelMemoryNotes } from "./memory-notes";
import { useMemoryDoc } from "./use-memory-doc";
import { useStoreDispatch } from "@/state/store-select";
import { allLibraryItems, libraryItems, threadLabel, withoutFiles } from "./library-items";
import { useBotLibrary } from "./use-bot-library";

/** Each group shows its newest few; Show all opens the rest in place. */
export const LIBRARY_SHOWN = 20;

const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

function RemoveFile({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" data-library-remove={name} aria-label={t("botPanel.library.remove", { name })} title={t("botPanel.library.remove", { name })}
      onClick={onClick} className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-ink/[0.06] hover:text-danger">
      <Trash2 size={14} aria-hidden="true" />
    </button>
  );
}

function useRemovedFiles(botId: string, saved: readonly string[] | undefined) {
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<{ id: number; paths: string[] } | null>(null);
  const waiting = useRef<{ botId: string; paths: string[] } | null>(null);
  const restore = useCallback((paths: readonly string[]) => setGone((was) => {
    const next = new Set(was);
    for (const path of paths) next.delete(path);
    return next;
  }), []);
  const send = useCallback(() => {
    const removal = waiting.current;
    waiting.current = null;
    if (!removal) return;
    void api(`/api/bots/${encodeURIComponent(removal.botId)}/library/remove`, { method: "POST", body: JSON.stringify({ paths: removal.paths }) })
      .catch(() => restore(removal.paths));
  }, [restore]);
  useEffect(() => send, [botId, send]);
  const remove = (paths: string[]) => {
    send();
    waiting.current = { botId, paths };
    setGone((was) => new Set([...was, ...paths]));
    setPending((was) => ({ id: (was?.id ?? 0) + 1, paths }));
  };
  const undo = async () => {
    const removal = waiting.current;
    waiting.current = null;
    if (removal) restore(removal.paths);
  };
  const done = useCallback(() => {
    send();
    setPending(null);
  }, [send]);
  const removed = useMemo(() => new Set([...(saved ?? []), ...gone]), [saved, gone]);
  return { removed, remove, pending, undo, done };
}

function ShowAll({ group, onClick }: { group: string; onClick: () => void }) {
  return (
    <button type="button" data-library-more={group} aria-expanded={false} onClick={onClick}
      className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink">
      <ChevronDown size={14} aria-hidden="true" />
      {t("botPanel.library.showAll")}
    </button>
  );
}

export function LibraryTab({ bot, onOpen }: { bot: Bot; onOpen: (page: SimplePageId) => void }) {
  const dispatch = useStoreDispatch();
  const { capabilities } = useDesktopCapabilities();
  const openPage = usePageOpener();
  const phone = !useMediaQuery(SIDEBAR_INLINE, true);
  const skills = useManagedSkills(bot);
  const memory = useMemoryDoc(bot);
  const showThreads = useShowThreads();
  const remote = useBotLibrary(bot);
  const local = useMemo(() => libraryItems(bot), [bot]);
  const files = useRemovedFiles(bot.id, remote?.removed);
  const { pages, apps, shared, unshared } = useMemo(() => withoutFiles(allLibraryItems(bot, local, remote), files.removed), [bot, local, remote, files.removed]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const shown = <T,>(group: string, items: T[]) => (open.has(group) ? items : items.slice(0, LIBRARY_SHOWN));
  const more = (group: string, items: readonly unknown[]): ReactNode => !open.has(group) && items.length > LIBRARY_SHOWN
    ? <ShowAll group={group} onClick={() => setOpen((groups) => new Set(groups).add(group))} /> : null;
  const showInChat = (threadId: string, messageId: string) => {
    if (threadId !== bot.threadId) openBotThread(dispatch, bot, threadId, showThreads);
    dispatch({ type: "focusMessage", threadId, messageId });
    if (phone) dispatch({ type: "toggleSettings", open: false });
  };
  const skillsOn = skills.skills.filter(skillSwitchOn).length;
  const remembers = memory.docs ? panelMemoryNotes(memory.docs).length > 0 || Boolean(memory.thread?.text.trim()) : null;
  const memoryValue = bot.memoryEnabled === false ? t("botPanel.memory.off")
    : remembers === false || (remembers === null && memory.error) ? t("botPanel.memory.nothingYet") : undefined;
  const keeps = (
    <Card anchor="keeps">
      <NavRow data-panel-page="memory" icon={Brain} title={t("botPanel.memoryRow")} value={memoryValue} onClick={() => onOpen("memory")} />
      <NavRow
        data-panel-page="skills"
        icon={Zap}
        title={t("botSettings.simple.skills")}
        value={skills.loading ? undefined : skillsOn > 0 ? skillsOn : t("botPanel.none")}
        onClick={() => onOpen("skills")}
      />
      <NavRow
        data-panel-page="folder"
        icon={Folder}
        title={t("computer.files.folder")}
        value={bot.cwd ? shortPath(bot.cwd, capabilities.host?.homeDir) : t("botPanel.folder.private")}
        onClick={() => onOpen("folder")}
      />
    </Card>
  );

  const undoToast = files.pending && (
    <UndoToast key={files.pending.id} onUndo={files.undo} onDone={files.done}
      text={files.pending.paths.length === 1 ? t("botPanel.library.removedOne", { name: fileName(files.pending.paths[0]!) }) : t("botPanel.library.removedMany", { count: files.pending.paths.length })} />
  );

  if (pages.length + apps.length + shared.length + unshared.length === 0) {
    return (
      <div data-panel-tabpanel="library">
        {undoToast}
        <p data-panel-empty="library" className="px-3 py-7 text-center text-[13px] leading-[18px] text-ink-tertiary">
          {t("botPanel.library.empty")}
        </p>
        {keeps}
      </div>
    );
  }
  return (
    <div data-panel-tabpanel="library">
      {undoToast}
      {pages.length > 0 && (
        <Card label={t("botPanel.library.pages")} anchor="pages">
          {shown("pages", pages).map((page) => (
            <NavRow key={page.url} data-panel-row="page" icon={Globe} title={<span className="block truncate">{page.title}</span>}
              hint={<span className="block truncate">{threadLabel(bot, page.threadId, showThreads) ?? page.url}</span>} onClick={() => openPage(page.url)} />
          ))}
        </Card>
      )}
      {more("pages", pages)}
      {apps.length > 0 && (
        <Card label={t("botPanel.library.apps")} anchor="apps">
          {shown("apps", apps).map((app) => {
            const label = threadLabel(bot, app.threadId, showThreads);
            return <NavRow key={`${app.threadId}:${app.messageId}`} data-panel-row="app" icon={AppWindow} title={<span className="block truncate">{app.title}</span>}
              hint={label && <span className="block truncate">{label}</span>} onClick={() => showInChat(app.threadId, app.messageId)} />;
          })}
        </Card>
      )}
      {more("apps", apps)}
      {shared.length + unshared.length > 0 && (
        <section data-panel-card="files">
          <CardLabel action={(
            <button type="button" data-library-remove-all onClick={() => files.remove([...shared.map((item) => item.file.path), ...unshared])}
              className="shrink-0 rounded-[6px] px-1 py-px text-[13px] font-normal text-ink-secondary hover:bg-ink/[0.04] hover:text-danger">
              {t("botPanel.library.removeAll")}
            </button>
          )}>{t("botPanel.library.files")}</CardLabel>
          <ul className="flex flex-col gap-1.5">
            {shown("files", shared).map((item) => (
              <li key={`${item.threadId}:${item.messageId}:${item.file.path}`} className="flex min-w-0 items-center gap-1">
                <AttachedFileChip file={item.file} message={{ threadId: item.threadId, messageId: item.messageId }} linked={item.file.linked} note={threadLabel(bot, item.threadId, showThreads)} className="w-full min-w-0 max-w-none flex-1" />
                <RemoveFile name={fileName(item.file.path)} onClick={() => files.remove([item.file.path])} />
              </li>
            ))}
            {(open.has("files") ? unshared : unshared.slice(0, Math.max(0, LIBRARY_SHOWN - shared.length))).map((path) => (
              <li key={path} title={t("computer.files.notSharedHint")} className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/40 px-2.5 py-2">
                <FileText size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{fileName(path)}</span>
                <span className="shrink-0 text-[11px] text-ink-tertiary">{t("computer.files.notShared")}</span>
                <RemoveFile name={fileName(path)} onClick={() => files.remove([path])} />
              </li>
            ))}
          </ul>
          {more("files", [...shared, ...unshared])}
        </section>
      )}
      {keeps}
    </div>
  );
}
