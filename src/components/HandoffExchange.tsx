// A teammate's hand-off, read in place of the asker's chat: the two bots' exchange, live, with no message box.
import { createContext, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ArrowLeftRight, ChevronLeft } from "lucide-react";
import { BotAvatar, InitialsAvatar } from "./Avatar";
import { ChatMarkdown } from "./ChatMarkdown";
import { DaySeparator } from "./DaySeparator";
import { ClusterLabel } from "./RoomClusterLabel";
import { ChatBackdrop, GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { ELEVATED_FLOAT, ELEVATED_HOVER, ELEVATED_TINT } from "./elevated";
import { joinedCorners, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, SIMPLE_STACKED, SIMPLE_USER_BUBBLE } from "./chat-bubble";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import { conversationRows, handoffTranscript, LOADING_TRANSCRIPT, type ConversationRow, type ConversationSpeaker } from "@/lib/handoff-conversation";
import { intlLocale, t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { localDay } from "@/lib/transcript-derivations";
import { loadFullThread } from "@/state/message-history";
import type { Bot, Message } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

type Named = ConversationSpeaker & { botId: string };

export interface HandoffExchange {
  asker: Named;
  helper: Named;
  /** The helper's work thread the hand-off went to. */
  threadId: string;
}

/** Opens a hand-off's exchange in place of the chat it is in. Null where no chat column hosts one (a room, the side
 * panel): a hand-off line there opens the helper's thread instead. */
export const OpenExchangeContext = createContext<((exchange: HandoffExchange) => void) | null>(null);

/** The main chat column: the chat, or a hand-off's exchange in its place. Back mounts the chat again, which opens
 * where the person was reading. */
export function HandoffExchangeHost({ bot, children }: { bot: Bot; children: ReactNode }) {
  const chat = `${bot.id}:${bot.threadId}`;
  const [open, setOpen] = useState<{ chat: string; exchange: HandoffExchange } | null>(null);
  if (open && open.chat !== chat) setOpen(null);
  const openExchange = useCallback((exchange: HandoffExchange) => setOpen({ chat, exchange }), [chat]);
  const exchange = open?.chat === chat ? open.exchange : null;
  if (exchange) return <HandoffExchangeView key={exchange.threadId} exchange={exchange} onBack={() => setOpen(null)} />;
  return <OpenExchangeContext value={openExchange}>{children}</OpenExchangeContext>;
}

export function HandoffExchangeView({ exchange: { asker, helper, threadId }, onBack }: { exchange: HandoffExchange; onBack: () => void }) {
  const [transcript, dispatch] = useReducer(handoffTranscript, LOADING_TRANSCRIPT);
  const [load, setLoad] = useState(0);
  const reload = () => {
    dispatch({ type: "reload" });
    setLoad((count) => count + 1);
  };
  const bots = useStoreSelector((state) => state.bots);
  const { dragProps, noDragStyle } = useCaptionChrome();
  const remoteClient = window.ogb?.remoteClient?.active === true;

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

  const today = localDay(Date.now());
  const label = t("chat.handoffExchange.label", { asker: asker.name, helper: helper.name });
  const backTo = t("chat.handoffExchange.backTo", { name: asker.name });
  const botOf = (speaker: ConversationSpeaker) => speaker.botId ? bots.find((candidate) => candidate.id === speaker.botId) : undefined;

  return (
    <main data-look="chat" data-handoff-exchange={threadId} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <ChatBackdrop />
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
        <GlassBar edge="top" fade={!remoteClient} className="z-[25]">
          <div {...dragProps} data-look="chat-header" className="px-5 pb-2.5 pt-2.5 max-md:pl-14 max-md:pr-3">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-2">
              <button
                type="button"
                data-exchange-back
                onClick={onBack}
                aria-label={t("chat.handoffExchange.back")}
                title={t("chat.handoffExchange.back")}
                style={noDragStyle}
                className={cn("flex size-9 items-center justify-center justify-self-start rounded-full text-ink-secondary hover:text-ink", ELEVATED_FLOAT, ELEVATED_HOVER)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <div
                role="group"
                aria-label={label}
                data-chathead-pill
                style={noDragStyle}
                className={cn("flex min-w-0 max-w-full items-center gap-1.5 rounded-full p-[3px] pr-[13.5px] text-ink", ELEVATED_FLOAT)}
              >
                <button
                  type="button"
                  onClick={onBack}
                  aria-label={backTo}
                  title={backTo}
                  className={cn("flex min-w-0 items-center gap-2 rounded-full py-[4.5px] pl-[4.5px] pr-2", ELEVATED_TINT)}
                >
                  <Face speaker={asker} bot={botOf(asker)} />
                  <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{asker.name}</span>
                </button>
                <ArrowLeftRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
                <span className="flex min-w-0 items-center gap-2 py-[4.5px] pl-1">
                  <Face speaker={helper} bot={botOf(helper)} />
                  <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{helper.name}</span>
                </span>
              </div>
            </div>
          </div>
        </GlassBar>

        <div
          ref={listRef}
          className="glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-4"
          onScroll={(event) => {
            const list = event.currentTarget;
            atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
          }}
        >
          <div role="log" aria-live="polite" aria-label={label} data-simple-rows=""
            className="glass-scroller-content chat-column relative flex w-full flex-col gap-4 pb-8">
            {rows.map((row, index) => {
              const previous = rows[index - 1], next = rows[index + 1];
              const day = !previous || localDay(row.at) !== localDay(previous.at);
              const above = Boolean(previous) && !day && sameSpeaker(previous!, row);
              const below = Boolean(next) && localDay(next!.at) === localDay(row.at) && sameSpeaker(next!, row);
              const person = row.side === "person";
              return (
                <Fragment key={row.id}>
                  {day && <DaySeparator at={row.at} today={today} simple />}
                  <div data-mid={row.id} data-side={row.side} className={cn("flex w-full flex-col", person ? "items-end" : "items-start", above && SIMPLE_STACKED)}>
                    {!above && !person && (
                      <div className="mb-1"><ClusterLabel bot={botOf(row.speaker)} name={row.speaker.name} color={row.speaker.color ?? ""} /></div>
                    )}
                    <div
                      data-chat-bubble="simple"
                      title={new Date(row.at).toLocaleString(intlLocale())}
                      className={cn("chat-text w-fit", SIMPLE_BUBBLE_MAX,
                        person ? cn(SIMPLE_USER_BUBBLE, "whitespace-pre-wrap [overflow-wrap:anywhere] text-ink") : SIMPLE_BOT_BUBBLE,
                        joinedCorners(person ? "end" : "start", { above, below }))}
                    >
                      {person ? row.text : <ChatMarkdown text={row.text} />}
                    </div>
                  </div>
                </Fragment>
              );
            })}
            {!rows.length && (
              <p className="py-6 text-center text-[13px] text-ink-secondary">
                {transcript.loading ? t("chat.handoffExchange.loading")
                  : transcript.failed ? t("chat.handoffExchange.failed") : t("chat.handoffExchange.empty")}
              </p>
            )}
            {transcript.failed && (
              <div className="text-center">
                <button type="button" onClick={reload}
                  className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover">
                  {t("common.tryAgain")}
                </button>
              </div>
            )}
          </div>
        </div>
      </GlassScrollFrame>
    </main>
  );
}

function sameSpeaker(a: ConversationRow, b: ConversationRow): boolean {
  return a.side === b.side && a.speaker.botId === b.speaker.botId && a.speaker.name === b.speaker.name;
}

function Face({ speaker, bot }: { speaker: ConversationSpeaker; bot: Bot | undefined }) {
  if (bot) return <BotAvatar bot={bot} state="happy" size={24} animated={false} />;
  return <InitialsAvatar initials={speaker.name.slice(0, 1).toUpperCase()} size={24} />;
}
