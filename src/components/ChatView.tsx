export { ErrorRow } from "./chat-view/error-row";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Bug, Crown, Monitor, Search, Square } from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import {
  api,
  currentTaskBot,
  useStore,
  useStreaming,
  openNotificationTarget,
  visibleMessages,
  type Bot,
  overlayOpen,
} from "@/state/store";
import { BotAvatar } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { stateForBot } from "@/lib/mascot";
import { peerLine } from "@/lib/peer-message";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { VerifyCard } from "./VerifyCard";
import { askText, runSteps, runSummary, showRun, skillPrompt, skillStaged } from "@/lib/verify-steps";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { RenameTitle } from "./RenameTitle";
import { BotActivityPicker, TaskPicker } from "./TaskPicker";
import { ModelPicker } from "./ModelPicker";
import { ExportTranscriptMenu } from "./ExportTranscriptMenu";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { useFocusMessage } from "@/lib/focus-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { appendComposerDraft, useReplyDraft } from "@/lib/drafts";
import { MessagesList } from "./chat-view/messages-list";
import { PinnedBanner } from "./chat-view/pinned-banner";
import { UsageChip } from "./chat-view/usage-chip";
export function ChatView({ bot: profile }: { bot: Bot }) {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // Windows has no native caption buttons (renderer-drawn, see
  // WindowCaptionButtons); this header is the window drag region, and the
  // icon row shifts below the 26px-tall corner the buttons occupy.
  const { dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  // The bot's run in the current ask — every command it ran, the control-CLI
  // ones verified — for the run card. Saving mirrors the /learn gate: the
  // flag, an engine with the agents tools, and a bot that can take a message
  // now — plus a run with something to keep.
  const recordedRun = useMemo(() => runSteps(messages), [messages]);
  const recordedRunCounts = runSummary(recordedRun);
  const engineSupportsAgents = Boolean(
    state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp,
  );
  const canSaveRun =
    skillAuthoringEnabled(state.config) && engineSupportsAgents && recordedRunCounts.passed > 0 && recordedRunCounts.running === 0 && !bot.busy;
  // A dismissal is pinned to the run's last step, per thread: the card comes
  // back when the bot runs another command, not merely when a step settles,
  // and stays away across a switch to another thread and back.
  const [runDismissed, setRunDismissed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const lastRunStep = recordedRun.at(-1);

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is anchored per bot+task; a
  // render-phase reset re-tails it on switch so the old thread's boundary
  // never flashes into the new one. Everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId, text });
    },
    [bot.id, bot.threadId, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text" && !peerLine(m)),
    [messages],
  );
  const lastUserMessageHasAttachments = useMemo(() => {
    if (!lastUserMessage?.text) return false;
    const attached = splitTranscriptAttachments(lastUserMessage.text);
    return attached.images.length > 0 || attached.files.length > 0;
  }, [lastUserMessage]);

  // Mascot while the turn works. Streaming stays invisible — when the reply
  // is finished, the whole bubble pops in above the mascot.
  const lastMessage = messages.at(-1);
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined;
  const activityLabel = liveActivityLabel(lastMessage);
  const waiting = Boolean(
    bot.busy &&
      bot.activity !== "waiting-on-you" &&
      showWorkingDots(bot.busy, lastMessage),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<string | null>(null);
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [bot.id]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    const messageId = lastMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    setPopping(messageId);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current === messageId ? null : current);
    }, 520);
  }, [lastMessage?.id, lastMessage?.role, lastMessage?.kind]);
  const presenceVisible = waiting || popping !== null;
  // Wall-clock anchor for the working row's elapsed readout — the server
  // stamps the turn's real start (turnStartedAt), so switching threads keeps
  // the count truthful; Date.now() only covers servers without the stamp.
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(bot.busy ? bot.turnStartedAt ?? Date.now() : null);
  }, [bot.busy, bot.id, bot.threadId, bot.turnStartedAt]);

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, bot.threadId, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);
  useBottomFollowResize(scrollRef, transcriptRef, followRef, transcriptKey);

  useEffect(() => setBottomFollow(true), [bot.id, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, messages, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted: flipping it true used to yank the
  // viewport to the end. Re-pinning only arms future content; Jump to latest
  // and this effect on new rows do the scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, composerDock.pad]);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandHeight.current === null || !el) return;
    el.scrollTop += el.scrollHeight - preExpandHeight.current;
    preExpandHeight.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home/ArrowUp
  // break follow like an upward wheel; the at-end onScroll check re-arms it.
  // ArrowUp only counts outside inputs — in the composer it edits, not scrolls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === "PageUp" || ((e.key === "Home" || e.key === "ArrowUp") && !typing)) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  const routineExecution = state.routineRuns.find((run) => run.target === "bot" && run.botId === bot.id && run.threadId === bot.threadId);
  const resultsThreadId = routineExecution?.resultsThreadId ?? routineExecution?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <div
        style={headerDragStyle}
        className={cn(
          // @container so the chips on the right can fold to icon bubbles
          // when the column is narrow (side panel open, small window)
          "@container/chathead flex items-center justify-between px-5 py-3",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1" style={headerNoDragStyle}>
          <button
            onClick={() => dispatch({ type: "openOverlay", kind: "settings", open: true })}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-raised/50"
            title={t("chat.openProfile")}
            aria-label={t("chat.openProfileAria", { name: bot.name })}
          >
            <BotAvatar
              bot={bot}
              state={stateForBot({ ...bot, messages })}
              size={28}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </button>
          <RenameTitle
            value={bot.name}
            onCommit={(name) => {
              if (window.ogb?.remoteClient?.active) {
                void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                  .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                  .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
              } else {
                dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
              }
            }}
            onActivate={() => dispatch({ type: "openOverlay", kind: "settings", open: true })}
            showEditButton
            className="truncate text-[15px] font-semibold text-ink"
            inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
          />
          {bot.chiefOfStaff && (
            <span className="flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Crown size={11} /> {t("chat.chiefOfStaff")}
            </span>
          )}
          {bot.busy && <WorkingDots className="text-ink-secondary" />}
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          // The caption buttons sit over the header's right end; drop this
          // icon row 16px (visual only — the header keeps its height) so the
          // buttons clear the 26px overlay while the rest of the layout stays.
          style={controlsShiftStyle}
        >
          <button
            onClick={() => setFindOpen((open) => !open)}
            aria-label={t("chat.find")}
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.findShortcut")}
          >
            <Search size={18} />
          </button>
          <ExportTranscriptMenu
            title={bot.name}
            messages={messages}
            botName={bot.name}
          />
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
                COMPACT_BUBBLE,
              )}
              title={t("chat.stopTurn")}
            >
              <Square size={12} className="fill-current" />
              <span className="@max-4xl/chathead:hidden">{t("chat.stop")}</span>
            </button>
          )}
          <TaskPicker bot={bot} />
          <UsageChip bot={bot} />
          {!remoteClient && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} />}
          <CallButton bot={bot} />
          <button
            data-tour="computer"
            onClick={() => dispatch({ type: "openOverlay", kind: "computer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              overlayOpen(state, "computer") ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")}
          >
            <Monitor size={18} />
          </button>
          {!remoteClient && <button
            onClick={() => dispatch({ type: "openOverlay", kind: "inspector" })}
            aria-label={t("chat.inspector")}
            aria-pressed={overlayOpen(state, "inspector")}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              overlayOpen(state, "inspector") ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.inspectorHint")}
          >
            <Bug size={18} />
          </button>}
        </div>
      </div>

      <BotActivityPicker bot={bot} />
      {routineExecution && <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">{t("routines.executionDetails", { name: routineExecution.routineName })}</span>
        {canOpenResults && resultsThreadId && <button type="button" onClick={() => openNotificationTarget(dispatch, { botId: bot.id, threadId: resultsThreadId }, state)} className="rounded px-2 py-1 text-accent hover:bg-raised">{t("routines.results.back")}</button>}
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", routineId: routineExecution.routineId, botId: bot.id })} className="rounded px-2 py-1 hover:bg-raised hover:text-ink">{t("routines.logs")}</button>
      </div>}
      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      {/* Error banner */}
      {state.error && (
        <div className="w-full px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}
      {state.notice && (
        <div className="w-full px-5">
          <div role="status" className="mb-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
            {state.notice.botName ? t("thread.goneShowing", { name: state.notice.botName }) : t("thread.gone")}
          </div>
        </div>
      )}

      {/* Pinned message banner */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={remoteClient ? undefined : () =>
          dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { pinnedMessageId: "" } })
        }
      />


      {/* Messages + composer share one pane so bubbles scroll into the pill
          instead of dying on a rectangular clip above a black dock. */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 [overflow-anchor:none]"
        onPointerDown={(e) => {
          // grabbing the scrollbar is a scroll gesture too — the lane lives
          // past the content box (clientWidth excludes it)
          const el = scrollRef.current;
          if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
        }}
        onWheel={(e) => {
          if (e.deltaY < 0) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume) setBottomFollow(true);
        }}
      >
        <div
          ref={transcriptRef}
          className="flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          aria-live="polite"
          aria-label={t("chat.conversationWith", { name: bot.name })}
        >
          {hiddenCount > 0 && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showEarlier", { count: hiddenCount })}
              </button>
            </div>
          )}
          <MessagesList
            bot={bot}
            locale={activeLocale()}
            messages={windowedMessages}
            transcript={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            emergingId={popping}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            onReply={selectReply}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <WorkingDots size={3.5} />
                {t("chat.provisioning")}
              </div>
            </div>
          )}
          <TurnPresence
            avatar={
              // BotAvatar, not a bare MausAvatar: an uploaded profile image
              // (and a chosen mascot body) must match the sidebar row.
              <BotAvatar
                bot={bot}
                state={toolInFlight ? "working" : "thinking"}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={presenceVisible}
            label={activityLabel}
            answering={popping !== null}
            since={busySince}
          />
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label={t("chat.jumpToLatestAria")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      {/* Keyed by task: each conversation keeps its own draft and a failed
          request can restore the old task without spilling into the newly
          selected one. ArrowUp-to-edit stays gated on busy because editing
          rewinds the thread, which a live turn forbids (the server 409s it). */}
      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
      {/* The bot's run in this ask as a checklist, once it is worth one (a
          verified step, or more than one command). Save fills this thread's
          composer with the run and the person's request and hands the caret
          over; the person adds context and sends — nothing is sent from
          here. In the dock so its height is measured with the composer's:
          the transcript pad, the jump pill and bottom-follow all move with
          it. */}
      {lastRunStep && showRun(recordedRun) && runDismissed.get(transcriptKey) !== lastRunStep.id && (
        <div className="flex justify-end px-5 pb-2">
          <VerifyCard
            key={transcriptKey}
            steps={recordedRun}
            canSave={canSaveRun}
            staged={skillStaged(messages, recordedRun)}
            onDismiss={() => setRunDismissed((current) => new Map(current).set(transcriptKey, lastRunStep.id))}
            onSave={() => {
              appendComposerDraft(`bot:${bot.id}:${bot.threadId}`, skillPrompt(recordedRun, askText(messages)));
              composerDockRef.current?.querySelector("textarea")?.focus();
            }}
          />
        </div>
      )}
      <Composer
        key={bot.threadId}
        bot={profile}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
        onEditLast={lastUserMessage && !lastUserMessageHasAttachments && !bot.busy
          ? () => setEditingId(lastUserMessage.id)
          : undefined}
      />
      </div>
      </div>

    </main>
  );
}
