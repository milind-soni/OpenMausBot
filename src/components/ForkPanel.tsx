import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { useFeature } from "@/lib/use-feature";
import { useInboxPanel } from "@/state/inbox";
import { currentTaskBot, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";
import { ThreadPanelHeading } from "./room-feed/ThreadPanelHeading";
import { PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";

const BESIDE_INBOX_MAX = 400;

/** Any thread beside the chat: a fork, and with the room feed on, the thread a feed row or the Inbox opened. */
export function ForkPanel() {
  const { state, dispatch } = useStore();
  const panel = state.forkPanel;
  const asideRef = useRef<HTMLElement>(null);
  const focusedLoad = useRef<string | undefined>(undefined);
  const beside = useFeature("roomFeed");
  const resize = useComputerPanelResize({ key: "omb-thread-panel-width", defaultWidth: 440 });
  // Beside the Inbox the chat keeps the 440 it has beside any other side panel.
  const width = useInboxPanel().open ? Math.min(resize.panelWidth, BESIDE_INBOX_MAX) : resize.panelWidth;
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
  const fork = !beside || Boolean(task?.origin);
  const label = fork ? t("chat.forkPanel") : t("room.thread.panel");
  const close = () => dispatch({ type: "closeForkPanel" });

  return (
    <aside ref={asideRef} tabIndex={panel.focusComposer ? -1 : undefined} aria-label={label} data-thread-panel={panel.threadId}
      style={beside ? { width, ["--side-panel-w" as string]: `${width}px` } : undefined}
      className={cn("relative flex h-full flex-col bg-app", beside
        ? "shrink-0 border-s-[0.5px] border-edge md:animate-panel-beside-in motion-reduce:animate-none"
        : "w-[min(48vw,640px)] min-w-[360px] border-s border-hairline")}>
      {beside && <div
        ref={resize.separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("room.thread.resize")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={resize.maxWidth}
        aria-valuenow={resize.separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={resize.onSeparatorKeyDown}
        onPointerDown={resize.onResizeStart}
        onPointerMove={resize.onResizeMove}
        onPointerUp={resize.onResizeEnd}
        onPointerCancel={resize.onResizeEnd}
        className="absolute inset-y-0 start-0 z-30 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60"
      />}
      {beside ? (
        <header className="flex shrink-0 items-center gap-2 py-2.5 ps-4 pe-3">
          {!fork && group && groupTask ? <ThreadPanelHeading group={group} task={groupTask} messages={panel.messages} working={Boolean(openedGroup?.working || openedGroup?.busyBotId)} /> : <div className="min-w-0 flex-1">
            <h2 dir="auto" title={task?.title} className="truncate text-[15px] font-semibold leading-5 text-ink">{fork ? task?.title ?? label : label}</h2>
            <p dir="auto" className="truncate text-[12px] leading-4 text-ink-secondary">{group?.name ?? bot?.name}</p>
          </div>}
          <button type="button" aria-label={fork ? t("chat.closeForkPanel") : t("room.thread.close")} title={fork ? t("chat.closeForkPanel") : t("room.thread.close")}
            className="ui-icon-button shrink-0" onClick={close}><X size={16} aria-hidden="true" /></button>
        </header>
      ) : (
        <div className="flex items-center justify-between border-b border-hairline px-4 py-2 text-sm font-medium text-ink">
          <span className="truncate">{task?.title ?? t("chat.forkPanel")}</span>
          <button type="button" aria-label={t("chat.closeForkPanel")} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            onClick={close}><X size={16} /></button>
        </div>
      )}
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
            : openedGroup ? <GroupView key={panel.threadId} group={openedGroup} inForkPanel bare={beside} />
              : <p className="p-4 text-sm text-ink-secondary">{t("chat.forkUnavailable")}</p>}
      </div>
    </aside>
  );
}
