import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { lastExchange, type SuggestionRow } from "../../shared/suggested-reply";
import { useFeature } from "@/lib/use-feature";
import { api } from "@/state/store";

/** In memory only, per thread: the suggestion for one reply, and the replies already asked about or turned down. */
const offered = new Map<string, { after: string; text: string }>();
const asked = new Map<string, string>();
const declined = new Map<string, string>();

export const SUGGESTION_DELAY_MS = 400;

export interface SuggestedReplyInput {
  /** The bot whose own conversation this composer writes to; none in a room. */
  botId?: string;
  threadId: string;
  messages: readonly SuggestionRow[];
  /** The bot is working on this thread. */
  working: boolean;
  /** Something else comes first: an approval waits, a message is queued, a reply is being quoted, or the field is locked. */
  held: boolean;
  /** Whatever the field holds, typed or attached. */
  draft: string;
  attached: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  fill(text: string): void;
}

export interface SuggestedReply {
  /** The suggestion now showing, or null. */
  text: string | null;
  accept(): void;
  dismiss(): void;
  /** Tab takes the suggestion and Escape turns it down; true when the key was used. */
  onKeyDown(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "preventDefault">): boolean;
}

/** One faded next line after a reply that finished while this composer was open: the bot was seen working, or the person
 * sent a message here (a quick reply can start and end between two renders). Asked for once per reply, after a short
 * pause, and cancelled the moment anything else happens in the thread or the field. */
export function useSuggestedReply(input: SuggestedReplyInput): SuggestedReply {
  const on = useFeature("suggestedReplies");
  const { botId, threadId, working, draft, attached, inputRef, fill } = input;
  const held = input.held || working;
  const exchange = useMemo(() => lastExchange(input.messages), [input.messages]);
  const replyId = exchange?.replyId ?? null;
  const [, redraw] = useState(0);
  const lastRowId = input.messages.at(-1)?.id;
  const [watched, setWatched] = useState({ threadId, worked: working, lastAtOpen: lastRowId });
  if (watched.threadId !== threadId) setWatched({ threadId, worked: working, lastAtOpen: lastRowId });
  else if (working && !watched.worked) setWatched({ ...watched, worked: true });
  else if (watched.lastAtOpen === undefined && lastRowId !== undefined) setWatched({ ...watched, lastAtOpen: lastRowId });
  const sent = useMemo(() => {
    if (watched.threadId !== threadId || watched.lastAtOpen === undefined || !exchange) return false;
    const openedAt = input.messages.findIndex((row) => row.id === watched.lastAtOpen);
    return openedAt >= 0 && input.messages.findIndex((row) => row.id === exchange.askId) > openedAt;
  }, [watched, threadId, exchange, input.messages]);
  const lastThread = useRef(threadId);

  useEffect(() => {
    const sameThread = lastThread.current === threadId;
    lastThread.current = threadId;
    if (sameThread && draft && replyId && (offered.get(threadId)?.after === replyId || asked.get(threadId) === replyId)) declined.set(threadId, replyId);
  }, [threadId, draft, replyId]);

  const live = on && Boolean(botId) && ((watched.threadId === threadId && watched.worked) || sent) && !held && !draft && !attached;
  useEffect(() => {
    if (!live || !replyId || asked.get(threadId) === replyId) return;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      asked.set(threadId, replyId);
      api<{ text?: string | null }>("/api/suggested-reply", { method: "POST", body: JSON.stringify({ botId, threadId, after: replyId }), signal: stop.signal })
        .then((answer) => {
          if (stop.signal.aborted || !answer?.text) return;
          offered.set(threadId, { after: replyId, text: answer.text });
          redraw((n) => n + 1);
        })
        .catch(() => {});
    }, SUGGESTION_DELAY_MS);
    return () => { clearTimeout(timer); stop.abort(); };
  }, [live, botId, threadId, replyId]);

  const current = offered.get(threadId);
  const text = on && botId && !held && !draft && !attached && replyId && current?.after === replyId && declined.get(threadId) !== replyId ? current.text : null;

  const dismiss = () => {
    if (!replyId) return;
    declined.set(threadId, replyId);
    redraw((n) => n + 1);
  };
  const accept = () => {
    if (!text) return;
    dismiss();
    fill(text);
    inputRef.current?.focus();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(text.length, text.length));
  };
  const onKeyDown: SuggestedReply["onKeyDown"] = (event) => {
    if (!text || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key !== "Tab" && event.key !== "Escape") return false;
    event.preventDefault();
    if (event.key === "Tab") accept();
    else dismiss();
    return true;
  };
  return { text, accept, dismiss, onKeyDown };
}

/** Clears every remembered suggestion; tests only. */
export function forgetSuggestedReplies(): void {
  offered.clear();
  asked.clear();
  declined.clear();
}
