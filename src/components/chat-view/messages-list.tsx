import { memo, useMemo } from "react";
import { api, useStore, openNotificationTarget, type Bot, type InstanceInfo, type Message } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { OptionCard, shouldHideOnboardingCard } from "../OptionCard";
import { ApprovalCard } from "../ApprovalCard";
import { QuestionCard } from "../QuestionCard";
import { ConnectorCard } from "../ConnectorCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "../RoutineRunCard";
import { ScreenFrame } from "../ScreenFrame";
import { RenameTitle } from "../RenameTitle";
import { effectivePlace } from "@/lib/place";
import { t } from "@/lib/i18n";
import { groupTranscript } from "@/lib/activity-runs";
import { ActivityRun } from "../ActivityRun";
import { TurnNarrationRun } from "../TurnNarrationRun";
import { ActivityChip } from "./activity-chip";
import { Bubble } from "./bubble";
import { ErrorRow } from "./error-row";
import { MessageBoundary } from "./message-boundary";
import { DaySeparator } from "./separator";
const noop = () => {};


/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
export const MessagesList = memo(function MessagesList({
  bot,
  messages,
  locale,
  transcript,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
}: {
  bot: Bot;
  messages: Message[];
  /** Refresh the memoized transcript and its derived turn labels when the
   * language changes, even when the messages themselves stay unchanged. */
  locale: string;
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  // Finished tool chips become compact runs; settled assistant narration
  // becomes one reversible turn row while the terminal answer stays visible.
  const items = useMemo(() => groupTranscript(messages), [messages, locale]);
  // Where this conversation works, for the place icon on screen and page tools.
  const place = effectivePlace(bot, bot.tasks?.find((task) => task.threadId === bot.threadId));
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <BotAvatar bot={bot} state="idle" size={64} motion="none" motionKey={0} />
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
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {bot.description || t("chat.emptyPrompt")}
          </div>
        </div>
      )}
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
        const first = item.kind === "message" ? item.message : item.messages[0];
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "turn") {
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <TurnNarrationRun
                label={item.label}
                forceOpen={item.messages.some((message) => message.id === focusedId)}
              >
                {item.messages.map((message) => (
                  <div key={message.id} className="contents" data-mid={message.id}>
                    <Bubble
                      bot={bot}
                      message={message}
                      editing={false}
                      isLastBotText={false}
                      onStartEdit={noop}
                      onCancelEdit={noop}
                      onSubmitEdit={noop}
                      replyTarget={message.replyToId
                        ? bot.messages.find((candidate) => candidate.id === message.replyToId)
                        : undefined}
                      onReply={() => onReply(message)}
                    />
                  </div>
                ))}
              </TurnNarrationRun>
            </div>
          );
        }
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityChip message={step} place={place} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          switch (m.kind) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "options": {
              // a live permission ask gets the approval box; a structured
              // ask gets the question box; anything else keeps the list
              // card. The first-run quiz drops out once they talk.
              // Cards are bot-authored and persisted, so one that will not
              // draw must fall back to its text on every open, not take the
              // whole page down every time this chat is selected.
              const card = m.card?.requestId && m.card.questionRequest ? (
                <QuestionCard threadId={bot.threadId} bot={bot} message={m} />
              ) : m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={bot} message={m} />
              ) : shouldHideOnboardingCard(m, transcript) ? null : (
                <OptionCard botId={bot.id} threadId={bot.threadId} message={m} />
              );
              if (!card) return null;
              return (
                <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
                  {card}
                </MessageBoundary>
              );
            }
            case "routine.run": {
              const executionThreadId = m.routineRun?.executionThreadId;
              const canOpen = executionThreadId && state.bots.some((candidate) =>
                candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
              );
              return (
                <RoutineRunCard
                  message={m}
                  onOpen={canOpen && executionThreadId
                    ? () => openNotificationTarget(
                        dispatch,
                        { botId: bot.id, threadId: executionThreadId },
                        state,
                      )
                    : undefined}
                />
              );
            }
            case "activity": {
              // a failed turn is an error, not a tool run — render it as one.
              // bot⇄bot comm chips and opened-thread chips stay because they
              // link to another conversation.
              // plain tool runs stay out unless Settings → Tool calls is on.
              if (m.tool?.name.startsWith("error:")) {
                return (
                  <ErrorRow
                    message={m.tool.name.slice(6).trim()}
                    onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                    setupInstance={m.tool.setup ? engine : undefined}
                  />
                );
              }
              if (!showToolCalls && !m.comm && !m.threadRef) return null;
              return <ActivityChip message={m} place={place} />;
            }
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  emerging={m.id === emergingId}
                  eagerAttachments={m.id === newestMessageId || m.id === newestUserMessageId}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
                  onReply={() => onReply(m)}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});
