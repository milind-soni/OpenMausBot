import { useState, type RefObject } from "react";

import { t } from "@/lib/i18n";
import { threadCommandFromComposer } from "@/lib/composer-commands";
import type { Action } from "@/state/store";
import { announceArchiveNotice } from "./bot-archive";
import { ConfirmDialog } from "./ConfirmDialog";

/** A bot conversation's /archive and /delete, as the composer runs them: the command, its action, and the notice and
 * confirmation they show. A room's threads are managed from the room, so text given no bot has no command. */
export function useComposerThreadCommand({ text, botId, threadId, mainThreadId, threads, title, busy, dispatch, returnFocusRef, onCleared }: {
  text: string;
  botId: string | undefined;
  threadId: string;
  /** The conversation the person set as main, opened after this one leaves the list when it is not archived. */
  mainThreadId: string | undefined;
  /** The bot's conversations, for the next active one when there is no main to open. */
  threads: ReadonlyArray<{ threadId: string; updatedAt?: number; createdAt?: number; archivedAt?: number; routineRunId?: string }> | undefined;
  title: string | undefined;
  busy: boolean;
  dispatch: (action: Action) => void;
  returnFocusRef?: RefObject<HTMLTextAreaElement | null>;
  /** Clears the command out of the composer once it has run. */
  onCleared: () => void;
}) {
  const command = botId ? threadCommandFromComposer(text) : null;
  const [confirming, setConfirming] = useState(false);

  const nextThread = () => {
    if (!botId) return;
    const rest = (threads ?? []).filter((thread) => thread.threadId !== threadId && thread.archivedAt === undefined && thread.routineRunId === undefined);
    const target = mainThreadId && mainThreadId !== threadId && rest.some((thread) => thread.threadId === mainThreadId)
      ? mainThreadId
      : rest.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0]?.threadId;
    if (target) dispatch({ type: "switchTask", botId, threadId: target });
  };
  const run = () => {
    if (!command || !botId) return;
    if (busy) {
      dispatch({ type: "error", message: t(command === "archive" ? "composer.command.archiveBusy" : "composer.command.deleteBusy") });
      return;
    }
    if (command === "delete") { setConfirming(true); return; }
    const archivedThreadId = threadId;
    onCleared();
    nextThread();
    dispatch({ type: "updateTask", botId, threadId, patch: { archivedAt: Date.now() } });
    // The sidebar's notice outlives this composer, which the conversation switch remounts.
    announceArchiveNotice({
      error: false,
      text: t("composer.command.archived"),
      undo: () => dispatch({ type: "updateTask", botId, threadId: archivedThreadId, patch: { archivedAt: null } }),
    });
  };
  const confirmDelete = () => {
    if (!botId) return;
    setConfirming(false);
    if (busy) { dispatch({ type: "error", message: t("composer.command.deleteBusy") }); return; }
    onCleared();
    nextThread();
    dispatch({ type: "deleteTask", botId, threadId });
  };

  const dialog = (
    <ConfirmDialog
      open={confirming}
      title={t("task.deleteConfirm")}
      body={t("task.deleteBody", { title: title || t("task.untitledConversation") })}
      confirmLabel={t("task.deleteAria")}
      tone="danger"
      onCancel={() => setConfirming(false)}
      onConfirm={confirmDelete}
      returnFocusRef={returnFocusRef}
    />
  );
  return { command, run, dialog };
}
