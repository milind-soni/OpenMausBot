import { memo, useMemo } from "react";
import { MessageSquareReply, Pin, PinOff } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import {
  formatTime,
  openNotificationTarget,
  useStore,
  type Bot,
  type Group,
  type Message,
} from "@/state/store";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { roomActivityVisible } from "@/lib/room-activity";
import { normalizeState } from "@/lib/mascot";
import { groupActivityRuns } from "@/lib/activity-runs";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { ActivityRun } from "../ActivityRun";
import { ApprovalCard } from "../ApprovalCard";
import { AttachmentGallery, MessageAttachmentGallery } from "../AttachmentGallery";
import { BotAvatar } from "../Avatar";
import { ChatMarkdown } from "../ChatMarkdown";
import { ConnectorCard } from "../ConnectorCard";
import { GoalRunCard } from "../GoalRunCard";
import { OptionCard } from "../OptionCard";
import { QuestionCard } from "../QuestionCard";
import { ReplyQuote } from "../ReplyQuote";
import { hasRoutineExecutionTask, RoutineRunCard } from "../RoutineRunCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { ThreadRefText } from "../ThreadRefs";
import { RoomToolChip } from "./RoomToolChip";

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.day.today");
  if (diffDays === 1) return t("chat.day.yesterday");
  return d.toLocaleDateString(activeLocale(), { weekday: "short", month: "short", day: "numeric" });
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

/** Pin toggle for one room message — one pin per room, patchGroup path. */
function PinToggle({ group, message }: { group: Group; message: Message }) {
  const { dispatch } = useStore();
  if (window.ogb?.remoteClient?.active) return null;
  const pinned = group.pinnedMessageId === message.id;
  return (
    <button
      onClick={() =>
        dispatch({
          type: "patchGroup",
          groupId: group.id,
          patch: { pinnedMessageId: pinned ? "" : message.id },
        })
      }
      aria-label={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      title={pinned ? t("chat.unpinHint") : t("room.pinHint")}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
}

export const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
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
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          const cluster = !prev || prev.role !== first.role || prev.from?.botId !== first.from?.botId || newDay;
          return (
            <div key={item.id} className="contents">
              {newDay && (
                <div className="py-3 text-center text-[13px] text-ink-secondary">
                  {dayLabel(first.at)} {formatTime(first.at)}
                </div>
              )}
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
        const attachments = user && m.text ? splitTranscriptAttachments(m.text) : null;
        const newCluster = !prev || prev.role !== m.role || prev.from?.botId !== m.from?.botId || Boolean(prev.comm) || newDay;
        const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const row =
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
              <QuestionCard threadId={group.threadId} bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <ApprovalCard bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "options" && m.card && m.from?.botId ? (
            // a QUESTION from a member. Without this branch the card fell
            // through to null: invisible on screen, and the asking bot sat
            // there until its 15-minute timeout answered for you
            <div className="flex justify-start">
              <OptionCard botId={m.from.botId} threadId={group.threadId} groupId={group.id} message={m} />
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
              <RoomToolChip message={m} roomId={group.id} />
            ) : null
          ) : m.kind === "text" && (m.text || m.attachments?.length) ? (
            <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
              <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
                {user && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label={t("chat.replyToMessage")}
                      title={t("chat.reply")}
                      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                <div
                  className={cn(
                    "w-fit max-w-[min(42rem,78%)] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                    !user && m.id === emergingId && "turn-answer",
                    user ? "chat-text whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
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
                      {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId: group.threadId, messageId: m.id }} eager={m.id === newestMessageId || m.id === newestUserMessageId} className={!attachments.display ? "mb-0" : undefined} />}
                      <ThreadRefText text={attachments?.display ?? m.text ?? ""} peers={members} everyone={!group.dm} />
                      {m.via === "api" && (
                        <div className="mt-1 text-[11px] text-ink-secondary">Sent through the API, not typed here</div>
                      )}
                    </>
                  ) : (
                    <>
                      <MessageAttachmentGallery text={m.text ?? ""} attachments={m.attachments} message={{ threadId: group.threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={m.id === newestMessageId || m.id === newestUserMessageId} />
                      {m.text ? <ChatMarkdown text={m.text} mentionPeers={members} everyone={!group.dm} message={{ threadId: group.threadId, messageId: m.id }} /> : null}
                    </>
                  )}
                </div>
                {!user && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label={t("chat.replyToMessage")}
                      title={t("chat.reply")}
                      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                <span className="self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100">
                  {formatTime(m.at)}
                </span>
              </div>
            </div>
          ) : null;
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && (
              <div className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
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
