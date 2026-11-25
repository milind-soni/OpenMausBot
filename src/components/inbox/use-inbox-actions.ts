import { useCallback } from "react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { useShowThreads } from "@/lib/thread-preferences";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { openThreadBeside } from "@/lib/room-feed";
import { openThread } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { useStoreSelector } from "@/state/store-select";
import { closeInbox, doneInboxRow, openInbox, readInboxRow, refreshInbox } from "@/state/inbox";
import type { CardResponse } from "@/lib/card-answer";
import { answerThread, closeResponse, type QuickAction } from "./inbox-view";
import { attentionJumpAction, type AttentionThread } from "../SidebarBotActivity";

/** What a row's buttons do. An ask is answered through its copy's card here, which answers the card where it was asked,
 * as its buttons in the chat do; a line of news is done, or opened where it came from. */
export function useInboxActions(view: InboxView | null) {
  const store = useStoreRef(), dispatch = store.dispatch;
  const showThreads = useShowThreads();
  const phone = useMediaQuery(PHONE_LAYOUT);

  const answer = useCallback((row: InboxRow, response: CardResponse, failed?: () => void) => {
    const threadId = answerThread(view, row);
    if (!threadId || !row.card?.requestId) return;
    readInboxRow(row);
    dispatch({ type: "decideRequest", threadId, requestId: row.card.requestId, behavior: response.behavior, ...(response.message ? { message: response.message } : {}),
      onError: () => { failed?.(); void refreshInbox(); } });
  }, [view, dispatch]);

  const openInChat = useCallback((row: InboxRow) => {
    readInboxRow(row);
    const target = row.origin ? { botId: row.origin.botId, threadId: row.origin.threadId, messageId: row.origin.messageId }
      : view?.threadId && view.botId ? { botId: view.botId, threadId: view.threadId, messageId: row.id } : null;
    if (!target) return;
    if (phone || !openThreadBeside(dispatch, target.threadId, store.state())) openThread(dispatch, { botId: target.botId, threadId: target.threadId }, store.state(), showThreads);
    if (target.messageId) dispatch({ type: "focusMessage", threadId: target.threadId, messageId: target.messageId });
    // The conversation is in the main window; on a phone the inbox is a sheet over it.
    if (phone) closeInbox();
  }, [view, store, dispatch, showThreads, phone]);

  const run = useCallback((row: InboxRow, action: QuickAction) => {
    if (action === "allow" || action === "deny") answer(row, { behavior: action });
    else if (action === "close") answer(row, closeResponse(row));
    else if (action === "done") doneInboxRow(row);
    else if (action === "open") openInChat(row);
    else { readInboxRow(row); openInbox({ reading: row.id }); }
  }, [answer, openInChat]);

  return { run, answer, openInChat };
}

/** A conversation listed in the Inbox opens beside the chat with the room feed on, and in the chat otherwise. */
export function useInboxJump() {
  const store = useStoreRef(), dispatch = store.dispatch;
  const phone = useMediaQuery(PHONE_LAYOUT);
  return useCallback((entry: AttentionThread) => {
    if (phone || !openThreadBeside(dispatch, entry.task.threadId, store.state())) dispatch(attentionJumpAction(entry));
  }, [store, dispatch, phone]);
}

/** The bot a line is from: its face leads the line's card and its colour is on the card's answer. None for a teammate's line. */
export function useInboxAsker(row: InboxRow) {
  return useStoreSelector((state) => (row.from.botId ? state.bots.find((bot) => bot.id === row.from.botId) : undefined));
}
