import { memo, useMemo, useState } from "react";
import { ArrowDown, Loader2, Monitor, Reply } from "lucide-react";
import { currentTaskBot, type Bot, type Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useChatHistory } from "@/state/use-chat-history";
import { useLiveTranscript } from "@/state/live-reply";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { useCanWriteIn } from "@/lib/cloud-guest";
import { useReplyDraft } from "@/lib/drafts";
import { botLineText, canEditTypedMessage, localDay } from "@/lib/transcript-derivations";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { lastNonReceipt } from "@/lib/receipts";
import { t } from "@/lib/i18n";
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
import { MessageAttachmentGallery } from "../AttachmentGallery";
import { VoiceNoteBubble } from "../VoiceNoteBubble";
import { ScreenFrame } from "../ScreenFrame";
import { optionsCardRow } from "../OptionsCardRow";
import { RichMessageRow, richRowKind } from "../RichMessageRow";
import { ToolActivity } from "../ToolActivity";
import { SignInRequestCard } from "../SignInRequestCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { ConnectorCard } from "../ConnectorCard";
import { DigestChip, CompactionChip } from "../DigestChip";
import { RoutineRunRow } from "../RoutineRunCard";
import { CallRecordRow } from "../CallRecordRow";
import { NewConversationInstead } from "../NewConversationInstead";
import { ChatErrorBanner } from "../ChatErrorBanner";
import { NewMessagesDivider } from "../NewMessagesDivider";
import { LiveCallBar } from "../LiveCallBar";
import { CallOverlay } from "../CallView";
import { FailedTurnRow } from "../ChatView";
import { useSharedRun } from "../SharedQueueLine";
import { SetupOffer } from "../SetupOffer";
import { ReplyQuote } from "../ReplyQuote";

const EMPTY_TRANSCRIPT: Message[] = [];

const Row = memo(function Row({ message: m, botId, botName, color, threadId, busy, hasMore, transcript, reply, failure, quoted, jumpTo, canLoadQuote, loadingQuote }: {
  message: Message; botId: string; botName: string; color: Bot["color"]; threadId: string;
  failure?: React.ReactNode;
  quoted?: Message;
  jumpTo: (messageId: string, loaded: boolean) => void;
  canLoadQuote: boolean;
  loadingQuote: boolean;
  busy: boolean; hasMore: boolean; transcript: Message[]; reply?: (message: Message) => void;
}) {
  const props = { botId, botName, color, threadId, message: m };
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
    case "digest": return <DigestChip message={m} />;
    case "activity": return failure ?? (m.tool && <div className="v2-step"><ToolActivity tool={m.tool} live={Boolean(busy && m.tool.ok === undefined)} source={{ threadId: threadId, messageId: m.id }} />{m.comm && m.tool.output && <p>{m.tool.output}</p>}</div>);
  }
  const peer = peerLine(m) ?? peerRequest(m, botId);
  const own = m.role === "user" && !peer;
  const text = peer?.body ?? (own ? m.text : stripLeakedSystemHarnessMessages(botLineText(m))) ?? "";
  if (!text && !m.attachments?.length) return null;
  return <article className="v2-message" data-own={own || undefined}>
    {peer && <b className="text-xs text-ink-secondary">{peer.name}</b>}
    <div className="v2-body" dir="auto">
      {quoted ? <div className="mb-2">
        <ReplyQuote message={quoted} fallbackName={botName} compact onJump={() => jumpTo(quoted.id, true)} inverse={own} />
      </div> : m.replyToId && <UnloadedReplyQuote key={m.replyToId} threadId={threadId} messageId={m.replyToId}
        botName={botName} inverse={own} canJump={canLoadQuote} pending={loadingQuote} onJump={() => jumpTo(m.replyToId!, false)} />}
      <MessageAttachmentGallery text={text} attachments={m.attachments} message={{ threadId: threadId, messageId: m.id }} />
      {m.attachments?.map(a => a.kind === "audio" && <VoiceNoteBubble key={a.path} attachment={a} />)}
      <ChatMarkdown text={text} message={{ threadId: threadId, messageId: m.id }} />
    </div>
    {m.setupOffer && <SetupOffer {...props} transcript={transcript} />}
    {reply && <button className="v2-reply" aria-label={t("chat.reply")} onClick={() => reply(m)}><Reply size={14} /></button>}
  </article>;
});

export function ChatV2({ profile, onClose }: { profile: Bot; onClose: () => void }) {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const dispatch = useStoreDispatch();
  const writable = useCanWriteIn(bot.threadId, bot.yourAccess) !== false;
  const error = useStoreSelector(s => s.error);
  const focused = useStoreSelector(s => s.focusMessage);
  const historyPage = useChatHistory(bot);
  const { history } = historyPage;
  const messageById = useMemo(() => new Map(history.map(message => [message.id, message])), [history]);
  const viewport = useTranscriptViewport({ ownerId: bot.id, threadId: bot.threadId, messages: history,
    hasMore: historyPage.hasMore, historyPage, rests: staysInView, pinOn: [bot.busy] });
  const messages = useLiveTranscript(bot.threadId, viewport.windowedMessages, history);
  const unread = useUnreadDivider({ threadId: bot.threadId, messages: history, following: viewport.following });
  const items = useMemo(() => messages.map(message => ({ kind: "message" as const, message })), [messages]);
  const draft = useReplyDraft(bot.threadId, `bot:${bot.id}:${bot.threadId}`, history);
  const engine = useStoreSelector(s => botEngine(bot, s.instances));
  const sharedRun = useSharedRun(bot);
  const lastUser = history.findLast(m => m.role === "user" && m.kind === "text"
    && !peerLine(m) && !m.text?.startsWith(RETRY_LEAD));
  const retryable = lastNonReceipt(history)?.id;
  const retry = lastUser?.text && !lastUser.id.startsWith("optimistic-") && !bot.busy && writable && sharedRun.mayAct(lastUser.sender)
    ? () => dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUser.id, text: lastUser.text! })
    : undefined;
  const [editing, setEditing] = useState<Message | null>(null);
  const lastTyped = history.findLast(m => m.role === "user" && m.kind === "text" && !peerLine(m) && !m.reaction);
  return <main data-chat-v2 className="v2-page">
    <CallOverlay bot={bot} transcript={history} />
    <header className="v2-header">
      <div className="v2-identity"><BotAvatar bot={bot} size={28} /><strong>{bot.name}</strong></div>
      <div className="v2-controls"><ModelPicker bot={bot} threadId={bot.threadId} />
        <button aria-label={t("chat.botScreen")} onClick={() => dispatch({ type: "toggleComputer" })}><Monitor size={16} /></button>
        <button aria-pressed="true" onClick={onClose}>Chat V2</button></div>
    </header>
    <ChatErrorBanner message={error} onDismiss={() => dispatch({ type: "error", message: null })} />
    <div className="v2-scroll" ref={viewport.scrollRef} {...viewport.scrollHandlers}>
      <div ref={viewport.transcriptRef} className="v2-paper" role="log" aria-label={t("chat.conversationWith", { name: bot.name })}>
        {viewport.hasEarlier && <div ref={viewport.topSentinelRef} aria-hidden="true" className="h-px w-full" />}
        {(viewport.olderPending || bot.switchingTo || (bot.awaitingThreadSnapshot && !messages.length)) && (
          <div role="status" className="flex w-full justify-center py-1 text-ink-secondary">
            <Loader2 size={18} aria-hidden="true" className="motion-safe:animate-spin" />
            <span className="sr-only">{t("chat.loadingEarlier")}</span>
          </div>
        )}
        <ExchangeTimeline items={items} botId={bot.id} focusId={focused?.messageId ?? null} unreadId={unread.messageId}
          render={(item, i) => item.kind === "message" && <div key={item.message.id} data-mid={item.message.id}>
            {item.message.id === unread.messageId && <NewMessagesDivider fading={unread.fading} />}
            {(!i || localDay(messages[i - 1]!.at) !== localDay(item.message.at)) && <time className="v2-date">{new Date(item.message.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>}
            {editing?.id === item.message.id ? <form onSubmit={e => { e.preventDefault(); const text = String(new FormData(e.currentTarget).get("text") ?? "").trim(); if (text) { dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: editing.id, text }); setEditing(null); } }}>
              <input autoFocus name="text" defaultValue={editing.text} onKeyDown={e => { if (e.key === "Escape") setEditing(null); }} /></form> :
              <Row message={item.message} botId={bot.id} botName={bot.name} color={bot.color} threadId={bot.threadId}
                busy={Boolean(bot.busy)} hasMore={item.message.kind === "call" && historyPage.hasMore}
                failure={item.message.tool && failedTurnCause(item.message.tool.name) !== null
                  ? <FailedTurnRow tool={item.message.tool} engine={engine} botId={bot.id} threadId={bot.threadId}
                      messageAt={item.message.at} onRetry={item.message.id === retryable ? retry : undefined} />
                  : undefined}
                transcript={item.message.setupOffer || richRowKind(item.message) === "options" || item.message.kind === "call" ? history : EMPTY_TRANSCRIPT}
                quoted={item.message.replyToId ? messageById.get(item.message.replyToId) : undefined}
                jumpTo={historyPage.jumpTo} canLoadQuote={historyPage.hasMore} loadingQuote={Boolean(item.message.replyToId && historyPage.pending)}
                reply={writable ? draft.selectReply : undefined} />}
          </div>} />
        {viewport.laterCount > 0 && <button onClick={viewport.showLater}>{t("chat.showLater", { count: viewport.laterCount })}</button>}
        {bot.busy && <small role="status">{t("sidebar.preview.working")}</small>}
      </div>
    </div>
    <footer className="v2-dock">{(viewport.showJumpToLatest || viewport.laterCount > 0) && <button className="v2-jump" aria-label={t("chat.jumpToLatest")} onClick={viewport.jumpToLatest}><ArrowDown size={16} /></button>}
      <LiveCallBar bot={bot} />
      {writable ? <Composer bot={profile} locked={Boolean(bot.switchingTo)} replyTo={draft.replyTo} onClearReply={draft.clearReply} onRestoreReply={draft.restoreReply} onConsumeReply={draft.consumeReply}
        onEditLast={lastTyped && !bot.busy && canEditTypedMessage(lastTyped) ? () => setEditing(lastTyped) : undefined} /> :
        <NewConversationInstead bot={bot} onNew={() => dispatch({ type: "newTask", botId: bot.id })} />}
    </footer>
  </main>;
}
