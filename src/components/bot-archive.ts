import { t } from "@/lib/i18n";
import { api, openBot, type Action, type Bot } from "@/state/store";

/** The sidebar's corner notice: "Archived {name}" with Undo, or why an archive failed. */
export interface ArchiveNotice {
  error: boolean;
  text: string;
  restoreBot?: { id: string; name: string };
}

const listeners = new Set<(notice: ArchiveNotice | null) => void>();

/** The sidebar listens here, so an archive started elsewhere (the Simple bot panel) gets its notice and Undo. */
export function onArchiveNotice(listener: (notice: ArchiveNotice | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shows `notice` in the sidebar; false when no sidebar is mounted to show it. */
export function announceArchiveNotice(notice: ArchiveNotice | null): boolean {
  for (const listener of Array.from(listeners)) listener(notice);
  return listeners.size > 0;
}

/**
 * Archives a bot already checked with currentArchivableBot, moves to another bot when it was the open one, and reports
 * through `notify`: nothing first, then the Undo notice or the error.
 */
export async function archiveBotWithNotice(bot: Bot, context: {
  bots: readonly Bot[];
  selectedId: string | null;
  dispatch: (action: Action) => void;
  showThreads: boolean;
  notify: (notice: ArchiveNotice | null) => void;
}): Promise<void> {
  const { dispatch, notify } = context;
  const activeBots = context.bots.filter((candidate) => !candidate.hidden);
  notify(null);
  try {
    const response = await api(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ hidden: true }),
    });
    dispatch({ type: "botPatched", bot: response.bot });
    if (context.selectedId === bot.id) {
      const next = activeBots.find((candidate) => candidate.id !== bot.id);
      if (next) openBot(dispatch, next, context.showThreads);
    }
    notify({
      error: false,
      text: t("sidebar.bot.archived", { name: bot.name }),
      restoreBot: { id: bot.id, name: bot.name },
    });
  } catch (cause) {
    notify({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
  }
}
