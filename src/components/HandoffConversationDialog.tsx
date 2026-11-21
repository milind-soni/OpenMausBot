// The read-only pop-up a hand-off line opens: the two bots' conversation, live, over the asker's chat.
import { Fragment, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock, X } from "lucide-react";
import { BotAvatar, InitialsAvatar } from "./Avatar";
import { ChatMarkdown } from "./ChatMarkdown";
import { DaySeparator } from "./DaySeparator";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { conversationRows, handoffTranscript, LOADING_TRANSCRIPT, type ConversationRow, type ConversationSpeaker } from "@/lib/handoff-conversation";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { MAUS_COLOR_NAMES } from "@/lib/mascot";
import { localDay } from "@/lib/transcript-derivations";
import { loadFullThread } from "@/state/message-history";
import { formatTime, type Bot, type Message } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

type Named = ConversationSpeaker & { botId: string };

interface HandoffConversationDialogProps {
  asker: Named;
  helper: Named;
  threadId: string;
  /** Shown under the names until the asking line has loaded. */
  request: string;
  /** When the hand-off was sent. */
  at: number;
  onClose: () => void;
  onTalk: () => void;
  onOpenThread: () => void;
}

export function HandoffConversationDialog({ asker, helper, threadId, request, at, onClose, onTalk, onOpenThread }: HandoffConversationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  const [transcript, dispatch] = useReducer(handoffTranscript, LOADING_TRANSCRIPT);
  const [load, setLoad] = useState(0);
  const reload = () => {
    dispatch({ type: "reload" });
    setLoad((count) => count + 1);
  };
  const bots = useStoreSelector((state) => state.bots);

  useEffect(() => {
    let current = true;
    loadFullThread(threadId).then(
      ({ messages, activeLeafId }) => current && dispatch({ type: "loaded", messages, activeLeafId }),
      () => current && dispatch({ type: "failed" }),
    );
    return () => { current = false; };
  }, [threadId, load]);

  useEffect(() => listenLiveFrames({
    onFrame: (frame) => {
      if (!("threadId" in frame) || frame.threadId !== threadId) return;
      if (frame.kind === "message" || frame.kind === "message.patch") {
        dispatch({ type: "message", message: frame.message as Message, patch: frame.kind === "message.patch" });
      } else if (frame.kind === "thread") dispatch({ type: "active", activeLeafId: frame.activeLeafId });
    },
    onMissedFrames: reload,
  }), [threadId]);

  // The speakers come in as new objects on every render of the line; what they say only changes with these.
  const you = t("chat.you");
  const rows = useMemo(() => conversationRows(transcript, asker, helper, you),
    [transcript, asker.botId, asker.name, asker.color, helper.botId, helper.name, helper.color, you]);
  // The newest line stays in sight as lines come in, unless the person scrolled up to read.
  const listRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atEnd.current) list.scrollTop = list.scrollHeight;
  }, [rows]);
  // A standing work thread holds every hand-off between the two bots: this one starts at the asker's line nearest it.
  const askIndex = nearestAsk(rows, asker.botId, at);
  const subtitle = (askIndex >= 0 && requestLine(rows[askIndex]!.text, helper.name)) || request;
  const today = localDay(Date.now());
  const count = t(rows.length === 1 ? "chat.handoffConversation.count.one" : "chat.handoffConversation.count.other", { count: rows.length });
  const handoffLine = (
    <>
      <DaySeparator at={at} today={today} simple />
      <p className="pb-3 text-center text-[12px] text-ink-secondary">
        {t("chat.handoffConversation.request", { asker: asker.name, helper: helper.name })}
      </p>
    </>
  );

  const content = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      // The pop-up sits in a chat line in React's tree: its clicks and keys stop here, not in the transcript.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.handoffConversation.label", { asker: asker.name, helper: helper.name })}
        tabIndex={-1}
        data-handoff-conversation={threadId}
        className="animate-pop-in flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline/40 px-5 pb-4 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex shrink-0 items-center">
              <SpeakerAvatar speaker={asker} bots={bots} size={32} />
              <span className="-ml-2 rounded-full ring-2 ring-panel"><SpeakerAvatar speaker={helper} bots={bots} size={32} /></span>
            </span>
            <div className="min-w-0">
              <h2 className="flex min-w-0 items-center gap-1.5 text-[16px] font-semibold text-ink">
                <SpeakerName speaker={asker} /><span aria-hidden="true" className="text-ink-tertiary">⇄</span><SpeakerName speaker={helper} />
              </h2>
              {subtitle && <p className="mt-0.5 flex min-w-0 text-[13px] text-ink-secondary"><span className="truncate">{subtitle}</span></p>}
              <p className="mt-0.5 text-[12px] text-ink-tertiary">{count}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={19} />
          </button>
        </header>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          aria-live="polite"
          onScroll={(event) => {
            const list = event.currentTarget;
            atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
          }}
        >
          {askIndex < 0 && handoffLine}
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {index === askIndex ? handoffLine : newDay(row.at, index ? rows[index - 1]!.at : askIndex < 0 ? at : undefined)
                && <DaySeparator at={row.at} today={today} simple />}
              <div className="flex gap-2.5 py-1.5" data-side={row.side}>
                <SpeakerAvatar speaker={row.speaker} bots={bots} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <SpeakerName speaker={row.speaker} />
                    <span className="text-[11px] text-ink-tertiary">{formatTime(row.at)}</span>
                  </div>
                  <div className="mt-1 rounded-xl bg-inset px-3 py-2 text-[14px] leading-6 text-ink">
                    <ChatMarkdown text={row.text} />
                  </div>
                </div>
              </div>
            </Fragment>
          ))}
          {!rows.length && (
            <p className="py-6 text-center text-[13px] text-ink-secondary">
              {transcript.loading ? t("chat.handoffConversation.loading")
                : transcript.failed ? t("chat.handoffConversation.failed") : t("chat.handoffConversation.empty")}
            </p>
          )}
          {transcript.failed && (
            <div className="text-center">
              <button type="button" onClick={reload}
                className="rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover">
                {t("common.tryAgain")}
              </button>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline/40 px-5 py-3.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
            <Lock size={13} aria-hidden="true" className="shrink-0" />
            {t("chat.handoffConversation.readOnly", { asker: asker.name })}
          </span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={onOpenThread} className="rounded-lg px-3 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink">
              {t("chat.handoffConversation.openThread")}
            </button>
            <button type="button" onClick={onTalk} className="rounded-lg bg-control px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover">
              {t("chat.handoffConversation.talkTo", { asker: asker.name })}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}

/** The asker's line closest in time to the hand-off, or -1. */
function nearestAsk(rows: readonly ConversationRow[], askerId: string, at: number): number {
  let best = -1;
  rows.forEach((row, index) => {
    if (row.speaker.botId === askerId && (best < 0 || Math.abs(row.at - at) < Math.abs(rows[best]!.at - at))) best = index;
  });
  return best;
}

/** The first written line of the ask, without the helper's @name it opens with. */
function requestLine(text: string, helperName: string): string {
  const mention = `@${helperName}`;
  const trimmed = text.trim();
  const body = trimmed.startsWith(mention) && !/^[\p{L}\p{N}_]/u.test(trimmed.slice(mention.length)) ? trimmed.slice(mention.length) : trimmed;
  return body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function newDay(at: number, previous: number | undefined): boolean {
  return previous === undefined || localDay(at) !== localDay(previous);
}

function SpeakerName({ speaker }: { speaker: ConversationSpeaker }) {
  const known = (MAUS_COLOR_NAMES as readonly string[]).includes(speaker.color ?? "");
  return (
    <span className={known ? "bot-identity truncate text-[13px] font-semibold" : "truncate text-[13px] font-semibold text-ink"}
      data-bot-color={known ? speaker.color : undefined}>{speaker.name}</span>
  );
}

function SpeakerAvatar({ speaker, bots, size }: { speaker: ConversationSpeaker; bots: Bot[]; size: number }) {
  const bot = speaker.botId ? bots.find((candidate) => candidate.id === speaker.botId) : undefined;
  if (bot) return <BotAvatar bot={bot} state="happy" size={size} animated={false} />;
  return <InitialsAvatar initials={speaker.name.slice(0, 1).toUpperCase()} size={size} />;
}
