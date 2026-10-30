import { useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { useCopyFeedback } from "@/lib/copy-text";
import { botUnreadThreadIds, markBotRead } from "@/lib/folder-read";
import { useShowThreads } from "@/lib/thread-preferences";
import { api, useStore, type Bot } from "@/state/store";
import { announceArchiveNotice, archiveBotWithNotice } from "../bot-archive";
import { moveBotsToSection } from "../bot-sections";
import { currentArchivableBot, type BotConfirmKind } from "../Sidebar";

export function useBotActions(bot: Bot) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [confirm, setConfirm] = useState<BotConfirmKind | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const readInFlight = useRef(false);
  const copy = useCopyFeedback(bot.threadId);

  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveHint = bot.chiefOfStaff
    ? t("sidebar.bot.archiveBlockedChief")
    : visibleBotCount <= 1
      ? t("sidebar.bot.archiveBlockedLast")
      : undefined;

  const togglePin = () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } });
  const duplicate = () => dispatch({ type: "duplicateBot", botId: bot.id });

  const markAllRead = async () => {
    if (readInFlight.current) return;
    readInFlight.current = true;
    setReading(true);
    setReadError(null);
    try {
      await markBotRead(bot, api, (updated) => dispatch({ type: "botPatched", bot: updated }));
    } catch (error) {
      const guidance = t("sidebar.bot.markAllReadFailed");
      setReadError(error instanceof Error ? `${guidance} ${error.message}` : guidance);
    } finally {
      readInFlight.current = false;
      setReading(false);
    }
  };

  // The sidebar's own archive path: its corner notice says "Archived" with Undo, or why it failed.
  const archive = async () => {
    const current = currentArchivableBot(state.bots, bot.id);
    if (!current) return;
    await archiveBotWithNotice(current, {
      bots: state.bots,
      selectedId: state.selectedId,
      dispatch,
      showThreads,
      notify: (notice) => {
        // With no sidebar on screen (the calendar), a failure still has to be said somewhere.
        if (!announceArchiveNotice(notice) && notice?.error) dispatch({ type: "error", message: notice.text });
      },
    });
  };

  const requestArchive = () => {
    if (currentArchivableBot(state.bots, bot.id)) setConfirm("archive");
  };

  const confirmed = () => {
    const kind = confirm;
    setConfirm(null);
    if (!kind) return;
    dispatch({ type: "toggleSettings", open: false });
    if (kind === "archive") void archive();
    else dispatch({ type: "deleteBot", botId: bot.id });
  };

  const moveToTeam = (section: string) => {
    if ((bot.section?.trim() ?? "") !== section) moveBotsToSection(dispatch, [bot.id], section);
  };

  return {
    togglePin,
    duplicate,
    copyId: copy.copy,
    copyState: copy.state,
    markAllRead: () => void markAllRead(),
    reading,
    readError,
    hasUnread: botUnreadThreadIds(bot).length > 0,
    archiveBlocked: archiveHint !== undefined,
    archiveHint,
    requestArchive,
    requestDelete: () => setConfirm("delete"),
    confirm,
    cancelConfirm: () => setConfirm(null),
    confirmed,
    deleting: state.deletingBots[bot.id] === true,
    moveToTeam,
  };
}
