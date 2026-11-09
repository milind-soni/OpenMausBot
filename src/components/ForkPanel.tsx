import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

export function ForkPanel() {
  const { state, dispatch } = useStore();
  const panel = state.forkPanel;
  if (!panel) return null;
  const bot = panel.kind === "bot" ? state.bots.find((candidate) => candidate.id === panel.ownerId) : undefined;
  const group = panel.kind === "group" ? state.groups.find((candidate) => candidate.id === panel.ownerId) : undefined;
  const task = bot?.tasks?.find((candidate) => candidate.threadId === panel.threadId)
    ?? group?.tasks?.find((candidate) => candidate.threadId === panel.threadId);
  const openedBot = bot && task ? { ...bot, threadId: panel.threadId, messages: panel.messages, activeLeafId: panel.activeLeafId, hasMore: false } : null;
  const openedGroup = group && task ? { ...group, threadId: panel.threadId, messages: panel.messages, hasMore: false } : null;

  return (
    <aside aria-label={t("chat.forkPanel")} className="relative flex h-full w-[min(48vw,640px)] min-w-[360px] flex-col border-l border-hairline bg-app">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2 text-sm font-medium text-ink">
        <span className="truncate">{task?.title ?? t("chat.forkPanel")}</span>
        <button type="button" aria-label={t("chat.closeForkPanel")} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          onClick={() => dispatch({ type: "closeForkPanel" })}><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1">
        {panel.loading ? <p className="p-4 text-sm text-ink-secondary">{t("chat.loadingFork")}</p>
          : openedBot ? <ChatView key={panel.threadId} bot={openedBot} />
            : openedGroup ? <GroupView key={panel.threadId} group={openedGroup} />
              : <p className="p-4 text-sm text-ink-secondary">{t("chat.forkUnavailable")}</p>}
      </div>
    </aside>
  );
}
