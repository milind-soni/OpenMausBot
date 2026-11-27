import { use } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { activityText } from "@/lib/activity-text";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { OpenExchangeContext } from "./HandoffExchange";
import { HandoffReply } from "./HandoffReply";
import { HandoffStatusChip } from "./HandoffStatusChip";

export function ThreadChip({ message, threadId }: { message: Message; threadId?: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const openExchange = use(OpenExchangeContext);
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  const direct = message.sentDirectly;
  const label = !direct ? activityText(tool, tool.name)
    : direct.room ? t("chat.sentDirectlyNotInRoom", { name: direct.name, room: direct.room }) : t("chat.sentDirectly", { name: direct.name });
  // A teammate's work for the bot that sent it is read in place of this chat; any other thread still opens in its own chat.
  const asker = message.from;
  // The helper's main chat is its talk with the person, not with the asker: that still opens there.
  const handoff = message.handoff, ended = handoff?.state === "done" || handoff?.state === "failed";
  const workThread = bot && ref.threadId !== bot.threadId && (bot.tasks ?? []).some((task) => task.threadId === ref.threadId);
  const exchange = openExchange && !direct && asker && bot && asker.botId !== bot.id && workThread
    ? { asker, helper: { botId: bot.id, name: bot.name, color: bot.color }, threadId: ref.threadId, ...(handoff ? { id: handoff.id, sentAt: message.at, ...(ended ? { endedAt: handoff.at } : {}) } : {}) }
    : null;
  const exchangeLabel = bot ? t("chat.handoffExchange.open", { name: bot.name }) : "";
  // The line that records a hand-off in the helper's own chat shows the bot that asked.
  const pictured = message.askedBy ? state.bots.find((candidate) => candidate.id === message.askedBy!.botId) : bot;
  return (
    <HandoffReply message={message} threadId={threadId}>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      {exchange ? (
        <button
          type="button"
          data-thread-chip={ref.threadId}
          data-exchange-chip
          onClick={() => openExchange?.(exchange)}
          aria-label={exchangeLabel}
          title={exchangeLabel}
          className={cn("ui-pill", tool.ok === false && "text-danger")}
        >
          {bot && <BotAvatar bot={bot} state="happy" size={16} animated={false} />}
          <span dir="auto" className="max-w-[240px] truncate">{exchange.helper.name}</span>
        </button>
      ) : (
        <button
          type="button"
          data-thread-chip={ref.threadId}
          onClick={() => openThread(dispatch, ref, state, showThreads)}
          title={t("chat.openThread", { title: ref.title })}
          className={cn("ui-pill", tool.ok === false && "text-danger")}
        >
          {pictured ? <BotAvatar bot={pictured} state="happy" size={16} animated={false} /> : <MessagesSquare size={13} aria-hidden="true" />}
          <span className="max-w-[480px] truncate">{label}</span>
          <ChevronRight size={13} />
        </button>
      )}
      {message.handoff && <HandoffStatusChip line={message.handoff} />}
      </span>
    </HandoffReply>
  );
}
