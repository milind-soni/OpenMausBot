import { ChevronRight, MessagesSquare } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { activityText } from "@/lib/activity-text";
import { BotAvatar } from "./Avatar";

export function ThreadChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  return (
    <div className="flex justify-start">
      <button
        type="button"
        data-thread-chip={ref.threadId}
        onClick={() => openThread(dispatch, ref, state, showThreads)}
        title={t("chat.openThread", { title: ref.title })}
        className="ui-pill"
      >
        {bot ? <BotAvatar bot={bot} state="happy" size={16} animated={false} /> : <MessagesSquare size={13} aria-hidden="true" />}
        <span className="max-w-[480px] truncate">{activityText(tool, tool.name)}</span>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
