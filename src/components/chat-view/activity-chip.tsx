import { ChevronRight } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { ThreadChip } from "../ThreadChip";
import { ToolActivity } from "../ToolActivity";
import { toolPlace, type EffectivePlace } from "@/lib/place";
import { t } from "@/lib/i18n";
/** A tool run: spinner while live, check/cross once settled. */
export function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    const withBot = state.bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("chat.openConversationWith", { name: comm.withName })}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  return <ToolActivity tool={tool} place={toolPlace(tool.name, place)} />;
}
