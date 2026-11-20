import { memo, useEffect, useMemo, useState } from "react";
import { formattedReplyWidth, isFormattedReply, splitReplyBlocks } from "@/lib/formatted-reply";
import { intlLocale, t } from "@/lib/i18n";
import { useReactor } from "@/lib/cloud-guest";
import { otherSpeaker } from "@/lib/own-profile";
import { sameDrawnBots } from "@/lib/drawn-bots";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useSpeech } from "@/lib/tts/useSpeech";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { highlightCitationSource } from "@/lib/citations-dom";
import { cn } from "@/lib/cn";
import { formatTime, type Bot, type Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useStoreRef } from "@/state/store-ref";
import { isLiveReply, streamedReply, useLiveRow } from "@/state/live-reply";
import { useTeammates } from "@/state/team-people";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { ThreadRefText } from "./ThreadRefs";
import { BugReportNote } from "./BugReportNote";
import { ChatMarkdown } from "./ChatMarkdown";
import { MessageBoundary } from "./ChatView";
import { SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT, SIMPLE_USER_BUBBLE } from "./chat-bubble";
import { ReplyBlocks } from "./ReplyBlocks";
import { CopyButton, MESSAGE_ROW, MessageActions, messageActionClass, ReplyAction } from "./MessageActions";
import { ReactAction, ReactionChips } from "./Reactions";
import { replyAndCopy, roomPin, useBotMessageMenu, userMessageMenu } from "./message-menu";
import { forkMessageItem, ForkLinks } from "./ForkMessage";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { SpeakButton, speakReady } from "./SpeakButton";
import { SentCitations } from "./CitationUI";
import { ReplyQuote } from "./ReplyQuote";
import { AttachmentGallery, MessageAttachmentGallery, replyAttachmentGroup } from "./AttachmentGallery";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { UserLineNote } from "./RichMessageRow";
import { RoutedByLine } from "./RoomQueueList";

const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

interface RoomTextMessageProps {
  groupId: string;
  threadId: string;
  dm: boolean;
  pinned: boolean;
  /** The room's conversation is working. */
  working: boolean;
  message: Message;
  members: Bot[];
  replyTarget?: Message;
  emerging: boolean;
  eager: boolean;
  onReply: (message: Message) => void;
  canReact: boolean;
  phone: boolean;
  /** Drawn again in a new language. */
  locale: string;
  localVoice: boolean;
}

/** Members are drawn by name and look, and spoken in their voice. */
const sameMembers = (a: readonly Bot[], b: readonly Bot[]) => a === b || (sameDrawnBots(a, b) && a.every((bot, index) => bot.voice === b[index]!.voice));

function sameRow(previous: RoomTextMessageProps, next: RoomTextMessageProps): boolean {
  const keys = Object.keys(next) as (keyof RoomTextMessageProps)[];
  return keys.length === Object.keys(previous).length && keys.every((key) => key === "members" ? sameMembers(previous.members, next.members) : Object.is(previous[key], next[key]));
}

/** One text message in a room: drawn again only when its own props or the store slices it shows change, or, while it
 * streams, its words. */
export const RoomTextMessage = memo(function RoomTextMessage({
  groupId,
  threadId,
  dm,
  pinned,
  working,
  message: row,
  members,
  replyTarget,
  emerging,
  eager,
  onReply,
  canReact,
  phone,
  localVoice,
}: RoomTextMessageProps) {
  const m = useLiveRow(threadId, row);
  const dispatch = useStoreDispatch(), store = useStoreRef();
  const focusNonce = useStoreSelector((state) => {
    const focus = state.focusMessage;
    return focus?.messageId === m.id && focus.matchText && focus.threadId === threadId ? focus.nonce : null;
  });
  const tts = useStoreSelector((state) => state.config?.tts);
  const profileName = useStoreSelector((state) => state.config?.profile?.name);
  const mentionPerson = useMemo(() => ({ profileName }), [profileName]);
  const user = m.role === "user";
  const reactor = useReactor();
  const speaker = otherSpeaker(m, reactor !== "user" ? reactor : null);
  const rawText = user ? (m.text ?? "") : stripLeakedSystemHarnessMessages(m.text ?? "");
  const cited = user && m.text ? splitTranscriptCitations(m.text) : null;
  const attachments = user && m.text ? splitTranscriptAttachments(cited?.display ?? m.text) : null;
  const display = attachments?.display ?? rawText;
  const [expanded, setExpanded] = useState(false);
  const [viewRaw, setViewRaw] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === m.id && speech.status !== "idle";
  const focusedSearch = focusNonce !== null;
  const collapsible = user && !expanded && (display.length > USER_COLLAPSE_CHARS || display.split("\n").length > USER_COLLAPSE_LINES);
  useEffect(() => { if (focusedSearch && collapsible) setExpanded(true); }, [focusedSearch, collapsible, focusNonce]);
  const simple = !useAdvancedMode();
  const speakerBot = members.find((member) => member.id === m.from?.botId);
  const botText = rawText; const teammates = useTeammates(); const peers = useMemo(() => [...members, ...teammates.peers], [members, teammates]);
  const pin = roomPin({ id: groupId, pinnedMessageId: pinned ? m.id : undefined }, m, dispatch);
  const forkAction = !phone && !dm && m.kind === "text" && !m.id.startsWith("optimistic-")
    ? [forkMessageItem({ kind: "group", ownerId: groupId, threadId, messageId: m.id }, dispatch, working)] : [];
  const botMenu = useBotMessageMenu({
    text: botText,
    botId: speakerBot?.id,
    messageId: m.id,
    voiceId: speakerBot?.voice,
    tts,
    localVoice,
    canSpeak: true,
    viewRaw,
    onToggleRaw: () => setViewRaw((raw) => !raw),
    pin,
  });
  const replyGroup = useMemo(() => !user && !isLiveReply(m) && botText.trim() ? replyAttachmentGroup(botText, m.attachments) : null, [user, m, botText]);
  const blocks = useMemo(() => simple && !user && !viewRaw && botText.trim() ? splitReplyBlocks(botText) : null, [simple, user, viewRaw, botText]);
  const tabled = Boolean(blocks?.some((block) => block.kind === "table"));
  const botActions = !user && (
    <MessageActions side="bot" forceOpen={viewRaw || speaking} menu={[...botMenu, ...forkAction]} contextItems={replyAndCopy(() => onReply(m), botText)}>
      <ReplyAction onReply={() => onReply(m)} />
      {canReact && m.from && <ReactAction threadId={threadId} message={m} />}
      {botText && <CopyButton text={botText} className={messageActionClass} />}
      {botText && viewRaw && <RawToggleAction active onToggle={() => setViewRaw(false)} className={messageActionClass} />}
      {botText && (speaking || speakReady(tts, speakerBot?.voice, localVoice)) && <SpeakButton text={botText} botId={speakerBot?.id} messageId={m.id} voiceId={speakerBot?.voice} tts={tts} localVoice={localVoice} className={cn(messageActionClass, speaking && "text-accent")} />}
    </MessageActions>
  );
  return (
    <div {...{ [MESSAGE_ROW]: "" }} data-look={user ? "message-user" : "message-bot"} className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
      {speaker && <div className="mb-0.5 px-1 text-right text-[13px] [overflow-wrap:anywhere] font-semibold text-ink-secondary">{speaker}</div>}
      <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user" menu={[...userMessageMenu({ messageId: m.id, pin }), ...forkAction]} contextItems={replyAndCopy(() => onReply(m), display)}>
            <ReplyAction onReply={() => onReply(m)} />
            {Boolean(display.trim()) && <CopyButton text={display} className={messageActionClass} />}
          </MessageActions>
        )}
        <div
          data-chat-bubble={simple ? "simple" : ""} data-look={user ? "user-bubble" : "bot-bubble"}
          className={cn(
            tabled ? "w-full" : "w-fit",
            simple ? cn(!tabled && SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT) : "max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl text-[15px] leading-relaxed",
            !user && emerging && !streamedReply(m.id) && "turn-answer",
            tabled || (!user && !m.text?.trim() && !m.replyToId && m.attachments?.length)
              ? "text-ink"
              : !simple && !user && isFormattedReply(m.text ?? "")
                ? cn(formattedReplyWidth(m.text ?? ""), "px-1 text-ink")
                : user
                  ? cn("chat-text whitespace-pre-wrap [overflow-wrap:anywhere] text-ink", simple ? SIMPLE_USER_BUBBLE : "bg-bubble-user px-4 py-2.5")
                  : simple ? SIMPLE_BOT_BUBBLE : "bg-card px-4 py-2.5 text-ink",
          )}
          title={new Date(m.at).toLocaleString(intlLocale())}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={t("room.fallbackBot")}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user ? (
            <>
              {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId, messageId: m.id }} eager={eager} className={!attachments.display ? "mb-0" : undefined} />}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                data-citation-source={m.id}
                data-citation-owner-type="group"
                data-citation-owner={groupId}
                data-citation-thread={threadId}
              >
                <ThreadRefText text={display} peers={peers} everyone={!dm} />
              </div>{m.bugReport ? <BugReportNote report={m.bugReport} /> : m.pointed?.length ? <UserLineNote message={m} /> : null}
              {cited && <SentCitations
                citations={cited.citations}
                onNavigate={async (citation: CitationAttachment) => {
                  const messages = store.state().groups.find((room) => room.id === groupId)?.messages ?? [];
                  if (citation.source.ownerType !== "group" || !messages.some((candidate) => candidate.id === citation.source.messageId)) return false;
                  dispatch({ type: "focusMessage", threadId, messageId: citation.source.messageId });
                  return highlightCitationSource(citation);
                }}
              />}
              {m.via === "api" && (
                <div className="mt-1 text-[12px] leading-4 text-ink-secondary">{t("room.viaApi")}</div>
              )}
              {collapsible && (
                <button type="button" onClick={() => setExpanded(true)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button type="button" onClick={() => setExpanded(false)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary key={viewRaw ? "raw" : "rendered"} fallbackText={botText || t("chat.generatedImage")}>
              {(m.attachments ?? []).some((attachment) => attachment.kind === "audio") && (
                <div className={cn("flex flex-col", (m.text || (m.attachments ?? []).some((attachment) => attachment.kind === "image")) && "mb-2")}>
                  {m.attachments!.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio").map((note) => (
                    <VoiceNoteBubble key={note.path} attachment={note} />
                  ))}
                </div>
              )}
              {!botText.trim() && <MessageAttachmentGallery text={botText} attachments={m.attachments} message={{ threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={eager} />}
              {viewRaw && botText ? (
                <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={groupId} data-citation-thread={threadId}><RawMarkdownView text={botText} /></div>
              ) : tabled && blocks ? (
                <ReplyBlocks blocks={blocks} tray={botActions} citation={{ messageId: m.id, ownerType: "group", ownerId: groupId, threadId }}
                  render={(block) => <ChatMarkdown text={block} mentionPeers={peers} everyone={!dm} mentionPerson={mentionPerson} message={{ threadId, messageId: m.id }} delivered={replyGroup?.delivered} originals={replyGroup?.originals} />} />
              ) : botText ? (
                <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={groupId} data-citation-thread={threadId}><ChatMarkdown text={botText} mentionPeers={peers} everyone={!dm} mentionPerson={mentionPerson} message={{ threadId, messageId: m.id }} delivered={replyGroup?.delivered} originals={replyGroup?.originals} /></div>
              ) : null}
              {replyGroup && <AttachmentGallery images={replyGroup.images} files={replyGroup.files} originals={replyGroup.originals} message={{ threadId, messageId: m.id }} eager={eager} beneath />}
            </MessageBoundary>
          )}
        </div>
        {!tabled && botActions}
        <span className="self-end pb-1 text-[12px] font-medium leading-4 tabular-nums whitespace-nowrap text-ink-tertiary opacity-0 transition-opacity group-hover:opacity-100">
          {formatTime(m.at)}
        </span>
      </div>
      <ReactionChips threadId={threadId} message={m} bots={members} align={user ? "end" : "start"} canReact={canReact} />
      <ForkLinks kind="group" ownerId={groupId} threadId={threadId} messageId={m.id} phone={phone} />
      {!user && m.routedBy && <RoutedByLine routedBy={m.routedBy} />}
    </div>
  );
}, sameRow);
