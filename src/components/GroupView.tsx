// A room: several bots + you in one shared thread. The sidebar and call view
// carry the personality; avatars inside the room stay still so a busy group
// does not become a wall of competing motion. Plain messages go to the room's
// default responder; @mentions override that routing.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { ArrowDown, Check, ChevronDown, ChevronRight, Folder, FolderOpen, Loader2, Pin, Plus, Search, X } from "lucide-react";
import {
  api,
  useStore,
  formatTime,
  openNotificationTarget,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";
import { BotAvatar } from "./Avatar";
import { PlaceIcon } from "./PlaceIcon";
import { ScreenFrame } from "./ScreenFrame";
import { effectivePlace, placeLabelKey } from "@/lib/place";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { CompactionChip, DigestChip } from "./DigestChip";
import { roomActivityVisible } from "@/lib/room-activity";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { normalizeState } from "@/lib/mascot";
import { defaultResponderName, effectiveDefaultResponder, groupResponseHint, jevRoomRoutingOn } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyButton, FailedTurnRow, MessageBoundary, ReplyAction } from "./ChatView";
import { MESSAGE_ROW, MessageActions, messageActionClass } from "./MessageActions";
import { useBotMessageMenu, userMessageMenu, type PinAction } from "./message-menu";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { SpeakButton } from "./SpeakButton";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { CancelledTurnRow } from "./CancelledTurnRow";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { roomRetryRequest } from "@/lib/room-retry";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { CitationSelectionToolbar, SentCitations } from "./CitationUI";
import { Composer } from "./Composer";
import { ChatErrorBanner } from "./ChatErrorBanner";
import { ChatFindBar } from "./ChatFindBar";
import { ConversationTurnLimit } from "./ConversationTurnLimit";
import { GroupTaskPicker } from "./TaskPicker";
import { GroupUsageChip } from "./GroupUsageChip";
import { isPureLeakedSystemHarnessMessage, stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { ExportTranscriptMenu } from "./ExportTranscriptMenu";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { GoalRunCard } from "./GoalRunCard";
import { AttachmentGallery, MessageAttachmentGallery, replyAttachmentGroup } from "./AttachmentGallery";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { OptionCard } from "./OptionCard";
import { GroupCallButton, GroupCallOverlay } from "./GroupCallView";

import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { groupActivityRuns, isStatusActivity } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { useDesktopCapabilities, useCaptionChrome } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { shortPath } from "@/lib/short-path";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { awaitedMemberId, showWorkingDots } from "@/lib/turn-tail";
import { liveActivityPhrases } from "@/lib/live-activity";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { unreadMessageIds } from "@/lib/unread-divider";
import { NewMessagesDivider } from "./NewMessagesDivider";
import { appendDraftAttachments, useReplyDraft } from "@/lib/drafts";
import { citationPreviewText, splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { highlightCitationSource } from "@/lib/citations-dom";
import { latestFailure, latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { pendingApprovals } from "./PendingApproval";
import { DataResultChip } from "./DataResultChip";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { dayLabel, localDay } from "@/lib/transcript-derivations";

/** One finished tool step in a room. Same pill the 1:1 chat uses, minus the
 * status glyph — a room reads as a conversation, not a build log. A chip
 * that links somewhere ("Posted in #Standup", a bot⇄bot exchange) opens it,
 * as it would in a 1:1 — a receipt the person cannot follow is only half a
 * receipt. When the linked channel IS this room (an ask made from here is
 * mirrored back into it) there is nowhere to go, so it stays a plain,
 * visible pill. A member's failed turn is not a step at all: it is the row a
 * 1:1 chat shows for the same failure, sign-in card and all, for the engine
 * that member ran on. */
export function RoomToolChip({ message, roomId }: { message: Message; roomId?: string }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(state.bots.find((b) => b.id === message.from?.botId), state.instances)} botId={message.from?.botId} />;
  }
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    const withBot = state.bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "select", id: comm.groupId });
            const destination = state.groups.find(g => g.id === comm.groupId);
            if (comm.threadId && destination?.tasks?.some(task => task.threadId === comm.threadId)) {
              dispatch({ type: "switchGroupTask", groupId: comm.groupId, threadId: comm.threadId });
            }
          }}
          title={t("room.openBot", { name: comm.withName })}
          className="ui-pill"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  if (!comm) return <ToolActivity tool={tool} />;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "ui-pill",
          tool.ok === false && "text-danger",
        )}
      >
        {comm && <BotAvatar bot={state.bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
}

/** 16px profile avatar + name, shown once per sender cluster. */
function ClusterLabel({ bot, name, color }: { bot?: Bot; name: string; color: string }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <BotAvatar
        bot={bot ?? { name, color: color as Bot["color"] }}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{name}</span>
    </div>
  );
}

/** Pin for one room message, one pin per room, patchGroup path. */
function roomPin(group: Group, message: Message, dispatch: ReturnType<typeof useStore>["dispatch"]): PinAction | undefined {
  if (window.ogb?.remoteClient?.active) return undefined;
  const pinned = group.pinnedMessageId === message.id;
  return {
    pinned,
    hint: t("room.pinHint"),
    onToggle: () => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: pinned ? "" : message.id } }),
  };
}

/** Same limits as a 1:1 user bubble (ChatView). */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** One room text message: the same actions as a 1:1 bubble, and a boundary
 * so a bad markdown node stays inside this row. */
function RoomTextMessage({
  group,
  message: m,
  members,
  transcript,
  emerging,
  eager,
  onReply,
}: {
  group: Group;
  message: Message;
  members: Bot[];
  transcript: Message[];
  emerging: boolean;
  eager: boolean;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const user = m.role === "user";
  const rawText = user ? (m.text ?? "") : stripLeakedSystemHarnessMessages(m.text ?? "");
  const cited = user && m.text ? splitTranscriptCitations(m.text) : null;
  const attachments = user && m.text ? splitTranscriptAttachments(cited?.display ?? m.text) : null;
  const display = attachments?.display ?? rawText;
  const [expanded, setExpanded] = useState(false);
  const [viewRaw, setViewRaw] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === m.id && speech.status !== "idle";
  const focus = state.focusMessage;
  const focusedSearch = focus?.messageId === m.id && Boolean(focus.matchText) && focus.threadId === group.threadId;
  const collapsible = user && !expanded && (display.length > USER_COLLAPSE_CHARS || display.split("\n").length > USER_COLLAPSE_LINES);
  useEffect(() => {
    if (focusedSearch && collapsible) setExpanded(true);
  }, [focusedSearch, collapsible, focus?.nonce]);
  const speakerBot = members.find((member) => member.id === m.from?.botId);
  const botText = rawText;
  const pin = roomPin(group, m, dispatch);
  const botMenu = useBotMessageMenu({
    text: botText,
    botId: speakerBot?.id,
    messageId: m.id,
    voiceId: speakerBot?.voice,
    tts: state.config?.tts,
    localVoice: localSystemVoiceActive(),
    canSpeak: true,
    viewRaw,
    onToggleRaw: () => setViewRaw((raw) => !raw),
    pin,
  });
  // a reply with text lists its files under the text, without the ones it links inline
  const replyGroup = useMemo(() => !user && botText.trim() ? replyAttachmentGroup(botText, m.attachments) : null, [user, botText, m.attachments]);
  return (
    <div {...{ [MESSAGE_ROW]: "" }} className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
      <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user" menu={userMessageMenu({ messageId: m.id, pin })}>
            <ReplyAction onReply={() => onReply(m)} />
            {Boolean(display.trim()) && <CopyButton text={display} className={messageActionClass} />}
          </MessageActions>
        )}
        <div
          data-chat-bubble
          className={cn(
            "w-fit max-w-[min(42rem,78%)] rounded-2xl text-[15px] leading-relaxed",
            !user && emerging && "turn-answer",
            !user && !m.text?.trim() && !m.replyToId && m.attachments?.length
              ? "text-ink"
              : user ? "chat-text whitespace-pre-wrap bg-bubble-user px-4 py-2.5 text-ink" : "bg-card px-4 py-2.5 text-ink",
          )}
          title={new Date(m.at).toLocaleString()}
        >
          {m.replyToId && (() => {
            const target = transcript.find((candidate) => candidate.id === m.replyToId);
            return target ? (
              <div className="mb-2">
                <ReplyQuote
                  message={target}
                  fallbackName={t("room.fallbackBot")}
                  compact
                  onJump={() =>
                    dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })
                  }
                />
              </div>
            ) : null;
          })()}
          {user ? (
            <>
              {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId: group.threadId, messageId: m.id }} eager={eager} className={!attachments.display ? "mb-0" : undefined} />}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                data-citation-source={m.id}
                data-citation-owner-type="group"
                data-citation-owner={group.id}
                data-citation-thread={group.threadId}
              >
                <ThreadRefText text={display} peers={members} everyone={!group.dm} />
              </div>
              {cited && <SentCitations
                citations={cited.citations}
                onNavigate={async (citation: CitationAttachment) => {
                  if (citation.source.ownerType !== "group" || !group.messages.some((candidate) => candidate.id === citation.source.messageId)) return false;
                  dispatch({ type: "focusMessage", threadId: group.threadId, messageId: citation.source.messageId });
                  return highlightCitationSource(citation);
                }}
              />}
              {m.via === "api" && (
                <div className="mt-1 text-[11px] text-ink-secondary">Sent through the API, not typed here</div>
              )}
              {collapsible && (
                <button type="button" onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button type="button" onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
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
              {!botText.trim() && <MessageAttachmentGallery text={botText} attachments={m.attachments} message={{ threadId: group.threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={eager} />}
              {viewRaw && botText ? (
                <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={group.id} data-citation-thread={group.threadId}><RawMarkdownView text={botText} /></div>
              ) : botText ? (
                <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={group.id} data-citation-thread={group.threadId}><ChatMarkdown text={botText} mentionPeers={members} everyone={!group.dm} message={{ threadId: group.threadId, messageId: m.id }} delivered={replyGroup?.delivered} /></div>
              ) : null}
              {replyGroup && <AttachmentGallery images={replyGroup.images} files={replyGroup.files} message={{ threadId: group.threadId, messageId: m.id }} eager={eager} beneath />}
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <MessageActions side="bot" forceOpen={viewRaw || speaking} menu={botMenu}>
            <ReplyAction onReply={() => onReply(m)} />
            {botText && <CopyButton text={botText} className={messageActionClass} />}
            {botText && viewRaw && <RawToggleAction active onToggle={() => setViewRaw(false)} className={messageActionClass} />}
            {botText && speaking && (
              <SpeakButton text={botText} botId={speakerBot?.id} messageId={m.id} voiceId={speakerBot?.voice} tts={state.config?.tts} localVoice={localSystemVoiceActive()} className={cn(messageActionClass, "text-accent")} />
            )}
          </MessageActions>
        )}
        <span className="self-end pb-1 text-[11px] tabular-nums text-ink-tertiary opacity-0 transition-opacity group-hover:opacity-100">
          {formatTime(m.at)}
        </span>
      </div>
      {!user && m.routedBy && <RoutedByLine routedBy={m.routedBy} />}
    </div>
  );
}

export const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
  unreadDividerId = null,
  unreadDividerFading = false,
  onReply,
}: {
  group: Group;
  members: Bot[];
  /** Invalidate the memoized transcript when only the language changes. */
  locale: string;
  /** The windowed suffix of group.messages — the boundary lives in GroupView. */
  messages: Message[];
  /** Full room transcript, used to resolve quoted messages outside the mounted window. */
  transcript: Message[];
  emergingId?: string | null;
  /** The New divider goes above the row holding this message. */
  unreadDividerId?: string | null;
  unreadDividerFading?: boolean;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  // Several bots working at once turn a room into a wall of chips; fold the
  // finished ones the same way a 1:1 chat does.
  const items = useMemo(() => groupActivityRuns(messages.filter(message =>
    message.kind !== "activity" || roomActivityVisible(message, showToolCalls))), [messages, showToolCalls]);
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const roomBusy = Boolean(group.busyBotId || group.working);
  let retryableId: string | undefined;
  let retryableIndex = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const candidate = transcript[index];
    if (candidate && candidate.kind !== "digest" && candidate.kind !== "compaction") {
      retryableId = candidate.id;
      retryableIndex = index;
      break;
    }
  }
  // Only the newest row can retry, and it resends the request its own turn
  // answered, files included.
  const retryRequest = useMemo(() => {
    const newest = transcript[retryableIndex];
    return newest && isCancelledTranscriptRow(newest) ? roomRetryRequest(transcript, retryableIndex) : null;
  }, [transcript, retryableIndex]);
  const retryRoom = useCallback(() => {
    if (!retryRequest || roomBusy) return;
    dispatch({
      type: "sendGroup",
      groupId: group.id,
      text: retryRequest.text,
      threadId: group.threadId,
      mode: retryRequest.mode,
      ...(retryRequest.replyToId ? { replyToId: retryRequest.replyToId } : {}),
    });
  }, [dispatch, group.id, group.threadId, retryRequest, roomBusy]);
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  // The divider sits above the first drawn row from its message on; hidden
  // tool lines are not items here.
  const unreadIds = useMemo(() => unreadMessageIds(messages, unreadDividerId), [messages, unreadDividerId]);
  let dividerPlaced = false;
  const dividerAbove = (rows: readonly Message[]) => {
    if (!unreadIds || dividerPlaced || !rows.some((row) => unreadIds.has(row.id))) return null;
    dividerPlaced = true;
    return <NewMessagesDivider fading={unreadDividerFading} />;
  };
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || localDay(prev.at) !== localDay(first.at);
        const divider = dividerAbove(item.kind === "run" ? item.messages : [item.message]);
        if (item.kind === "run") {
          if (!showToolCalls) return divider && <div key={item.id} className="contents">{divider}</div>;
          const cluster = !prev || prev.role !== first.role || prev.from?.botId !== first.from?.botId || newDay;
          return (
            <div key={item.id} className="contents">
              {newDay && (
                <div className="py-3 text-center text-[13px] text-ink-secondary">
                  {dayLabel(first.at)} {formatTime(first.at)}
                </div>
              )}
              {divider}
              {first.from && cluster && (
                <ClusterLabel bot={memberOf(first.from.botId)} name={first.from.name} color={first.from.color} />
              )}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <RoomToolChip message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        const user = m.role === "user";
        const newCluster = !prev || prev.role !== m.role || prev.from?.botId !== m.from?.botId || Boolean(prev.comm) || newDay;
        const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const canRetryRoom = m.id === retryableId && retryRequest !== null && !roomBusy;
        const row = isCancelledTranscriptRow(m) ? (
          // Rooms have no edit fork, so Retry is the room's own send.
          <CancelledTurnRow onRetry={canRetryRoom ? retryRoom : undefined} />
        ) :
          // a member can hit a permission ask mid-turn; without this the
          // card never rendered here and the bot waited out its timeout.
          // `tool` distinguishes a permission from a QUESTION — a question
          // only accepts an "answer", so routing it to the approval box
          // would offer an Allow the broker rejects. A structured ask is
          // one of those questions, and answers in its own card.
          m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.requestId && m.card.questionRequest ? (
            <div className="flex justify-start">
              <MessageBoundary fallbackText={m.card.subtitle || m.card.title || ""}>
                <QuestionCard threadId={group.threadId} bot={memberOf(m.from?.botId)} message={m} />
              </MessageBoundary>
            </div>
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <MessageBoundary fallbackText={m.card.subtitle || m.card.title || ""}>
                <ApprovalCard bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} />
              </MessageBoundary>
            </div>
          ) : m.kind === "options" && m.card && m.from?.botId ? (
            // a QUESTION from a member. Without this branch the card fell
            // through to null: invisible on screen, and the asking bot sat
            // there until its 15-minute timeout answered for you
            <div className="flex justify-start">
              <MessageBoundary fallbackText={m.card.subtitle || m.card.title || ""}>
                <OptionCard botId={m.from.botId} threadId={group.threadId} groupId={group.id} message={m} />
              </MessageBoundary>
            </div>
          ) : m.kind === "goal.run" ? (
            <div className="flex justify-start">
              <GoalRunCard message={m} />
            </div>
          ) : m.kind === "routine.run" ? (
            <div className="flex justify-start">
              <RoutineRunCard
                message={m}
                onOpen={routineTarget
                  ? () => openNotificationTarget(dispatch, routineTarget, state)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            roomActivityVisible(m, showToolCalls) ? (
              m.dataResult ? <DataResultChip message={m} /> : isStatusActivity(m) ? <StatusActivityRow message={m} /> : <RoomToolChip message={m} roomId={group.id} />
            ) : null
          ) : m.kind === "screen" ? (
            <ScreenFrame threadId={group.threadId} message={m} />
          ) : m.kind === "compaction" ? (
            <CompactionChip message={m} />
          ) : m.kind === "digest" ? (
            showToolCalls ? <DigestChip message={m} /> : null
          ) : m.kind === "text" && (m.text || m.attachments?.length) ? (
            !user && isPureLeakedSystemHarnessMessage(m.text) && !m.attachments?.length ? null : (
              <RoomTextMessage
                group={group}
                message={m}
                members={members}
                transcript={transcript}
                emerging={m.id === emergingId}
                eager={m.id === newestMessageId || m.id === newestUserMessageId}
                onReply={onReply}
              />
            )
          ) : null;
        if (!row) return divider && <div key={m.id} className="contents">{divider}</div>;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && (
              <div className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
            {divider}
            {!user && m.from && newCluster && !(m.kind === "activity" && m.comm) && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} />
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

/** Under a reply in an Auto room: the decision model chose this speaker. */
export function RoutedByLine({ routedBy }: { routedBy: NonNullable<Message["routedBy"]> }) {
  const percent = Math.round(Math.min(1, Math.max(0, routedBy.probability)) * 100);
  return (
    <div data-testid="routed-by" className="mt-1 px-1 text-[11px] text-ink-secondary">
      {t("room.routedBy", { percent: String(percent) })}
    </div>
  );
}

export function DefaultResponderSelect({ group, members }: { group: Group; members: Bot[] }) {
  const { state, dispatch } = useStore();
  const jevOn = jevRoomRoutingOn(state.config);
  const responder = effectiveDefaultResponder(group, members);
  const value = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const title =
    responder.kind === "everyone"
      ? t("room.responder.everyone")
      : responder.kind === "mentions"
        ? t("room.responder.mentions")
        : responder.kind === "auto"
          ? jevOn
            ? t("room.responder.auto")
            : t("room.responder.autoOff", { name: defaultResponderName(group, members) ?? t("room.responder.leadFallback") })
          : t("room.responder.lead", { name: lead?.name ?? t("room.responder.leadFallback") });

  const change = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    // The lead a room had stays on as Auto's fallback.
    else if (nextValue === "auto") next = responder.kind === "member" ? { kind: "auto", fallbackBotId: responder.botId } : { kind: "auto" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  return (
    <div className="relative shrink-0" title={title}>
      <select
        aria-label={t("room.responder.aria")}
        value={value}
        onChange={(event) => change(event.target.value)}
        className="h-8 max-w-[190px] appearance-none truncate rounded-full border border-hairline/40 bg-raised/60 py-1 pl-3 pr-7 text-[12.5px] font-medium text-ink outline-none hover:bg-raised focus:border-accent"
      >
        <optgroup label={t("room.responder.groupLead")}>
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              {t("room.responder.leadOption", { name: member.name })}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("room.responder.groupBehavior")}>
          <option value="auto">{jevOn ? t("room.responder.autoOption") : t("room.responder.autoOptionOff")}</option>
          <option value="everyone">{t("room.responder.everyoneOption")}</option>
          <option value="mentions">{t("room.responder.mentionsOption")}</option>
        </optgroup>
      </select>
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary"
      />
    </div>
  );
}

/** The room's shared desk: where every member's shell and file tools run,
 * overriding each bot's own folder for room turns. The room pins its own
 * copy on its first turn (the server does the pinning — engines key their
 * sessions to the folder a thread starts in, so a folder must not move
 * under a room that already worked somewhere). The PATCH is made directly
 * rather than through patchGroup: the server validates the path and a
 * rejected folder must not stick in local state. */
function RoomWorkingFolder({ group }: { group: Group }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const pinned = group.pinnedCwd; // undefined = not yet, null = each bot's own, string = folder
  const locked = pinned !== undefined;
  const shownCwd = locked ? (pinned ?? undefined) : group.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(group.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("room.folder.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("room.folder.detail")}</div>
      {locked ? (
        <div className="mt-3">
          <div className="truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={shownCwd}>
            {shownCwd ? shortPath(shownCwd, home) : <span className="text-ink-secondary">{t("room.folder.own")}</span>}
          </div>
          <div className="mt-2 text-[12px] text-ink-secondary">
            {t("room.folder.locked")}
          </div>
        </div>
      ) : canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={group.cwd}>
            {group.cwd ? shortPath(group.cwd, home) : <span className="text-ink-secondary">{t("room.folder.own")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("room.folder.choose")}
          </button>
          {group.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("keys.clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? group.cwd ?? "").trim() || null);
          }}
        >
          <input
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
            placeholder={t("room.folder.placeholder")}
            value={draft ?? group.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("common.save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The folder this room's turns run in — the pinned folder once a turn ran,
 * else the room folder a first turn would pin. Always present so the desk
 * is settable before any folder exists; quiet (icon only) until then. */
function RoomWorkingFolderChip({ group, onToggle }: { group: Group; onToggle: () => void }) {
  const folder = group.pinnedCwd === undefined ? group.cwd : (group.pinnedCwd ?? undefined);
  if (!folder) {
    return (
      <button
        onClick={onToggle}
        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        title={t("room.folder.chipTitle")}
      >
        <Folder size={14} />
      </button>
    );
  }
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  return (
    <button
      onClick={onToggle}
      className="flex max-w-[180px] items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
      title={t("chat.workingFolder", { folder })}
    >
      <Folder size={12} />
      <span className="truncate font-mono">{name}</span>
    </button>
  );
}


type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

type RoomResponderMode = "lead" | "everyone" | "mentions" | "auto";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
}

function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  // Legacy empty rooms omit both keys and remain immediately usable.
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { state, dispatch } = useStore();
  const jevOn = jevRoomRoutingOn(state.config);
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId
      : group.defaultResponder.kind === "auto" && group.defaultResponder.fallbackBotId ? group.defaultResponder.fallbackBotId
        : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const leadMotion = useMenuMotion(behavior === "lead" && leadPickerOpen);
  const leadPickerRef = useRef<HTMLDivElement>(null);
  const selectedLead = members.find((member) => member.id === leadId) ?? members[0];

  useEffect(() => {
    if (!leadPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!leadPickerRef.current?.contains(event.target as Node)) setLeadPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeadPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [leadPickerOpen]);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    // The lead picked above stays on as Auto's fallback.
    if (behavior === "auto") return members.some((member) => member.id === leadId) ? { kind: "auto", fallbackBotId: leadId } : { kind: "auto" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setLeadPickerOpen(false);
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  return (
    <section
      data-testid="room-setup"
      aria-labelledby="room-setup-title"
      className="relative z-20 w-full overflow-visible rounded-3xl border border-hairline/50 bg-card shadow-xl shadow-black/10"
    >
      <div className="rounded-t-3xl border-b border-hairline/40 bg-panel/70 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white">1</span>
          <div>
            <h1 id="room-setup-title" className="text-xl font-semibold tracking-tight text-ink">{t("room.setup.title", { name: group.name })}</h1>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-relaxed text-ink-secondary">
              {t("room.setup.detail")}
            </p>
          </div>
        </div>
      </div>
      <form
        className="space-y-5 px-5 py-5 sm:px-7 sm:py-6"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("room.folder.title")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("room.setup.folderDetail")}</span>
          <div className="mt-2 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t("room.folder.own")}
              className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
            />
            {window.ogb?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hairline/50 bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} /> Choose
              </button>
            )}
          </div>
        </label>

        <fieldset className="block">
          <legend className="text-[13px] font-semibold text-ink">{t("room.responder.aria")}</legend>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("room.setup.responderDetail")}</p>
          <div role="radiogroup" aria-label={t("room.responder.aria")} className="mt-2 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              role="radio"
              aria-checked={behavior === "auto"}
              onClick={() => {
                setBehavior("auto");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full cursor-pointer flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "auto"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "auto" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "auto" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {jevOn ? t("room.responder.autoOption") : t("room.responder.autoOptionOff")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">
                {jevOn ? t("room.setup.autoDetail") : t("room.setup.autoDetailOff")}
              </span>
            </button>

            <div ref={leadPickerRef} className="relative min-w-0">
              <button
                type="button"
                role="radio"
                aria-checked={behavior === "lead"}
                aria-haspopup="listbox"
                aria-expanded={behavior === "lead" && leadPickerOpen}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                disabled={saving}
                className={cn(
                  "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                  behavior === "lead"
                    ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                    : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        behavior === "lead" ? "border-accent bg-accent" : "border-ink-secondary/60",
                      )}
                    >
                      {behavior === "lead" && <span className="size-1.5 rounded-full bg-white" />}
                    </span>
                    {t("room.behavior.lead")}
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn("shrink-0 text-ink-secondary transition-transform", leadPickerOpen && "rotate-180")}
                  />
                </span>
                <span className="ml-6 mt-2 truncate text-[11.5px] text-ink-secondary">
                  {selectedLead?.name ?? t("room.behavior.chooseTeammate")}
                </span>
              </button>
              {leadMotion.shown && (
                <div
                  role="listbox"
                  aria-label={t("room.behavior.chooseLead")}
                  className={cn("absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/20", leadMotion.className)} {...leadMotion.exitProps}
                >
                  <div className="border-b border-hairline/40 px-3 py-2.5">
                    <div className="text-[12.5px] font-semibold text-ink">{t("room.behavior.chooseLead")}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("room.behavior.chooseLeadDetail")}</div>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1.5">
                    {members.map((member) => {
                      const selected = member.id === leadId;
                      return (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setLeadId(member.id);
                            setLeadPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                            selected ? "bg-accent/10" : "hover:bg-raised",
                          )}
                        >
                          <BotAvatar
                            bot={member}
                            state={normalizeState(member.mascotExpression) ?? "happy"}
                            size={24}
                            animated={false}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{member.name}</span>
                            <span className="block truncate text-[11px] text-ink-secondary">{member.title}</span>
                          </span>
                          {selected && <Check size={15} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "everyone"}
              onClick={() => {
                setBehavior("everyone");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "everyone"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "everyone" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "everyone" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {t("room.responder.everyoneOption")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">{t("room.setup.allMembers")}</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "mentions"}
              onClick={() => {
                setBehavior("mentions");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "mentions"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "mentions" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "mentions" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {t("room.responder.mentionsOption")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">{t("room.setup.onlyMentioned")}</span>
            </button>
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("room.setup.instructions")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("room.setup.instructionsDetail")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder={t("room.setup.instructionsPlaceholder")}
            className="mt-2 w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
          />
        </label>

        {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className="rounded-xl px-3 py-2 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            {t("room.setup.skip")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t("room.setup.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // Same caption handling as ChatView: drag on the header (macOS and
  // Windows), and on Windows shift the right-hand controls below the
  // renderer-drawn caption buttons.
  const { dragProps: headerDragProps, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const [bulletinOpen, setBulletinOpen] = useState(false);
  const [bulletinDraft, setBulletinDraft] = useState(group.bulletin);
  const [folderOpen, setFolderOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
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

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const setupPending = !remoteClient && roomNeedsSetup(group);

  // Mascot stays while a member works; the finished reply pops in above it.
  const lastGroupMessage = group.messages.at(-1);
  const toolInFlight = lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === undefined;
  const activity = liveActivityPhrases(lastGroupMessage);
  // A member busy elsewhere takes its turn when free; until then the room
  // works with no speaker, and the presence row names who it is waiting on.
  const awaited = members.find(
    (b) => b.id === awaitedMemberId(group.working, group.busyBotId, lastGroupMessage),
  );
  const waiting =
    Boolean(speaker && showWorkingDots(true, group.messages.at(-1), speaker.id)) || awaited !== undefined;
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; botId?: string } | null>(null);
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [group.id, group.threadId]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastGroupMessage?.role !== "bot" || lastGroupMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    setPopping({
      id: lastGroupMessage.id,
      botId: lastGroupMessage.from?.botId,
    });
    const messageId = lastGroupMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current?.id === messageId ? null : current);
    }, 520);
  }, [
    lastGroupMessage?.id,
    lastGroupMessage?.role,
    lastGroupMessage?.kind,
    lastGroupMessage?.from?.botId,
  ]);
  const presenceVisible = waiting || popping !== null;
  const announcement = useMemo((): TranscriptSnapshot => {
    const approval = pendingApprovals(group.messages)[0];
    return {
      busy: Boolean(group.working || group.busyBotId),
      reply: latestReply(group.messages, (m) => m.from?.name ?? group.name),
      failure: latestFailure(group.messages, (m) => m.from?.name ?? group.name),
      approval: approval
        ? { id: approval.requestId, name: approval.message.from?.name ?? speaker?.name ?? group.name }
        : undefined,
    };
  }, [group.messages, group.working, group.busyBotId, group.name, speaker?.name]);
  const presenceSpeaker =
    speaker ?? awaited ?? members.find((member) => member.id === popping?.botId) ?? members[0];

  // Only a tail of the room mounts; working dots above stay on the FULL list.
  const {
    scrollRef,
    transcriptRef,
    topSentinelRef,
    transcriptKey,
    following,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showLater,
    jumpToLatest,
    scrollHandlers,
  } = useTranscriptViewport({
    ownerId: group.id,
    threadId: group.threadId,
    messages: group.messages,
    pinOn: [group.busyBotId, group.working, composerDock.pad],
    transcriptShown: !setupPending,
    hasMore: group.hasMore,
  });
  const unreadDivider = useUnreadDivider({ threadId: group.threadId, messages: group.messages, following });

  useEffect(() => setBulletinDraft(group.bulletin), [group.id, group.bulletin]);
  // an open folder editor belongs to the room it was opened in
  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);
  const saveBulletin = () => {
    setBulletinOpen(false);
    if (bulletinDraft !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: bulletinDraft } });
    }
  };

  // Static profile avatars: one per member, a ring + dot on whoever is
  // working. A member actively driving a computer/browser session for this
  // room gets the place icon instead of the plain dot, matching the 1:1
  // composer's PlaceChip live indicator.
  const memberMauses = members.map((b) => {
    const busy = group.busyBotId === b.id;
    const task = b.tasks?.find((candidate) => candidate.threadId === group.threadId);
    const effective = busy ? effectivePlace(b, task) : "off";
    const showPlace = busy && effective !== "off" && effective !== "auto";
    return (
      <span
        key={b.id}
        title={`${b.name}${busy ? " — working…" : ""}`}
        className={cn(
          "relative inline-flex rounded-full",
          busy && "ring-2 ring-accent/50 ring-offset-1 ring-offset-app",
        )}
      >
        <BotAvatar bot={b} state={normalizeState(b.mascotExpression) ?? "happy"} size={24} animated={false} />
        {busy && (
          showPlace ? (
            <span
              className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-app bg-accent text-white"
              role="img"
              aria-label={t("place.chipAria", { place: t(placeLabelKey(effective)) })}
            >
              <PlaceIcon place={effective} size={9} strokeWidth={2.5} aria-hidden="true" />
            </span>
          ) : (
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-app bg-accent" />
          )
        )}
      </span>
    );
  });

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <GroupCallOverlay group={group} members={members} />
      {membersOpen && !remoteClient && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      {/* As in ChatView: the transcript scrolls on under the header and its
          banners, which are liquid glass tinted with the room's background. */}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* Above anything raised inside the transcript (the room set-up card
          is z-20 so its menus clear the composer), below the GroupCallOverlay (z-30). */}
      <GlassBar edge="top" className="z-[25]">
      {/* Header: static member avatars; a ring + dot marks the working bot. */}
      <div
        {...headerDragProps}
        className={cn(
          // @container so the header can wrap in a narrow column. A container
          // query never matches the container itself, so the row that has to
          // wrap is the child below, not this element.
          "@container/roomhead px-5 py-3",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        {/* The control row cannot shrink below its content, so in a narrow
            column (a phone, or the sidebar open in a small window) the room
            name truncated to nothing and the thread picker slid under the
            controls. Narrow, the header wraps like the 1:1 chat header: name
            line on top, controls underneath on the right. The room's controls
            do not fold to icons, so it wraps below 48rem rather than 30rem. */}
        <div data-roomhead-row className="flex items-center justify-between @max-3xl/roomhead:flex-wrap @max-3xl/roomhead:gap-y-1">
        <div data-roomhead-identity className="flex min-w-0 items-center gap-2 @max-3xl/roomhead:basis-full" style={headerNoDragStyle}>
          <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
          {!setupPending && !group.dm && <GroupTaskPicker group={group} />}
        </div>
        <div
          data-roomhead-controls
          className="flex items-center gap-1.5 @max-3xl/roomhead:ml-auto @max-3xl/roomhead:flex-wrap @max-3xl/roomhead:justify-end"
          // The caption buttons sit over the header's right end; drop this
          // control row 16px (visual only) below the 26px overlay.
          style={controlsShiftStyle}
        >
          <button
            type="button"
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
            title={group.name}
            messages={group.messages}
            isGroup
          />
          {!setupPending && <ConversationTurnLimit group={group} />}
          <GroupCallButton group={group} members={members} />
          <GroupUsageChip usage={group.usage} />
          {!remoteClient && !setupPending && !group.dm && <RoomWorkingFolderChip group={group} onToggle={() => setFolderOpen((open) => !open)} />}
          {!remoteClient && !setupPending && !group.dm && <DefaultResponderSelect group={group} members={members} />}
          {group.dm || remoteClient ? (
            memberMauses
          ) : (
            // The roster lives where you already look to see who is in the
            // room; a dashed + says the row is editable without shouting.
            <button
              ref={membersTriggerRef}
              type="button"
              onClick={() => setMembersOpen(true)}
              title={t("room.members.manage")}
              aria-label={
                members.length === 1
                  ? t("room.members.ariaOne")
                  : t("room.members.ariaMany", { count: members.length })
              }
              className="flex items-center gap-1.5 rounded-full py-0.5 pl-1 pr-1.5 hover:bg-raised/60"
            >
              {memberMauses}
              <span className="flex size-[18px] items-center justify-center rounded-full border border-dashed border-hairline/70 text-ink-secondary">
                <Plus size={11} />
              </span>
            </button>
          )}
        </div>
        </div>
      </div>

      {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}
      <ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />

      {/* An Auto room answers like lead mode while the decision model is off: say so, once. */}
      {!setupPending && !group.dm && !remoteClient && state.config && group.defaultResponder.kind === "auto" && !jevRoomRoutingOn(state.config) && (
        <div className="w-full px-5">
          <p data-testid="room-jev-off" className="mb-1 px-2 text-[12px] text-ink-secondary">
            {t("room.responder.jevOffHint", { name: defaultResponderName(group, members) ?? t("room.responder.leadFallback") })}{" "}
            <button
              type="button"
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "decisionModel" })}
              className="cursor-pointer text-accent hover:underline"
            >
              {t("room.responder.jevOffOpen")}
            </button>
          </p>
        </div>
      )}

      {/* Bulletin: one pinned line; click to edit */}
      {!setupPending && <div className="w-full px-5">
        {bulletinOpen ? (
          <div className="mb-1 rounded-lg border border-hairline/40 bg-panel p-2">
            <textarea
              autoFocus
              dir="auto"
              value={bulletinDraft}
              onChange={(e) => setBulletinDraft(e.target.value)}
              onBlur={saveBulletin}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBulletin();
                if (e.key === "Escape") {
                  setBulletinDraft(group.bulletin);
                  setBulletinOpen(false);
                }
              }}
              placeholder={t("room.bulletin.placeholder")}
              rows={4}
              className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        ) : (
          <button
            disabled={remoteClient}
            onClick={() => { if (!remoteClient) setBulletinOpen(true); }}
            className={cn("mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", !remoteClient && "hover:bg-raised/40")}
            title={t("room.bulletin.title")}
          >
            <Pin size={12} className="shrink-0 text-ink-secondary" />
            <span dir="auto" className={cn("truncate text-[12.5px]", group.bulletin ? "text-ink-secondary" : "text-ink-tertiary")}>
              {group.bulletin.split("\n")[0] || (remoteClient ? t("room.bulletin.none") : t("room.bulletin.add"))}
            </span>
          </button>
        )}
      </div>}

      {/* Working folder card — the chip in the header toggles it */}
      {!setupPending && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}

      {/* Pinned message banner — resolves against the room's full transcript */}
      {(() => {
        const pinned = group.messages.find((m) => m.id === group.pinnedMessageId && m.kind === "text");
        const text = pinned ? citationPreviewText(pinned.text ?? "").replace(/\s+/g, " ").trim() : "";
        if (!pinned || !text) return null;
        const sender = pinned.role === "user" ? t("chat.you") : (pinned.from?.name ?? t("room.aBot"));
        return (
          <div className="w-full px-5">
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
              <Pin size={12} className="shrink-0 text-accent" />
              <button
                onClick={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: pinned.id })}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                title={t("chat.pinnedJump")}
              >
                <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
                <span dir="auto" className="truncate text-[12.5px] text-ink-secondary">{text}</span>
              </button>
              <button
                onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
                aria-label={t("chat.unpinMessage")}
                title={t("chat.unpin")}
                className={cn("shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink", remoteClient && "hidden")}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        );
      })()}
      </GlassBar>

      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
        {...scrollHandlers}
      >
        {setupPending ? (
          <div className="flex min-h-full w-full items-center pb-8" style={{ paddingTop: "calc(var(--glass-top, 0px) + 2rem)" }}>
            <RoomSetup group={group} members={members} />
          </div>
        ) : (
        <div
          ref={transcriptRef}
          className="glass-scroller-content flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          // off, as in ChatView: TranscriptAnnouncer speaks once per reply
          aria-live="off"
          aria-label={t("room.aria", { name: group.name })}
        >
          {group.messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    state="happy"
                    size={44}
                    motion="none"
                    motionKey={0}
                    animated={false}
                  />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                {groupResponseHint(group, members, { jevOn: jevRoomRoutingOn(state.config) })}
              </div>
            </div>
          )}
          {/* Reverse infinite scroll sentinel and smooth loading indicator */}
          {olderPending ? (
            <div className="flex items-center justify-center gap-2 py-3 text-xs text-ink-secondary">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <span>{t("chat.loadingEarlier")}</span>
            </div>
          ) : hiddenCount > 0 || group.hasMore ? (
            <div ref={topSentinelRef} className="h-2 w-full pointer-events-none" aria-hidden="true" />
          ) : null}
          <Transcript
            group={group}
            members={members}
            locale={activeLocale()}
            messages={windowedMessages}
            transcript={group.messages}
            emergingId={popping?.id}
            unreadDividerId={unreadDivider.messageId}
            unreadDividerFading={unreadDivider.fading}
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
          {(speaker || presenceVisible) && (
            <TurnPresence
              avatar={
                // the speaker's real profile image when it has one, as in ChatView
                <BotAvatar
                  bot={presenceSpeaker ?? { color: "green" }}
                  state={toolInFlight && !awaited ? "working" : "thinking"}
                  size={36}
                  forward={false}
                  lookAround={1}
                  trackPointer={false}
                />
              }
              visible={presenceVisible}
              phrases={activity.phrases}
              phase={activity.phase}
              seed={`${group.id}:${group.turnStartedAt ?? ""}:${speaker?.id ?? ""}`}
              answering={popping !== null}
              since={speaker ? group.turnStartedAt ?? null : null}
            />
          )}
        </div>
        )}
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      {!following && (
        <button
          onClick={jumpToLatest}
          aria-label={t("chat.jumpToLatestAria")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
      <Composer
        key={group.threadId}
        group={group}
        members={members}
        locked={setupPending}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
      />
      <CitationSelectionToolbar
        key={`${group.id}:${group.threadId}`}
        viewportRef={scrollRef}
        onAdd={(citation) => appendDraftAttachments(`group:${citation.source.ownerId}:${citation.source.threadId}`, [citation])}
      />
      </div>
      </GlassScrollFrame>
    </main>
  );
}
