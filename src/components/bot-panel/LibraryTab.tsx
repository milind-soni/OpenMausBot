import { AppWindow, ChevronDown, FileText, Globe } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { t } from "@/lib/i18n";
import { usePageOpener } from "@/lib/page-open";
import { useShowThreads } from "@/lib/thread-preferences";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { openBotThread, type Bot } from "@/state/store";
import { AttachedFileChip } from "../AttachmentPreview";
import { Card, CardLabel, NavRow } from "./rows";
import { useStoreDispatch } from "@/state/store-select";
import { allLibraryItems, libraryItems, threadLabel } from "./library-items";
import { useBotLibrary } from "./use-bot-library";

/** Each group shows its newest few; Show all opens the rest in place. */
export const LIBRARY_SHOWN = 20;

const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

function ShowAll({ group, onClick }: { group: string; onClick: () => void }) {
  return (
    <button type="button" data-library-more={group} aria-expanded={false} onClick={onClick}
      className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink">
      <ChevronDown size={14} aria-hidden="true" />
      {t("botPanel.library.showAll")}
    </button>
  );
}

export function LibraryTab({ bot }: { bot: Bot }) {
  const dispatch = useStoreDispatch();
  const openPage = usePageOpener();
  const phone = !useMediaQuery(SIDEBAR_INLINE, true);
  const showThreads = useShowThreads();
  const remote = useBotLibrary(bot);
  const local = useMemo(() => libraryItems(bot), [bot]);
  const { pages, apps, shared, unshared } = useMemo(() => allLibraryItems(bot, local, remote), [bot, local, remote]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const shown = <T,>(group: string, items: T[]) => (open.has(group) ? items : items.slice(0, LIBRARY_SHOWN));
  const more = (group: string, items: readonly unknown[]): ReactNode => !open.has(group) && items.length > LIBRARY_SHOWN
    ? <ShowAll group={group} onClick={() => setOpen((groups) => new Set(groups).add(group))} /> : null;
  const showInChat = (threadId: string, messageId: string) => {
    if (threadId !== bot.threadId) openBotThread(dispatch, bot, threadId, showThreads);
    dispatch({ type: "focusMessage", threadId, messageId });
    if (phone) dispatch({ type: "toggleSettings", open: false });
  };

  if (pages.length + apps.length + shared.length + unshared.length === 0) {
    return (
      <div data-panel-tabpanel="library">
        <p data-panel-empty="library" className="px-3 py-7 text-center text-[13px] leading-[18px] text-ink-tertiary">
          {t("botPanel.library.empty")}
        </p>
      </div>
    );
  }
  return (
    <div data-panel-tabpanel="library">
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
          <CardLabel>{t("botPanel.library.files")}</CardLabel>
          <ul className="flex flex-col gap-1.5">
            {shown("files", shared).map((item) => (
              <li key={`${item.threadId}:${item.messageId}:${item.file.path}`} className="min-w-0">
                <AttachedFileChip file={item.file} message={{ threadId: item.threadId, messageId: item.messageId }} linked={item.file.linked} note={threadLabel(bot, item.threadId, showThreads)} className="w-full max-w-none" />
              </li>
            ))}
            {(open.has("files") ? unshared : unshared.slice(0, Math.max(0, LIBRARY_SHOWN - shared.length))).map((path) => (
              <li key={path} title={t("computer.files.notSharedHint")} className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/40 px-2.5 py-2">
                <FileText size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{fileName(path)}</span>
                <span className="shrink-0 text-[11px] text-ink-tertiary">{t("computer.files.notShared")}</span>
              </li>
            ))}
          </ul>
          {more("files", [...shared, ...unshared])}
        </section>
      )}
    </div>
  );
}
