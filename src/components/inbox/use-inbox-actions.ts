import { useCallback } from "react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { useShowThreads } from "@/lib/thread-preferences";
import { openThread, useStore } from "@/state/store";
import { doneInboxRow, openInbox, readInboxRow, refreshInbox } from "@/state/inbox";
import type { CardResponse } from "@/lib/card-answer";
import { closeResponse, type QuickAction } from "./inbox-view";

/** What a row's buttons do. An ask is answered through its copy's card here, which answers the card where it was asked,
 * as its buttons in the chat do; a line of news is done, or opened where it came from. */
export function useInboxActions(view: InboxView | null) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();

  const answer = useCallback((row: InboxRow, response: CardResponse, failed?: () => void) => {
    if (!view?.threadId || !row.card?.requestId) return;
    readInboxRow(row);
    dispatch({ type: "decideRequest", threadId: view.threadId, requestId: row.card.requestId, behavior: response.behavior, ...(response.message ? { message: response.message } : {}),
      onError: () => { failed?.(); void refreshInbox(); } });
  }, [view, dispatch]);

  const openInChat = useCallback((row: InboxRow) => {
    readInboxRow(row);
    const target = row.origin ? { botId: row.origin.botId, threadId: row.origin.threadId, messageId: row.origin.messageId }
      : view?.threadId ? { botId: view.botId, threadId: view.threadId, messageId: row.id } : null;
    if (!target) return;
    openThread(dispatch, { botId: target.botId, threadId: target.threadId }, state, showThreads);
    if (target.messageId) dispatch({ type: "focusMessage", threadId: target.threadId, messageId: target.messageId });
  }, [view, state, dispatch, showThreads]);

  const run = useCallback((row: InboxRow, action: QuickAction) => {
    if (action === "allow" || action === "deny") answer(row, { behavior: action });
    else if (action === "close") answer(row, closeResponse(row));
    else if (action === "done") doneInboxRow(row);
    else if (action === "open") openInChat(row);
    else { readInboxRow(row); openInbox({ reading: row.id }); }
  }, [answer, openInChat]);

  /** The bot a line is from: its face leads the line's card and its colour is on the card's answer. None for a teammate's line. */
  const askerOf = (row: InboxRow) => (row.from.botId ? state.bots.find((bot) => bot.id === row.from.botId) : undefined);
  const colorOf = (row: InboxRow) => askerOf(row)?.color;

  return { run, answer, openInChat, colorOf, askerOf };
}
