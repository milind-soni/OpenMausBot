import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { Check, ChevronDown, FolderOpen, Loader2, Square } from "lucide-react";
import {
  api,
  useStore,
  formatTime,
  openRoomThread,
  openThread,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useStoreRef } from "@/state/store-ref"; import { localSystemVoiceActive } from "@/lib/local-voice";
import { RoomTextMessage } from "./RoomTextMessage";
import { BotAvatar } from "./Avatar";
import { ScreenFrame } from "./ScreenFrame";
import { RoomHoldsBanner } from "./RoomHoldsBanner";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { CompactionChip, DigestChip } from "./DigestChip";
import { roomActivityVisible } from "@/lib/room-activity";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { normalizeState } from "@/lib/mascot";
import { botTextShowsSpeaker, laterTextOwns, runShowsSpeaker } from "@/lib/room-speaker"; import { roomAddressees } from "@/lib/room-addressees";
import { defaultResponderName, groupResponseHint, jevRoomRoutingOn } from "@/lib/group-routing";
import { FailedTurnRow, MessageBoundary } from "./ChatView";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useCanReact } from "./Reactions";
import { ClusterLabel } from "./RoomClusterLabel";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { CancelledTurnRow } from "./CancelledTurnRow";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { roomRetryRequest } from "@/lib/room-retry";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { CitationSelectionToolbar } from "./CitationUI";
import { RoomComposer } from "./bot-access/RoomComposer";
import { ChatErrorBanner, ChatNotice } from "./ChatErrorBanner";
import { RoomContextWarnings } from "./ContextWarning"; import { RoomChiefAbsent } from "./RoomChiefAbsent";
import { ChatFindBar } from "./ChatFindBar";
import { isPureLeakedSystemHarnessMessage } from "../../shared/system-message-guard.ts";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";
import { isPinnedSignIn, NO_PINNED_SIGN_INS, PinnedSignInSlot } from "./PinnedSignInSlot";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { GoalRunCard } from "./GoalRunCard";
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
import { useLiveToolIds } from "@/hooks/use-live-tool-ids";
import { roomNeedsSetup, setupResponderMode, type RoomResponderMode } from "@/lib/room-setup";
import { useComposerDockPad } from "@/lib/composer-dock";
import { ChatBackdrop, GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { awaitedMemberId, showWorkingDots } from "@/lib/turn-tail";
import { turnNowPhrases } from "@/lib/live-activity"; import { useTurnLive } from "@/state/turn-status"; import { isLiveReply, roomLiveSpeaker, StreamingReplyContext, useLiveRow, useLiveTranscriptLayout } from "@/state/live-reply";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport"; import { staysInView } from "../../shared/person-wait";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { unreadMessageIds } from "@/lib/unread-divider";
import { NewMessagesDivider } from "./NewMessagesDivider";
import { appendDraftAttachments, useReplyDraft } from "@/lib/drafts";
import { latestFailure, latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { pendingApprovals } from "./PendingApproval";
import { DataResultChip } from "./DataResultChip"; import { PublishedPageCard } from "./PublishedPageCard"; import { TemplateChatCard } from "./TemplateCard"; import { RoomRichRow } from "./RichMessageRow";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { dayLabel, localDay } from "@/lib/transcript-derivations";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { RoomQueueList } from "./RoomQueueList";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { HandoffChip } from "./HandoffReply"; import { TeammateChip } from "./TeammateChip"; import { useTeammates } from "@/state/team-people";
import { RoomWorkingFolder } from "./RoomWorkingFolder";
import { RoomBulletin } from "./RoomBulletin";
import { RoomHeader } from "./RoomHeader";
import { useChatFindRequests, useChatFindShortcut } from "@/lib/chat-find";
import { simpleRoomHeader } from "@/lib/room-panel";

export const RoomToolChip = memo(function RoomToolChip({ message, roomId, threadId, live = false }: { message: Message; roomId?: string; threadId?: string; live?: boolean; /** Drawn again in a new language. */ locale?: string }) {
  const bots = useStoreSelector((s) => s.bots), instances = useStoreSelector((s) => s.instances), dispatch = useStoreDispatch(), store = useStoreRef();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} threadId={threadId} />; if (message.relay) return <TeammateChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(bots.find((b) => b.id === message.from?.botId), instances)} botId={message.from?.botId} messageAt={message.at} />;
  }
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    return <HandoffChip message={message} bots={bots} threadId={threadId} title={t("room.openBot", { name: comm.withName })} onClick={() => openRoomThread(dispatch, comm, store.state().groups)} />;
  }
  if (!comm) return <ToolActivity tool={tool} live={live} source={threadId ? { threadId, messageId: message.id } : undefined} />;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "ui-pill",
          tool.ok === false && "text-danger",
        )}
      >
        {comm && <BotAvatar bot={bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
});

/** A text message's speaker; one still streaming names whom it @-mentions as its words arrive. */
function TextSpeakerLabel({ threadId, message, bot, members, transcript, teammates, locale }: { threadId: string; message: Message; bot?: Bot; members: Bot[]; transcript: Message[]; teammates: Parameters<typeof roomAddressees>[3]; locale: string }) {
  const m = useLiveRow(threadId, message);
  return m.from ? <ClusterLabel bot={bot} name={m.from.name} color={m.from.color} to={roomAddressees(m, members, transcript, teammates)} locale={locale} /> : null;
}

export const Transcript = memo(function Transcript({
  group,
  members,
  locale, localVoice = false,
  messages: saved,
  transcript,
  pinnedSignInIds = NO_PINNED_SIGN_INS,
  emergingId,
  unreadDividerId = null,
  unreadDividerFading = false,
  onReply,
}: {
  group: Group;
  members: Bot[];
  locale: string; localVoice?: boolean;
  messages: Message[];
  transcript: Message[];
  pinnedSignInIds?: ReadonlySet<string>;
  emergingId?: string | null;
  unreadDividerId?: string | null;
  unreadDividerFading?: boolean;
  onReply: (message: Message) => void;
}) {
  const dispatch = useStoreDispatch(), store = useStoreRef(), config = useStoreSelector((s) => s.config), focus = useStoreSelector((s) => s.focusMessage);
  const phone = useMediaQuery(PHONE_LAYOUT);
  const showThreads = useShowThreads();
  const showToolCalls = showToolCallsEnabled(config);
  const canReact = useCanReact(group.threadId); const teammatePeers = useTeammates().peers;
  const memberOf = (id?: string) => members.find((b) => b.id === id), speakingNow = roomThreadSpeakerId(group, group.threadId);
  const messages = useLiveTranscriptLayout(group.threadId, saved, transcript, useMemo(() => roomLiveSpeaker(members, speakingNow), [members, speakingNow]));
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
  const liveTools = useLiveToolIds(transcript, { busy: roomBusy, turnStartedAt: group.turnStartedAt });
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
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  const byId = useMemo(() => new Map(transcript.map((message) => [message.id, message])), [transcript]);
  const textRow = (message: Message, emerging: boolean, eager: boolean) => (
    <RoomTextMessage groupId={group.id} threadId={group.threadId} dm={Boolean(group.dm)} pinned={group.pinnedMessageId === message.id} working={roomBusy}
      message={message} members={members} replyTarget={message.replyToId ? byId.get(message.replyToId) : undefined}
      emerging={emerging} eager={eager} onReply={onReply} canReact={canReact} phone={phone} locale={locale} localVoice={localVoice} />
  );
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
                <ClusterLabel bot={memberOf(first.from.botId)} name={first.from.name} color={first.from.color} locale={locale} />
              )}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <RoomToolChip message={step} threadId={group.threadId} live={liveTools.has(step.id)} locale={locale} />
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
          ) : m.kind === "signin" && m.signIn && m.from?.botId && !pinnedSignInIds.has(m.id) ? (
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
                  ? () => openThread(dispatch, routineTarget, store.state(), showThreads)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            roomActivityVisible(m, showToolCalls) ? (
              m.dataResult ? <DataResultChip message={m} /> : isStatusActivity(m) ? <StatusActivityRow message={m} /> : <RoomToolChip message={m} roomId={group.id} threadId={group.threadId} live={liveTools.has(m.id)} locale={locale} />
            ) : null
          ) : m.kind === "screen" ? (
            <ScreenFrame threadId={group.threadId} message={m} />
          ) : m.kind === "compaction" ? (
            <CompactionChip message={m} />
          ) : m.kind === "digest" ? (
            showToolCalls ? <DigestChip message={m} /> : null
          ) : (m.kind === "app" || m.kind === "widget") && m.from ? <RoomRichRow message={m} from={m.from} threadId={group.threadId} /> : m.template ? <TemplateChatCard message={m} /> : m.publishedPage ? <PublishedPageCard message={m} /> : m.kind === "text" && (m.text || m.attachments?.length || isLiveReply(m)) ? (
            !user && isPureLeakedSystemHarnessMessage(m.text) && !m.attachments?.length ? null : (
              textRow(m, m.id === emergingId, m.id === newestMessageId || m.id === newestUserMessageId)
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
            {m.from && m.kind === "text" && botTextShowsSpeaker(items, i) ? (
              <TextSpeakerLabel threadId={group.threadId} message={m} bot={memberOf(m.from.botId)} members={members} transcript={transcript} teammates={teammatePeers} locale={locale} />
            ) : m.from && !user && m.kind !== "text" && newCluster && !(m.kind === "activity" && m.comm) && !laterTextOwns(items, i, m.from.botId, m.at) && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} locale={locale} />
            )}
            {fold && (
              <TurnNarrationRun
                label={fold.label}
                forceOpen={fold.messages.some((note) => note.id === focusedId)}
              >
                {fold.messages.map((note) => (
                  <div key={note.id} className="contents" data-mid={note.id}>{textRow(note, false, false)}</div>
                ))}
              </TurnNarrationRun>
            )}
            {isLiveReply(m) ? <StreamingReplyContext value>{row}</StreamingReplyContext> : row}
          </div>
        );
      })}
    </>
  );
});

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
                <FolderOpen size={14} /> {t("room.folder.chooseShort")}
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
export function GroupView({ group, inForkPanel = false, bare = false }: { group: Group; inForkPanel?: boolean; /** Beside the room's feed: no header or bulletin of its own. */ bare?: boolean }) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const pinnedSignIns = useMemo(() => group.messages.flatMap((m) => {
    const from = m.from;
    return isPinnedSignIn(m) && from?.botId ? [{ message: m, botId: from.botId, botName: from.name, color: from.color, threadId: group.threadId }] : [];
  }), [group.messages, group.threadId]);
  const pinnedSignInIds = useMemo(() => new Set(pinnedSignIns.map((card) => card.message.id)), [pinnedSignIns]);
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
  useChatFindShortcut(inForkPanel, Boolean(state.forkPanel), setFindOpen);

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
    following, showJumpToLatest,
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
    hasMore: group.hasMore, rests: staysInView,
  });
  const unreadDivider = useUnreadDivider({ threadId: group.threadId, messages: group.messages, following });

  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);

  return (
    <main data-look="chat" className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <ChatBackdrop /><GroupCallOverlay group={group} members={members} />
      {membersOpen && !remoteClient && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* z-[25]: above the room set-up card (z-20), below the GroupCallOverlay (z-30). */}
      <GlassBar edge="top" fade={!advancedMode && !remoteClient} className="z-[25]">
      {!bare && <RoomHeader
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
      />}

      {findOpen && <ChatFindBar threadId={group.threadId} inForkPanel={inForkPanel} onClose={() => setFindOpen(false)} />}
      <ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />
      <ChatNotice notice={state.notice} />
      {!setupPending && <RoomContextWarnings group={group} members={members} />}{!setupPending && !remoteClient && !bare && <RoomChiefAbsent group={group} />}

      {!setupPending && !bare && !group.dm && !remoteClient && state.config && group.defaultResponder.kind === "auto" && !jevRoomRoutingOn(state.config) && (
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

      {!setupPending && !simpleHeader && !bare && <RoomBulletin group={group} remoteClient={remoteClient} />}

      {!setupPending && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}
      <PinnedSignInSlot cards={pinnedSignIns} />

      </GlassBar>

      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto px-4 [overflow-anchor:none]"
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
            locale={activeLocale()} localVoice={localSystemVoiceActive()}
            messages={windowedMessages}
            transcript={group.messages}
            pinnedSignInIds={pinnedSignInIds}
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
              visible={presenceVisible} threadId={group.threadId}
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

      {showJumpToLatest && (
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
