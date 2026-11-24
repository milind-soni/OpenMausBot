import { reducedMotion } from "@/lib/onboarding";
import { ChatImagePreloads } from "../CachedChatImage";
import type { MentionPeer } from "@/lib/mentions";
import { useTeammates } from "@/state/team-people";
import { groupChatWork, type TranscriptItem } from "@/lib/activity-runs";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "../MenuMotion";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { stateForBot } from "@/lib/mascot";
import { JumpToLatestButton } from "../JumpToLatestButton";
import { CopyButton, INTERACTIVE, MESSAGE_ROW, MessageActions, messageActionClass, ReplyAction } from "../MessageActions";
import { ReactAction, ReactionChips } from "../Reactions";
import { replyAndCopy, useBotMessageMenu } from "../message-menu";
import { ChatHeaderMenu } from "../ChatMoreMenu";
import { ChatFindBar } from "../ChatFindBar";
import { useChatFindRequests, useChatFindShortcut } from "@/lib/chat-find";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, ChevronRight, Loader2 } from "lucide-react";
import { currentTaskBot, formatTime, type Bot, type Message } from "@/state/store";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useChatHistory } from "@/state/use-chat-history";
import { isLiveReply, priorLiveReplyId, StreamingReplyContext, useLiveTranscript } from "@/state/live-reply";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { useCanWriteIn } from "@/lib/cloud-guest";
import { userBubbleStyle } from "@/lib/user-bubble-tone";
import { useReplyDraft } from "@/lib/drafts";
import { botLineText, canEditTypedMessage, isWaitFollowUpMessage } from "@/lib/transcript-derivations";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { lastNonReceipt } from "@/lib/receipts";
import { t } from "@/lib/i18n";
import { useStopPresentation } from "@/lib/stop-turn";
import { peerLine, peerRequest } from "@/lib/peer-message";
import { stripLeakedSystemHarnessMessages } from "../../../shared/system-message-guard";
import { RETRY_LEAD } from "../../../shared/failed-turn";
import { staysInView } from "../../../shared/person-wait";
import { UnloadedReplyQuote } from "./UnloadedReplyQuote";
import { ExchangeTimeline } from "./ExchangeTimeline";
import { BotAvatar } from "../Avatar";
import { Composer } from "../Composer";
import { ModelPicker } from "../ModelPicker";
import { ChatMarkdown } from "../ChatMarkdown";
import { AttachmentGallery, collectMessageFiles, isImageOnlyMarkdown, MessageAttachmentGallery, splitMessageAttachments } from "../AttachmentGallery";
import { VoiceNoteBubble } from "../VoiceNoteBubble";
import { ScreenFrame } from "../ScreenFrame";
import { optionsCardRow } from "../OptionsCardRow";
import { DataResultChip } from "../DataResultChip";
import { RichMessageRow, richRowKind } from "../RichMessageRow";
import { ToolActivity } from "../ToolActivity";
import { SignInRequestCard } from "../SignInRequestCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { ConnectorCard } from "../ConnectorCard";
import { DigestChip, CompactionChip } from "../DigestChip";
import { AutomationCaption, RoutineRunRow } from "../RoutineRunCard";
import { CallRecordRow } from "../CallRecordRow";
import { NewConversationInstead } from "../NewConversationInstead";
import { ChatErrorBanner } from "../ChatErrorBanner";
import { NewMessagesDivider } from "../NewMessagesDivider";
import { LiveCallBar } from "../LiveCallBar";
import { CallOverlay } from "../CallView";
import { FailedTurnRow } from "../FailedTurnRow";
import { useSharedRun } from "../shared-run";
import { SetupOffer } from "../SetupOffer";
import { ReplyQuote } from "../ReplyQuote";
import { useRotatingPhrase } from "../TurnPresence";

const EMPTY_TRANSCRIPT: Message[] = [];

function BotBubbleActions({ message, botId, threadId, text, canReact, onReply, raw, toggleRaw, onShowTrace }: {
  message: Message; botId: string; threadId: string; text: string; canReact: boolean;
  onReply?: () => void; raw: boolean; toggleRaw: () => void; onShowTrace?: () => void;
}) {
  const menu = useBotMessageMenu({
    text, botId, threadId, messageId: message.id, tts: undefined, localVoice: false,
    canSpeak: false, viewRaw: raw, onToggleRaw: toggleRaw,
  });
  return <MessageActions side="bot" className="v2-bubble-actions" forceOpen={raw} preferMenuAbove
    menu={onShowTrace ? [{ key: "view-trace", label: t("trace.view"), icon: <ClipboardList size={16} />, onSelect: onShowTrace }, ...menu] : menu} contextItems={onReply ? replyAndCopy(onReply, text) : []}>
    {onReply && <ReplyAction onReply={onReply} />}
    {canReact && <ReactAction threadId={threadId} message={message} badgeOnly />}
    {text && <CopyButton text={text} className={messageActionClass} />}
    <span className="v2-message-time">{formatTime(message.at)}</span>
  </MessageActions>;
}

function ChatV2Presence({ bot, stopping }: { bot: Bot; stopping: boolean }) {
  const visible = Boolean(!stopping && bot.busy && bot.activity !== "waiting-on-you");
  const { current } = useRotatingPhrase(
    [t("chat.friendly.mulling"), t("chat.friendly.thinking")],
    "thinking", `${bot.threadId}:${bot.turnStartedAt ?? ""}`, visible,
  );
  return <div className="v2-turn-status" data-visible={visible || undefined} aria-hidden={!visible || undefined}>
    <div className="v2-turn-status-clip">
      <div role="status" className="v2-turn-status-content">
        <span className="v2-working-symbol" aria-hidden="true">
          <span className="v2-working-dots"><i /><i /><i /></span>
          <span className="v2-working-avatar"><BotAvatar bot={bot} size={34} state={stateForBot(bot)} /></span>
        </span>
        <span className="v2-status-label">{current}</span>
      </div>
    </div>
  </div>;
}

export const Row = memo(function Row({ message: m, botId, botName, color, threadId, busy, hasMore, transcript, reply, failure, quoted, jumpTo, canLoadQuote, loadingQuote, digest, ownBubbleStyle, phoneLayout = false, mentionPeers }: {
  mentionPeers?: readonly MentionPeer[];
  message: Message; botId: string; botName: string; color: Bot["color"]; threadId: string;
  failure?: React.ReactNode;
  quoted?: Message;
  jumpTo: (messageId: string, loaded: boolean) => void;
  canLoadQuote: boolean;
  loadingQuote: boolean;
  ownBubbleStyle: ReturnType<typeof userBubbleStyle>;
  phoneLayout?: boolean;
  digest?: Message; busy: boolean; hasMore: boolean; transcript: Message[]; reply?: (message: Message) => void;
}) {
  const inlineTrace = useRef<HTMLDivElement>(null);
  const [showTrace, setShowTrace] = useState(false);
  useEffect(() => {
    if (!showTrace) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && !inlineTrace.current?.contains(event.target) && !event.target.closest("dialog[open]")) {
        setShowTrace(false);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [showTrace]);
  const [raw, setRaw] = useState(false);
  const props = { botId, botName, color, threadId, message: m };
  if (m.dataResult) return <DataResultChip message={m} />;
  switch (richRowKind(m)) {
    case "options": return optionsCardRow({ ...props, botColor: color, transcript });
    case "app": case "widget": return <RichMessageRow {...props} />;
    case "signin": return <SignInRequestCard {...props} />;
    case "secret": return <SecretRequestCard {...props} />;
    case "connector": return <ConnectorCard {...props} />;
    case "screen": return <ScreenFrame {...props} />;
    case "routine.run": return <RoutineRunRow {...props} />;
    case "call": return m.call && <CallRecordRow {...props} transcript={transcript} busy={busy} hasMore={hasMore} />;
    case "compaction": return <CompactionChip message={m} />;
    case "activity": return failure ?? (m.tool && <div className="v2-step"><ToolActivity tool={m.tool} live={Boolean(busy && m.tool.ok === undefined)} source={{ threadId: threadId, messageId: m.id }} />{m.comm && m.tool.output && <p>{m.tool.output}</p>}</div>);
  }
  const peer = peerLine(m) ?? peerRequest(m, botId);
  const own = m.role === "user" && !peer;
  const messageText = peer?.body ?? (own ? m.text : stripLeakedSystemHarnessMessages(botLineText(m))) ?? "";
  const legacy = own ? splitTranscriptAttachments(messageText) : null;
  const text = legacy?.display ?? messageText;
  const attached = legacy && splitMessageAttachments(m.attachments);
  const images = legacy && attached && [...legacy.images, ...attached.images];
  const files = legacy && attached && [...legacy.files, ...attached.files];
  const voiceNotes = m.attachments?.filter(a => a.kind === "audio");
  const attachmentsOnly = !m.replyToId && !text.trim() &&
    Boolean(images?.length || files?.length || m.attachments?.length);
  const bare = attachmentsOnly || (!m.replyToId && !voiceNotes?.length && !raw && isImageOnlyMarkdown(text));
  const attachmentContext = { threadId, messageId: m.id };
  if (!text && !m.attachments?.length && !images?.length && !files?.length) return null;
  return <article className="v2-message" data-own={own || undefined}>
    {peer && <b className="text-xs text-ink-secondary">{peer.name}</b>}
    <div className="v2-bubble-row group" {...{ [MESSAGE_ROW]: "" }}>
    <div className={own ? "v2-user-content" : "contents"}>
    {images && files && <AttachmentGallery images={images}
      files={[...files, ...collectMessageFiles(text, [...images.map(image => typeof image === "string" ? image : image.path), ...files.map(file => file.path)])]}
      originals={attached?.originals} message={attachmentContext} photoStrip="square" alignEnd />}
    {((text && !attachmentsOnly) || m.replyToId || !own || voiceNotes?.length) &&
    <div className={bare ? "v2-body v2-body-bare" : own ? "v2-body user-bubble-colored" : "v2-body"} dir="auto"
      style={own && !bare ? ownBubbleStyle : undefined} data-chat-bubble={attachmentsOnly ? undefined : ""} data-look={own && !bare ? "user-bubble" : undefined}
      tabIndex={digest ? 0 : undefined}
      onKeyDown={digest ? event => {
        if (event.target === event.currentTarget && event.key === "Enter") setShowTrace(true);
        if (event.key === "Escape") setShowTrace(false);
      } : undefined}
      onContextMenuCapture={digest ? event => {
        if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
        event.preventDefault();
        event.stopPropagation();
        setShowTrace(true);
      } : undefined}>
      {quoted ? <div className="mb-2">
        <ReplyQuote message={quoted} fallbackName={botName} compact onJump={() => jumpTo(quoted.id, true)} />
      </div> : m.replyToId && <UnloadedReplyQuote key={m.replyToId} threadId={threadId} messageId={m.replyToId}
        botName={botName} inverse={false} canJump={canLoadQuote} pending={loadingQuote} onJump={() => jumpTo(m.replyToId!, false)} />}
      {!own && <MessageAttachmentGallery text={text} attachments={m.attachments} message={attachmentContext} className={attachmentsOnly ? "mb-0" : undefined} />}
      {voiceNotes?.map(a => <VoiceNoteBubble key={a.path} attachment={a} />)}
      {!attachmentsOnly && (raw ? <pre className="whitespace-pre-wrap">{text}</pre> : <StreamingReplyContext value={isLiveReply(m)}>
        <ChatMarkdown text={text} mentionPeers={mentionPeers} userImages={own} message={{ threadId: threadId, messageId: m.id }} />
      </StreamingReplyContext>)}
      {!own && Boolean(m.reactions?.length) && <div className="v2-reaction-badge">
        <ReactionChips threadId={threadId} message={m} canReact={Boolean(reply) && !peer} badgeOnly />
      </div>}
    </div>}
    </div>
    {own ? reply && <MessageActions side="user" className="v2-bubble-actions" contextItems={replyAndCopy(() => reply(m), text)}><ReplyAction onReply={() => reply(m)} /></MessageActions>
      : <div className="v2-action-stack">
        <div className="v2-action-layer" inert={showTrace}>
          <BotBubbleActions message={m} botId={botId} threadId={threadId} text={text} canReact={Boolean(reply) && !peer}
          onReply={reply && (() => reply(m))} raw={raw} onShowTrace={phoneLayout && digest ? () => setShowTrace(true) : undefined} toggleRaw={() => setRaw(value => !value)} />
        </div>
        {digest && <div ref={inlineTrace} className="v2-action-layer" inert={!showTrace}><DigestChip message={digest} inline /></div>}
      </div>}
    </div>

    {m.setupOffer && <div className="mt-3 w-full"><SetupOffer {...props} transcript={transcript} /></div>}
  </article>;
});

function messageRowKey(message: Message) {
  return message.role === "user" && message.sendId ? `send:${message.sendId}` : message.id;
}

function ChatWork({ item, focusedId, children }: {
  item: Extract<TranscriptItem, { kind: "turn" }>;
  focusedId?: string;
  children: React.ReactNode;
}) {
  const [override, setOverride] = useState<{ active?: boolean; open: boolean }>();
  const open = focusedId ? true : override?.active === item.active ? override?.open ?? Boolean(item.active) : Boolean(item.active);
  const bodyId = useId();
  const motion = useMenuMotion(open);
  useEffect(() => {
    if (focusedId) setOverride({ active: item.active, open: true });
  }, [focusedId, item.active]);
  return <div className="v2-work min-w-0" data-active={item.active || undefined}>
    <div className="v2-work-content">
      <button type="button" aria-controls={bodyId} aria-expanded={open}
        onClick={() => setOverride({ active: item.active, open: !open })}
        className="flex min-h-7 items-center gap-1.5 rounded-md text-sm text-ink-tertiary hover:text-ink">
        <span className="v2-wave-label">{item.label}</span><ChevronRight size={14} aria-hidden className={cn("motion-safe:transition-transform motion-safe:duration-200", open && "rotate-90")} />
      </button>
      <div id={bodyId} inert={!open} aria-hidden={!open || undefined}
        className={cn("grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-in-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="min-h-0 min-w-0 overflow-clip">
          {motion.shown && <div className="v2-work-steps grid min-w-0 border-s border-hairline/40 ps-1">{children}</div>}
        </div>
      </div>
    </div>
  </div>;
}

export function ChatV2({ profile, phoneLayout = false }: { profile: Bot; phoneLayout?: boolean }) {
  const bot = useMemo(() => {
    if (!profile.switchingTo || profile.switchingTo === profile.threadId) return currentTaskBot(profile);
    return { ...currentTaskBot(profile, profile.switchingTo), threadId: profile.switchingTo,
      messages: [], chatPatches: undefined, activeLeafId: null, awaitingThreadSnapshot: true };
  }, [profile]);
  const imagePreloads = useMemo(() => new Set<string>(), [bot.id, bot.threadId]);
  const ownBubbleStyle = useMemo(() => userBubbleStyle(bot.color, { whiteInk: true }), [bot.color]);
  const dispatch = useStoreDispatch();
  const writable = useCanWriteIn(bot.threadId, bot.yourAccess) !== false;
  const [findOpen, setFindOpen] = useState(false);
  const forkPanelOpen = useStoreSelector(s => Boolean(s.forkPanel));
  useChatFindRequests(bot.threadId, findOpen, setFindOpen);
  useChatFindShortcut(false, forkPanelOpen, setFindOpen);
  const [botButtonHovered, setBotButtonHovered] = useState(false);
  const computerOpen = useStoreSelector(s => s.computerOpen);
  const error = useStoreSelector(s => s.error);
  const focused = useStoreSelector(s => s.focusMessage);
  const bots = useStoreSelector(state => state.bots);
  const teammates = useTeammates();
  const mentionPeers = useMemo(() => [...bots, ...teammates.peers], [bots, teammates]);
  const historyPage = useChatHistory(bot);
  const stopPresentation = useStopPresentation(bot.threadId);
  const stopping = stopPresentation === "pending";
  const lastDrawn = useRef<{ history: Message[]; messages: Message[]; busy: boolean } | null>(null);
  const frozen = stopping ? lastDrawn.current : null;
  const history = frozen?.history ?? historyPage.history;
  const busy = frozen?.busy ?? Boolean(bot.busy);
  const storedRowKeys = useMemo(() => new Set(history.map(messageRowKey)), [history]);
  const messageById = useMemo(() => new Map(history.map(message => [message.id, message])), [history]);
  const viewport = useTranscriptViewport({ ownerId: bot.id, threadId: bot.threadId, messages: history,
    hasMore: historyPage.hasMore, historyPage, rests: staysInView, pinOn: [busy] });
  const liveMessages = useLiveTranscript(bot.threadId, viewport.windowedMessages, historyPage.history);
  const messages = frozen?.messages ?? liveMessages;
  const unread = useUnreadDivider({ threadId: bot.threadId, messages: history, following: viewport.following, hasMore: historyPage.hasMore });
  const focusId = focused?.threadId === bot.threadId ? focused.messageId : undefined;
  const items = useMemo(() => groupChatWork(messages, busy, history, focusId), [messages, busy, history, focusId]);
  const digestByReply = useMemo(() => {
    const replies = new Map<string, string>();
    const digests = new Map<string, Message>();
    for (const message of history) {
      if (message.kind === "text" && message.role === "bot" && message.turnId && (message.text || message.attachments?.length)) {
        replies.set(message.turnId, message.id);
      } else if (message.digest) {
        digests.set(message.digest.turnId, message);
      }
    }
    const byReply = new Map<string, Message>();
    for (const [turnId, digest] of digests) {
      const replyId = replies.get(turnId);
      if (replyId) byReply.set(replyId, digest);
    }
    return byReply;
  }, [history]);
  const draft = useReplyDraft(bot.threadId, `bot:${bot.id}:${bot.threadId}`, history);
  const engine = useStoreSelector(s => botEngine(bot, s.instances));
  const sharedRun = useSharedRun(bot);
  const lastUser = history.findLast(m => m.role === "user" && m.kind === "text"
    && !peerLine(m) && !m.text?.startsWith(RETRY_LEAD));
  const retryable = lastNonReceipt(history)?.id;
  const retry = lastUser?.text && !isWaitFollowUpMessage(lastUser) && !lastUser.id.startsWith("optimistic-") && !bot.busy && writable && sharedRun.mayAct(lastUser.sender)
    ? () => dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUser.id, text: lastUser.text! })
    : undefined;
  const [editing, setEditing] = useState<Message | null>(null);
  const lastTyped = history.findLast(m => m.role === "user" && m.kind === "text" && !peerLine(m) && !isWaitFollowUpMessage(m) && !m.reaction);
  const sendOrigin = useRef<{ sendId: string; bounds: DOMRect } | null>(null);
  const transcriptRef = viewport.transcriptRef;
  useLayoutEffect(() => {
    const paper = transcriptRef.current;
    if (!paper) return;
    if (stopPresentation === "pending") {
      for (const word of paper.querySelectorAll(".chat-stream-word")) {
        for (const animation of word.getAnimations?.() ?? []) animation.finish();
      }
    } else if (stopPresentation === "settled" && lastDrawn.current && !reducedMotion()) {
      const before = new Set(lastDrawn.current.messages.map(message => message.id));
      for (const row of paper.querySelectorAll<HTMLElement>("[data-mid]")) {
        if (!before.has(row.dataset.mid!)) {
          row.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
        }
      }
    }
    if (!stopping) lastDrawn.current = { history, messages, busy };
  }, [stopPresentation, stopping, history, messages, busy, transcriptRef]);
  useLayoutEffect(() => {
    const origin = sendOrigin.current;
    if (!origin) return;
    const row = transcriptRef.current?.querySelector<HTMLElement>(`[data-send-id="${CSS.escape(origin.sendId)}"]`);
    if (!row) return;
    sendOrigin.current = null;
    row.style.animation = "none";
    row.closest(".v2-timeline-row")?.classList.add("v2-sent-row");
    const bubble = row.querySelector<HTMLElement>(".v2-user-content");
    if (!bubble?.animate || reducedMotion()) return;
    const end = bubble.getBoundingClientRect();
    bubble.animate([
      { transform: `translate(${origin.bounds.left - end.left}px, ${origin.bounds.top - end.top}px) scale(.96)`, opacity: 0.55 },
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
    ], { duration: 360, easing: "cubic-bezier(0.3, 0.15, 0.25, 1)" });
  }, [messages, transcriptRef]);
  const shownStreams = useRef(new Set<string>());
  useLayoutEffect(() => {
    const current = shownStreams.current;
    for (const row of transcriptRef.current?.querySelectorAll<HTMLElement>("[data-streaming][data-mid]") ?? []) {
      current.add(row.dataset.mid!);
      if (current.size > 500) current.delete(current.values().next().value!);
    }
  }, [messages, transcriptRef]);

  const renderMessage = (message: Message) => {
    const prior = priorLiveReplyId(message.id);
    const replacement = prior && shownStreams.current.has(prior) ? prior : undefined;
    return <div key={replacement ?? messageRowKey(message)} data-mid={message.id}
      data-send-id={message.role === "user" ? message.sendId : undefined} data-streaming={isLiveReply(message) || undefined} data-streamed={Boolean(replacement) || undefined} className="v2-message-enter">
      {message.automation && <div className="pb-3"><AutomationCaption message={message} line={message.automation} botId={bot.id} /></div>}
      {message.id === unread.messageId && <NewMessagesDivider fading={unread.fading} />}
      {editing?.id === message.id ? <form onSubmit={e => { e.preventDefault(); const text = String(new FormData(e.currentTarget).get("text") ?? "").trim(); if (text) { dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: editing.id, text }); setEditing(null); } }}>
        <input autoFocus className="outline-none focus:bg-raised/50" name="text" defaultValue={editing.text} onKeyDown={e => { if (e.key === "Escape") setEditing(null); }} /></form> :
        <Row mentionPeers={mentionPeers} phoneLayout={phoneLayout} ownBubbleStyle={ownBubbleStyle} digest={digestByReply.get(message.id)} message={message} botId={bot.id} botName={bot.name} color={bot.color} threadId={bot.threadId}
          busy={busy} hasMore={message.kind === "call" && historyPage.hasMore}
          failure={message.tool && failedTurnCause(message.tool.name) !== null
            ? <FailedTurnRow tool={message.tool} engine={engine} botId={bot.id} threadId={bot.threadId}
                messageAt={message.at} onRetry={message.id === retryable ? retry : undefined} />
            : undefined}
          transcript={message.setupOffer || richRowKind(message) === "options" || message.kind === "call" ? history : EMPTY_TRANSCRIPT}
          quoted={message.replyToId ? messageById.get(message.replyToId) : undefined}
          jumpTo={historyPage.jumpTo} canLoadQuote={historyPage.hasMore} loadingQuote={Boolean(message.replyToId && historyPage.pending)}
          reply={writable ? draft.selectReply : undefined} />}
    </div>;
  };
  return <main data-chat-v2 data-stop-presentation={stopPresentation} className="v2-page">
    <CallOverlay bot={bot} transcript={history} />
    <div className="v2-floating">
      <div className="v2-model"><ModelPicker bot={bot} threadId={bot.threadId} iconOnly={phoneLayout} /></div>
      <button data-tour="computer" className="v2-identity" onMouseEnter={() => setBotButtonHovered(true)} onMouseLeave={() => setBotButtonHovered(false)} aria-expanded={computerOpen} title={t("chat.botScreen")} onClick={event => {
        const keyboard = event.detail === 0;
        if (!computerOpen) {
          const composer = event.currentTarget.closest("[data-chat-v2]")
            ?.querySelector<HTMLElement>('[data-tour="composer"] [role=textbox]');
          rememberComputerPanelOpen({ botId: bot.id, opener: keyboard ? event.currentTarget : composer ?? null, tabs: keyboard });
        }
        if (!keyboard) event.currentTarget.blur();
        dispatch({ type: "toggleComputer" });
      }}><BotAvatar bot={bot} size={24} state={stateForBot(bot)} animated={botButtonHovered} /><span className="v2-identity-name">{bot.name}</span><span className="v2-identity-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button>
      <div className="v2-controls">
        <ChatHeaderMenu bot={bot} history={history} openOnHover={false} />
      </div>
    </div>
    {(findOpen || error) && <div className="v2-banners">
      {findOpen && <ChatFindBar threadId={bot.threadId} inForkPanel={false} onClose={() => setFindOpen(false)} />}
      <ChatErrorBanner message={error} onDismiss={() => dispatch({ type: "error", message: null })} />
    </div>}
    <div data-bot-list-scroll="" className="v2-scroll" ref={viewport.scrollRef} {...viewport.scrollHandlers}>
      <div ref={viewport.transcriptRef} className="v2-paper chat-column" role="log" aria-label={t("chat.conversationWith", { name: bot.name })}>
        {viewport.hasEarlier && <div ref={viewport.topSentinelRef} aria-hidden="true" className="h-px w-full" />}
        {(viewport.olderPending || ((bot.switchingTo || bot.awaitingThreadSnapshot) && !messages.length)) && (
          <div role="status" className="flex w-full justify-center py-1 text-ink-secondary">
            <Loader2 size={18} aria-hidden="true" className="motion-safe:animate-spin" />
            <span className="sr-only">{t("chat.loadingEarlier")}</span>
          </div>
        )}
        <ChatImagePreloads.Provider value={imagePreloads}>
        <ExchangeTimeline key={bot.threadId} working={!stopPresentation && Boolean(busy || history.at(-1)?.id.startsWith("optimistic-"))} ready={!bot.switchingTo && !bot.awaitingThreadSnapshot} storedKeys={storedRowKeys} items={items} botId={bot.id} focusId={focusId ?? null} unreadId={unread.messageId}
          render={item => {
            if (item.kind === "message") return renderMessage(item.message);
            if (item.kind !== "turn") return null;
            return <ChatWork key={item.id} item={item} focusedId={!focused?.consumed && item.messages.some(message => message.id === focusId) ? focusId : undefined}>
              {item.messages.map(message => <div key={message.id} className="v2-work-step-enter">
                <div className="v2-work-step-content">{renderMessage(message)}</div>
              </div>)}
            </ChatWork>;
          }} />
        </ChatImagePreloads.Provider>
        {viewport.laterCount > 0 && <button onClick={viewport.showLater}>{t("chat.showLater", { count: viewport.laterCount })}</button>}
      </div>
    </div>
    <footer className="v2-dock chat-column-dock">{(viewport.showJumpToLatest || viewport.laterCount > 0) && <JumpToLatestButton className="v2-jump-to-latest bottom-full mb-2" onClick={viewport.jumpToLatest} />}
      <LiveCallBar bot={bot} />
      <ChatV2Presence bot={bot} stopping={stopping} />
      {writable ? <Composer bot={profile} chatHistory={historyPage.history} smoothHeight onSendFrom={(sendId, input) => {
        if (!reducedMotion()) sendOrigin.current = { sendId, bounds: input.getBoundingClientRect() };
      }} locked={Boolean(bot.switchingTo)} replyTo={draft.replyTo} onClearReply={draft.clearReply} onRestoreReply={draft.restoreReply} onConsumeReply={draft.consumeReply}
        onEditLast={lastTyped && !bot.busy && canEditTypedMessage(lastTyped) ? () => setEditing(lastTyped) : undefined} /> :
        <NewConversationInstead bot={bot} onNew={() => dispatch({ type: "newTask", botId: bot.id })} />}
    </footer>
  </main>;
}
