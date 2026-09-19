import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MessageSquareReply, Pencil, Pin, PinOff, RefreshCw, Webhook } from "lucide-react";
import { MessageActions, messageActionClass } from "@/components/MessageActions";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useStore, formatTime, messageVersions, type Bot, type Message } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { normalizeState } from "@/lib/mascot";
import { peerLine, type PeerLine } from "@/lib/peer-message";
import { ChatMarkdown } from "../ChatMarkdown";
import { RawMarkdownView, RawToggleAction } from "../RawMarkdownToggle";
import { ThreadRefText } from "../ThreadRefs";
import { ReplyQuote } from "../ReplyQuote";
import { AttachmentGallery, collectMessageFiles } from "../AttachmentGallery";
import { SpeakButton } from "../SpeakButton";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { BubbleEditor } from "./bubble-editor";
import { CopyButton } from "./copy-button";
import { MessageBoundary } from "./message-boundary";
/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

export function Bubble({
  bot,
  message,
  emerging = false,
  eagerAttachments = false,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
}: {
  bot: Bot;
  message: Message;
  emerging?: boolean;
  eagerAttachments?: boolean;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: () => void;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // A user-role line another bot delivered (ask_bot, delegate_bot,
  // start_thread) is that bot speaking, not the person: it takes the
  // bot side of the chat under the peer's name, with the model-facing
  // provenance note stripped from what the reader sees.
  const peer = peerLine(message);
  const user = message.role === "user" && !peer;
  const mentionPeers = useMemo(() => state.bots.filter((peer) => peer.id !== bot.id), [state.bots, bot.id]);
  const [expanded, setExpanded] = useState(false);
  const [viewRaw, setViewRaw] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === message.id && speech.status !== "idle";
  const text = peer ? peer.body : (message.text ?? "");
  const generatedPaths = useMemo(() => message.attachments?.map((attachment) => attachment.path) ?? [], [message.attachments]);
  const linkedFiles = useMemo(() => user ? [] : collectMessageFiles(text, generatedPaths), [user, text, generatedPaths]);
  const webhookView = user ? webhookMessageView(text) : null;
  const attachments = user && !webhookView ? splitTranscriptAttachments(text) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const hasAttachments = Boolean(attachments && (attachments.images.length || attachments.files.length));
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing && !webhookView && !hasAttachments) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, threadId: bot.threadId, messageId: v.id });
  };

  return (
    <div className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      {peer && <PeerLabel peer={peer} />}
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user">
            {/* editing rewinds the thread, so it waits for the turn to end —
                same rule as the version switcher below */}
            {message.kind === "text" && !webhookView && !hasAttachments && !bot.busy && (
              <button
                onClick={onStartEdit}
                aria-label={t("chat.editMessage")}
                title={t("chat.editMessage")}
                className={messageActionClass}
              >
                <Pencil size={14} />
              </button>
            )}
            {Boolean(visibleText.trim()) && <CopyButton text={visibleText} className="opacity-100" />}
            <button
              type="button"
              onClick={onReply}
              aria-label={t("chat.replyToMessage")}
              title={t("chat.reply")}
              className={messageActionClass}
            >
              <MessageSquareReply size={14} />
            </button>
            <button
              onClick={() =>
                dispatch({
                  type: "updateTask",
                  botId: bot.id,
                  threadId: bot.threadId,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }
              aria-label={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
              title={bot.pinnedMessageId === message.id ? t("chat.unpinHint") : t("chat.pinHint")}
              className={cn(messageActionClass, remoteClient && "hidden")}
            >
              {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </MessageActions>
        )}
        <div
          className={cn(
            "w-fit max-w-[min(42rem,78%)] rounded-2xl text-[15px] leading-relaxed",
            emerging && "turn-answer",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : "bg-card px-4 py-2.5 text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={bot.name}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>{t("chat.webhookTask")}</span>
              </div>
              <div className="chat-text px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">{t("chat.viewPayload")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId: bot.threadId, messageId: message.id }} eager={eagerAttachments} className={!visibleText ? "mb-0" : undefined} />}
              {visibleText && (
                <div
                  className={cn("chat-text", collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                >
                  <ThreadRefText text={visibleText} peers={mentionPeers} />
                </div>
              )}
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title={t("chat.sentMidTurnHint")}>
                  {t("chat.sentMidTurn")}
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary key={viewRaw ? "raw" : "rendered"} fallbackText={text || t("chat.generatedImage")}>
              <AttachmentGallery images={generatedPaths} files={linkedFiles} message={{ threadId: bot.threadId, messageId: message.id }} className={text ? undefined : "mb-0"} eager={eagerAttachments} />
              {viewRaw && text ? (
                <RawMarkdownView text={text} />
              ) : text ? (
                <ChatMarkdown text={text} mentionPeers={mentionPeers} message={{ threadId: bot.threadId, messageId: message.id }} />
              ) : null}
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <MessageActions side="bot" forceOpen={viewRaw || speaking}>
            {text && <CopyButton text={text} className="opacity-100" />}
            {text && <RawToggleAction active={viewRaw} onToggle={() => setViewRaw((r) => !r)} className="opacity-100" />}
            {message.kind === "text" && text && !peer && (
              <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} className="opacity-100" />
            )}
            {isLastBotText && !bot.busy && onRegenerate && (
              <button
                onClick={onRegenerate}
                aria-label={t("chat.regenerate")}
                title={t("chat.regenerate")}
                className={messageActionClass}
              >
                <RefreshCw size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onReply}
              aria-label={t("chat.replyToMessage")}
              title={t("chat.reply")}
              className={messageActionClass}
            >
              <MessageSquareReply size={14} />
            </button>
            <button
              onClick={() =>
                dispatch({
                  type: "updateTask",
                  botId: bot.id,
                  threadId: bot.threadId,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }
              aria-label={bot.pinnedMessageId === message.id ? t("chat.unpinMessage") : t("chat.pinMessage")}
              title={bot.pinnedMessageId === message.id ? t("chat.unpinHint") : t("chat.pinHint")}
              className={cn(messageActionClass, remoteClient && "hidden")}
            >
              {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </MessageActions>
        )}
        <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100",
            user ? "order-first mr-1" : "ml-1",
          )}
        >
          {formatTime(message.at)}
        </span>
      </div>
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.previousVersion")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.nextVersion")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}


/** Who wrote a relayed line and how it arrived, above the bubble — the
 * same shape as a room's cluster label. Looked up by id, then by name for
 * rows that predate Message.peerAsk; a peer since renamed or deleted still
 * shows the name the line carries. */
function PeerLabel({ peer }: { peer: PeerLine }) {
  const { state } = useStore();
  const author =
    state.bots.find((b) => b.id === peer.botId) ?? state.bots.find((b) => b.name === peer.name);
  const how =
    peer.delivery === "delegate_bot"
      ? t("chat.peer.delegated")
      : peer.delivery === "start_thread"
        ? t("chat.peer.openedThread")
        : t("chat.peer.asked");
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-testid="peer-label">
      <BotAvatar
        bot={author ?? { name: peer.name, color: "blue" }}
        state={normalizeState(author?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{peer.name}</span>
      <span className="text-[11px] text-ink-secondary/70">· {how}</span>
    </div>
  );
}
