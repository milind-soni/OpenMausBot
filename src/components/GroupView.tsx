import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formattedReplyWidth, isFormattedReply, splitReplyBlocks } from "@/lib/formatted-reply";
import { activeLocale, t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { useReactor } from "@/lib/cloud-guest";
import { otherSpeaker } from "@/lib/own-profile";
import { Check, ChevronDown, FolderOpen, Loader2, Pin, Square, X } from "lucide-react";
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
import { ScreenFrame } from "./ScreenFrame";
import { RoomHoldsBanner } from "./RoomHoldsBanner";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { CompactionChip, DigestChip } from "./DigestChip";
import { roomActivityVisible } from "@/lib/room-activity";
import { StatusActivityRow } from "@/components/StatusActivityRow"; import { BugReportNote } from "@/components/BugReportNote";
import { normalizeState } from "@/lib/mascot";
import { botTextShowsSpeaker, laterTextOwns, runShowsSpeaker } from "@/lib/room-speaker";
import { defaultResponderName, groupResponseHint, jevRoomRoutingOn } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { FailedTurnRow, MessageBoundary } from "./ChatView";
import { SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT, SIMPLE_USER_BUBBLE } from "./chat-bubble";
import { ReplyBlocks } from "./ReplyBlocks";
import { useAdvancedMode } from "@/lib/interface-mode";
import { CopyButton, MESSAGE_ROW, MessageActions, messageActionClass, ReplyAction } from "./MessageActions";
import { ReactAction, ReactionChips, useCanReact } from "./Reactions";
import { ClusterLabel } from "./RoomClusterLabel";
import { roomPin, useBotMessageMenu, userMessageMenu } from "./message-menu";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { SpeakButton } from "./SpeakButton";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { CancelledTurnRow } from "./CancelledTurnRow";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { roomRetryRequest } from "@/lib/room-retry";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { CitationSelectionToolbar, SentCitations } from "./CitationUI";
import { RoomComposer } from "./bot-access/RoomComposer";
import { ChatErrorBanner, ChatNotice } from "./ChatErrorBanner";
import { RoomContextWarnings } from "./ContextWarning";
import { ChatFindBar } from "./ChatFindBar";
import { isPureLeakedSystemHarnessMessage, stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { GoalRunCard } from "./GoalRunCard";
import { AttachmentGallery, MessageAttachmentGallery, replyAttachmentGroup } from "./AttachmentGallery";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { OptionCard } from "./OptionCard";
import { GroupCallOverlay } from "./GroupCallView";

import { ApprovalCard } from "./ApprovalCard";
import { isQuestionCard, QuestionCard } from "./QuestionCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { groupActivityRuns, isStatusActivity, roomTurnFolds } from "@/lib/activity-runs";
import { TurnNarrationRun } from "./TurnNarrationRun";
import { ActivityRun } from "./ActivityRun";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { liveToolIds } from "@/lib/tool-liveness";
import { roomNeedsSetup } from "@/lib/room-setup";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { awaitedMemberId, showWorkingDots } from "@/lib/turn-tail";
import { turnNowPhrases } from "@/lib/live-activity"; import { useTurnLive } from "@/state/turn-status";
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
import { DataResultChip } from "./DataResultChip"; import { PublishedPageCard } from "./PublishedPageCard";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { dayLabel, localDay } from "@/lib/transcript-derivations";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { RoomQueueList, RoutedByLine } from "./RoomQueueList";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { HandoffChip } from "./HandoffReply"; import { TeammateChip } from "./TeammateChip"; import { useTeammates } from "@/state/team-people";
import { RoomWorkingFolder } from "./RoomWorkingFolder";
import { RoomBulletin } from "./RoomBulletin";
import { RoomHeader } from "./RoomHeader";
import { useChatFindRequests } from "@/lib/chat-find";
import { simpleRoomHeader } from "@/lib/room-panel";

export function RoomToolChip({ message, roomId, live = false }: { message: Message; roomId?: string; live?: boolean }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />; if (message.relay) return <TeammateChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(state.bots.find((b) => b.id === message.from?.botId), state.instances)} botId={message.from?.botId} />;
  }
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    return <HandoffChip message={message} bots={state.bots} title={t("room.openBot", { name: comm.withName })} onClick={() => {
      dispatch({ type: "select", id: comm.groupId });
      const destination = state.groups.find(g => g.id === comm.groupId);
      if (comm.threadId && destination?.tasks?.some(task => task.threadId === comm.threadId)) {
        dispatch({ type: "switchGroupTask", groupId: comm.groupId, threadId: comm.threadId });
      }
    }} />;
  }
  if (!comm) return <ToolActivity tool={tool} live={live} />;
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

const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function RoomTextMessage({
  group,
  message: m,
  members,
  transcript,
  emerging,
  eager,
  onReply,
  canReact,
}: {
  group: Group;
  message: Message;
  members: Bot[];
  transcript: Message[];
  emerging: boolean;
  eager: boolean;
  onReply: (message: Message) => void;
  canReact: boolean;
}) {
  const { state, dispatch } = useStore();
  const user = m.role === "user";
  const reactor = useReactor();
  const speaker = otherSpeaker(m, state.config?.team && reactor !== "user" ? reactor : null);
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
  useEffect(() => { if (focusedSearch && collapsible) setExpanded(true); }, [focusedSearch, collapsible, focus?.nonce]);
  const simple = !useAdvancedMode();
  const speakerBot = members.find((member) => member.id === m.from?.botId);
  const botText = rawText; const teammates = useTeammates(); const peers = useMemo(() => [...members, ...teammates.peers], [members, teammates]);
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
  const replyGroup = useMemo(() => !user && botText.trim() ? replyAttachmentGroup(botText, m.attachments) : null, [user, botText, m.attachments]);
  const blocks = useMemo(() => simple && !user && !viewRaw && botText.trim() ? splitReplyBlocks(botText) : null, [simple, user, viewRaw, botText]);
  const tabled = Boolean(blocks?.some((block) => block.kind === "table"));
  const botActions = !user && (
    <MessageActions side="bot" forceOpen={viewRaw || speaking} menu={botMenu}>
      <ReplyAction onReply={() => onReply(m)} />
      {canReact && m.from && <ReactAction threadId={group.threadId} message={m} />}
      {botText && <CopyButton text={botText} className={messageActionClass} />}
      {botText && viewRaw && <RawToggleAction active onToggle={() => setViewRaw(false)} className={messageActionClass} />}
      {botText && speaking && <SpeakButton text={botText} botId={speakerBot?.id} messageId={m.id} voiceId={speakerBot?.voice} tts={state.config?.tts} localVoice={localSystemVoiceActive()} className={cn(messageActionClass, "text-accent")} />}
    </MessageActions>
  );
  return (
    <div {...{ [MESSAGE_ROW]: "" }} className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
      {speaker && <div className="mb-0.5 px-1 text-[12px] font-medium text-ink-secondary">{speaker}</div>}
      <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user" menu={userMessageMenu({ messageId: m.id, pin })}>
            <ReplyAction onReply={() => onReply(m)} />
            {Boolean(display.trim()) && <CopyButton text={display} className={messageActionClass} />}
          </MessageActions>
        )}
        <div
          data-chat-bubble={simple ? "simple" : ""}
          className={cn(
            tabled ? "w-full" : "w-fit",
            simple ? cn(!tabled && SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT) : "max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl text-[15px] leading-relaxed",
            !user && emerging && "turn-answer",
            tabled || (!user && !m.text?.trim() && !m.replyToId && m.attachments?.length)
              ? "text-ink"
              : !simple && !user && isFormattedReply(m.text ?? "")
                ? cn(formattedReplyWidth(m.text ?? ""), "px-1 text-ink")
                : user
                  ? cn("chat-text whitespace-pre-wrap text-ink", simple ? SIMPLE_USER_BUBBLE : "bg-bubble-user px-4 py-2.5")
                  : simple ? SIMPLE_BOT_BUBBLE : "bg-card px-4 py-2.5 text-ink",
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
                <ThreadRefText text={display} peers={peers} everyone={!group.dm} />
              </div>{m.bugReport && <BugReportNote report={m.bugReport} />}
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
              {!botText.trim() && <MessageAttachmentGallery text={botText} attachments={m.attachments} message={{ threadId: group.threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={eager} />}
              {viewRaw && botText ? (
                <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={group.id} data-citation-thread={group.threadId}><RawMarkdownView text={botText} /></div>
              ) : tabled && blocks ? (
                <ReplyBlocks blocks={blocks} tray={botActions} citation={{ messageId: m.id, ownerType: "group", ownerId: group.id, threadId: group.threadId }}
                  render={(block) => <ChatMarkdown text={block} mentionPeers={peers} everyone={!group.dm} mentionPerson={{ profileName: state.config?.profile?.name }} message={{ threadId: group.threadId, messageId: m.id }} delivered={replyGroup?.delivered} />} />
              ) : botText ? (
                <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={group.id} data-citation-thread={group.threadId}><ChatMarkdown text={botText} mentionPeers={peers} everyone={!group.dm} mentionPerson={{ profileName: state.config?.profile?.name }} message={{ threadId: group.threadId, messageId: m.id }} delivered={replyGroup?.delivered} /></div>
              ) : null}
              {replyGroup && <AttachmentGallery images={replyGroup.images} files={replyGroup.files} message={{ threadId: group.threadId, messageId: m.id }} eager={eager} beneath />}
            </MessageBoundary>
          )}
        </div>
        {!tabled && botActions}
        <span className="self-end pb-1 text-[11px] tabular-nums text-ink-tertiary opacity-0 transition-opacity group-hover:opacity-100">
          {formatTime(m.at)}
        </span>
      </div>
      <ReactionChips threadId={group.threadId} message={m} bots={members} align={user ? "end" : "start"} canReact={canReact} />
      {!user && m.routedBy && <RoutedByLine routedBy={m.routedBy} />}
    </div>
  );
}

export const Transcript = memo(function Transcript({
  group,
  members,
  locale,
  messages,
  transcript,
  emergingId,
  unreadDividerId = null,
  unreadDividerFading = false,
  onReply,
}: {
  group: Group;
  members: Bot[];
  locale: string;
  messages: Message[];
  transcript: Message[];
  emergingId?: string | null;
  unreadDividerId?: string | null;
  unreadDividerFading?: boolean;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const showToolCalls = showToolCallsEnabled(state.config);
  const canReact = useCanReact(group.threadId);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  const folds = useMemo(() => roomTurnFolds(messages), [messages, locale]);
  const items = useMemo(() => groupActivityRuns(messages.filter(message =>
    !folds.hiddenIds.has(message.id) &&
    (message.kind !== "activity" || roomActivityVisible(message, showToolCalls)))), [messages, showToolCalls, folds]);
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const roomBusy = roomThreadWorking(group, group.threadId);
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
  const retryRequest = useMemo(() => {
    const newest = transcript[retryableIndex];
    return newest && isCancelledTranscriptRow(newest) ? roomRetryRequest(transcript, retryableIndex) : null;
  }, [transcript, retryableIndex]);
  const liveTools = useMemo(() => liveToolIds(transcript, { busy: roomBusy, turnStartedAt: group.turnStartedAt }), [transcript, roomBusy, group.turnStartedAt]);
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
          const cluster = runShowsSpeaker(items, i, showToolCalls);
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
                    <RoomToolChip message={step} live={liveTools.has(step.id)} />
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
          <CancelledTurnRow onRetry={canRetryRoom ? retryRoom : undefined} />
        ) :
          m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} color={m.from.color} threadId={group.threadId} message={m} />
          ) : m.kind === "signin" && m.signIn && m.from?.botId ? (
            <SignInRequestCard botId={m.from.botId} botName={m.from.name} color={m.from.color} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} color={m.from.color} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && isQuestionCard(m.card) ? (
            <div className="flex justify-start">
              <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
                <QuestionCard threadId={group.threadId} asker={memberOf(m.from?.botId)} message={m} />
              </MessageBoundary>
            </div>
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <MessageBoundary fallbackText={m.card.subtitle || m.card.title || ""}>
                <ApprovalCard bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} />
              </MessageBoundary>
            </div>
          ) : m.kind === "options" && m.card && m.from?.botId ? (
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
                  ? () => openNotificationTarget(dispatch, routineTarget, state, showThreads)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            roomActivityVisible(m, showToolCalls) ? (
              m.dataResult ? <DataResultChip message={m} /> : isStatusActivity(m) ? <StatusActivityRow message={m} /> : <RoomToolChip message={m} roomId={group.id} live={liveTools.has(m.id)} />
            ) : null
          ) : m.kind === "screen" ? (
            <ScreenFrame threadId={group.threadId} message={m} />
          ) : m.kind === "compaction" ? (
            <CompactionChip message={m} />
          ) : m.kind === "digest" ? (
            showToolCalls ? <DigestChip message={m} /> : null
          ) : m.publishedPage ? <PublishedPageCard message={m} /> : m.kind === "text" && (m.text || m.attachments?.length) ? (
            !user && isPureLeakedSystemHarnessMessage(m.text) && !m.attachments?.length ? null : (
              <RoomTextMessage
                group={group}
                message={m}
                members={members}
                transcript={transcript}
                emerging={m.id === emergingId}
                eager={m.id === newestMessageId || m.id === newestUserMessageId}
                onReply={onReply}
                canReact={canReact}
              />
            )
          ) : null;
        if (!row) return divider && <div key={m.id} className="contents">{divider}</div>;
        const fold = folds.byTerminalId.get(m.id);
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && (
              <div className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
            {divider}
            {m.from && (
              (m.kind === "text" && botTextShowsSpeaker(items, i))
              || (!user && m.kind !== "text" && newCluster && !(m.kind === "activity" && m.comm) && !laterTextOwns(items, i, m.from.botId, m.at))
            ) && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} />
            )}
            {fold && (
              <TurnNarrationRun
                label={fold.label}
                forceOpen={fold.messages.some((note) => note.id === focusedId)}
              >
                {fold.messages.map((note) => (
                  <div key={note.id} className="contents" data-mid={note.id}>
                    <RoomTextMessage
                      group={group}
                      message={note}
                      members={members}
                      transcript={transcript}
                      emerging={false}
                      eager={false}
                      onReply={onReply}
                      canReact={canReact}
                    />
                  </div>
                ))}
              </TurnNarrationRun>
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

type RoomResponderMode = "lead" | "everyone" | "mentions" | "auto";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
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
      className="relative z-20 w-full overflow-visible rounded-2xl border border-hairline/50 bg-card shadow-xl shadow-black/10"
    >
      <div className="rounded-t-3xl border-b border-hairline/40 bg-panel/70 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white">1</span>
          <div>
            <h1 id="room-setup-title" className="text-xl font-semibold tracking-tight text-ink">{t("room.setup.title", { name: group.name })}</h1>
            <p className="mt-1 max-w-[560px] text-[14px] leading-relaxed text-ink-secondary">
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
              className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
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
              <span className="ml-6 mt-2 text-[12px] text-ink-secondary">
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
                <span className="ml-6 mt-2 truncate text-[12px] text-ink-secondary">
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
                    <div className="text-[13px] font-semibold text-ink">{t("room.behavior.chooseLead")}</div>
                    <div className="mt-0.5 text-[12px] text-ink-secondary">{t("room.behavior.chooseLeadDetail")}</div>
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
              <span className="ml-6 mt-2 text-[12px] text-ink-secondary">{t("room.setup.allMembers")}</span>
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
              <span className="ml-6 mt-2 text-[12px] text-ink-secondary">{t("room.setup.onlyMentioned")}</span>
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

        {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
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
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
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
  useChatFindRequests(group.threadId, findOpen, setFindOpen);
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
  const threadWorking = roomThreadWorking(group, group.threadId);
  const threadSpeakerId = roomThreadSpeakerId(group, group.threadId);
  const threadSpeaker = threadSpeakerId ? members.find((b) => b.id === threadSpeakerId) : undefined;
  const setupPending = !remoteClient && roomNeedsSetup(group);
  const advancedMode = useAdvancedMode();
  const simpleHeader = simpleRoomHeader({ advanced: advancedMode, remoteClient, group, setupPending });

  const lastGroupMessage = group.messages.at(-1);
  const toolInFlight = lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === undefined;
  const live = useTurnLive(group.threadId), activity = turnNowPhrases(live.status, lastGroupMessage);
  const awaited = members.find(
    (b) => b.id === awaitedMemberId(threadWorking, group.busyBotId, lastGroupMessage),
  );
  const waiting =
    Boolean(speaker && showWorkingDots(true, group.messages.at(-1), speaker.id, live.ended)) || awaited !== undefined;
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
    wasWaiting.current = waiting;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastGroupMessage?.role !== "bot" || lastGroupMessage.kind !== "text" || !wasWaiting.current) return;
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
      busy: threadWorking,
      reply: latestReply(group.messages, (m) => m.from?.name ?? group.name),
      failure: latestFailure(group.messages, (m) => m.from?.name ?? group.name),
      approval: approval
        ? { id: approval.requestId, name: approval.message.from?.name ?? speaker?.name ?? group.name }
        : undefined,
    };
  }, [group.messages, threadWorking, group.name, speaker?.name]);
  const presenceSpeaker =
    speaker ?? awaited ?? members.find((member) => member.id === popping?.botId) ?? members[0];

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

  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <GroupCallOverlay group={group} members={members} />
      {membersOpen && !remoteClient && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* z-[25]: above the room set-up card (z-20), below the GroupCallOverlay (z-30). */}
      <GlassBar edge="top" fade={!advancedMode && !remoteClient} className="z-[25]">
      <RoomHeader
        group={group}
        members={members}
        simple={simpleHeader}
        setupPending={setupPending}
        remoteClient={remoteClient}
        findOpen={findOpen}
        onToggleFind={() => setFindOpen((open) => !open)}
        onToggleFolder={() => setFolderOpen((open) => !open)}
        onOpenMembers={() => setMembersOpen(true)}
        membersTriggerRef={membersTriggerRef}
      />

      {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}
      <ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />
      <ChatNotice notice={state.notice} />
      {!setupPending && <RoomContextWarnings group={group} members={members} />}

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

      {!setupPending && !group.dm && <RoomHoldsBanner group={group} members={members} />}

      {!setupPending && !simpleHeader && <RoomBulletin group={group} remoteClient={remoteClient} />}

      {!setupPending && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}

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
                <span className="shrink-0 text-[12px] font-medium text-accent">{sender}</span>
                <span dir="auto" className="truncate text-[13px] text-ink-secondary">{text}</span>
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
          className="glass-scroller-content chat-column relative flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
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
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {(speaker || presenceVisible) && (
            <TurnPresence
              avatar={
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
              phrases={activity?.phrases}
              phase={activity?.phase}
              size={activity?.size} hover={activity?.hover} quiet={live.status && "quiet" in live.status ? live.status.quiet : undefined}
              seed={`${group.id}:${group.turnStartedAt ?? ""}:${speaker?.id ?? ""}`}
              answering={popping !== null}
              since={speaker ? group.turnStartedAt ?? null : null}
            />
          )}
          <RoomQueueList group={group} members={members} />
          {threadSpeaker && !group.dm && members.length > 1 && !group.holds?.[threadSpeaker.id] && (
            <div className="flex justify-start pl-12">
              <button
                type="button"
                data-testid="room-stop-member"
                onClick={() => dispatch({ type: "setGroupHold", groupId: group.id, botId: threadSpeaker.id, held: true })}
                title={t("room.holds.stopTitle", { name: threadSpeaker.name })}
                className="ui-pill"
              >
                <Square size={11} aria-hidden="true" />
                <span>{t("room.holds.stop", { name: threadSpeaker.name })}</span>
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      {!following && (
        <JumpToLatestButton onClick={jumpToLatest} style={{ bottom: composerDock.height }} />
      )}

      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2] chat-column-dock">
      <RoomComposer
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
