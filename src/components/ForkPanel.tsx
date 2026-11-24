import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { currentTaskBot, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

export function ChatWindow({ owner, thread }: { owner: string; thread: string }) {
  const { state, dispatch } = useStore();
  const kind = state.bots.some(bot => bot.id === owner) ? "bot" : state.groups.some(group => group.id === owner) ? "group" : null;
  const panel = state.forkPanel;
  useEffect(() => {
    if (kind && (panel?.threadId !== thread || panel.ownerId !== owner)) dispatch({ type: "openForkPanel", kind, ownerId: owner, threadId: thread });
  }, [dispatch, kind, owner, thread, panel?.threadId, panel?.ownerId]);
  const profile = (kind === "bot" ? state.bots : state.groups).find(entry => entry.id === owner);
  const title = profile?.tasks?.find(task => task.threadId === thread)?.title;
  const name = profile?.name;
  useEffect(() => {
    if (name) document.title = title ? `${title} · ${name}` : name;
  }, [name, title]);
  return <div className="h-dvh bg-app" data-chat-window={thread}>
    {panel?.threadId === thread && panel.ownerId === owner ? <ForkPanel standalone />
      : <p className="p-4 text-sm text-ink-secondary">{t(state.hydrated && !kind ? "chat.forkUnavailable" : "chat.loadingFork")}</p>}
  </div>;
}

export function ForkPanel({ standalone = false }: { standalone?: boolean }) {
  const { state, dispatch } = useStore();
  const panel = state.forkPanel;
  const asideRef = useRef<HTMLElement>(null);
  const focusedLoad = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!panel?.focusComposer || !aside) return;
    if (focusedLoad.current === panel.loadId && document.activeElement !== aside) return;
    focusedLoad.current = panel.loadId;
    (aside.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea:not([disabled])') ?? aside).focus();
  }, [panel?.focusComposer, panel?.loadId, panel?.loading]);
  if (!panel) return null;
  const bot = panel.kind === "bot" ? state.bots.find((candidate) => candidate.id === panel.ownerId) : undefined;
  const group = panel.kind === "group" ? state.groups.find((candidate) => candidate.id === panel.ownerId) : undefined;
  const botTask = bot?.tasks?.find((candidate) => candidate.threadId === panel.threadId);
  const groupTask = group?.tasks?.find((candidate) => candidate.threadId === panel.threadId);
  const task = botTask ?? groupTask;
  const openedBot = bot && botTask ? { ...currentTaskBot(bot, panel.threadId), messages: panel.messages, activeLeafId: panel.activeLeafId, hasMore: false } : null;
  const openedGroup = group && groupTask ? { ...group, threadId: panel.threadId, messages: panel.messages, hasMore: false,
    working: groupTask.working ?? false, busyBotId: groupTask.busyBotId ?? null,
    turnStartedAt: null, pinnedCwd: groupTask.pinnedCwd, pinnedMessageId: groupTask.pinnedMessageId } : null;

  return (
    <aside ref={asideRef} tabIndex={panel.focusComposer ? -1 : undefined} aria-label={(standalone && task?.title) || t("chat.forkPanel")} className={standalone ? "flex h-full flex-col bg-app" : "relative flex h-full w-[min(48vw,640px)] min-w-[360px] flex-col border-l border-hairline bg-app"}>
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2 text-sm font-medium text-ink">
        <span className="truncate">{task?.title ?? t("chat.forkPanel")}</span>
        {!standalone && <button type="button" aria-label={t("chat.closeForkPanel")} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          onClick={() => dispatch({ type: "closeForkPanel" })}><X size={16} /></button>}
      </div>
      <div className="min-h-0 flex-1">
        {panel.loading ? <p className="p-4 text-sm text-ink-secondary">{t("chat.loadingFork")}</p>
          : panel.loadFailed ? <div className="flex items-center gap-3 p-4 text-sm text-ink-secondary">
            <span>{t("chat.forkUnavailable")}</span>
            <button type="button" className="rounded px-2 py-1 text-ink hover:bg-raised"
              onClick={() => dispatch({ type: "openForkPanel", kind: panel.kind, ownerId: panel.ownerId, threadId: panel.threadId, focusComposer: panel.focusComposer })}>
              {t("chat.retry")}
            </button>
          </div>
          : openedBot ? <ChatView key={panel.threadId} bot={openedBot} inForkPanel />
            : openedGroup ? <GroupView key={panel.threadId} group={openedGroup} inForkPanel />
              : <p className="p-4 text-sm text-ink-secondary">{t("chat.forkUnavailable")}</p>}
      </div>
    </aside>
  );
}
