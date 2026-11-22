import { ChevronRight, MessagesSquare } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { activityText } from "@/lib/activity-text";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { HandoffReply } from "./HandoffReply";
import { HandoffStatusChip } from "./HandoffStatusChip";

export function ThreadChip({ message, threadId }: { message: Message; threadId?: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  const direct = message.sentDirectly;
  const label = !direct ? activityText(tool, tool.name)
    : direct.room ? t("chat.sentDirectlyNotInRoom", { name: direct.name, room: direct.room }) : t("chat.sentDirectly", { name: direct.name });
  return (
    <HandoffReply message={message} threadId={threadId}>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        data-thread-chip={ref.threadId}
        onClick={() => openThread(dispatch, ref, state, showThreads)}
        title={t("chat.openThread", { title: ref.title })}
        className={cn("ui-pill", tool.ok === false && "text-danger")}
      >
        {bot ? <BotAvatar bot={bot} state="happy" size={16} animated={false} /> : <MessagesSquare size={13} aria-hidden="true" />}
        <span className="max-w-[480px] truncate">{label}</span>
        <ChevronRight size={13} />
      </button>
      {message.handoff && <HandoffStatusChip line={message.handoff} />}
      </span>
    </HandoffReply>
  );
}
