import { Crown, Loader2, Phone } from "lucide-react";
import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";

import { botShowsUnread } from "@/lib/bot-unread";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useLiveMedia } from "@/lib/live-call-media";
import { stateForBot } from "@/lib/mascot";
import { useShowThreads } from "@/lib/thread-preferences";
import { api, openBot, useStore, type Bot } from "@/state/store";
import { useChiefStepOpen } from "@/lib/default-bot";

import { BotAvatar } from "./Avatar";
import { botTooltip } from "./BotModelBadge";
import { liveBadgeFor } from "./LiveCallPill";
import { pinnedCircleDragClass, pinnedCircleDragHandlers, usePinnedCircleDrag, type PinnedCircleDragProps } from "./PinnedCircleThreads";
import { RenameTitle } from "./RenameTitle";
import { openBotContextMenu, useVisibleMessages, type BotRowProps } from "./Sidebar";
import { sidebarBotStatus } from "./SidebarBotActivity";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";

const RING = "ring-2 ring-[var(--tile)]";

type TileProps = BotRowProps & PinnedCircleDragProps & { primary?: boolean };

export const SidebarBotTile = memo(function SidebarBotTile({ primary = false, drag, dragging, drop, prevId, nextId, ...row }: TileProps) {
  const { bot, selected, deleting, mascotMotion, pendingQueued, instances, liveCall, dispatch, onMenu, renameRequest } = row;
  const showThreads = useShowThreads();
  const liveMedia = useLiveMedia();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const visible = useVisibleMessages(bot);
  const { waiting, working, teammateWait, queued } = sidebarBotStatus(bot, pendingQueued);
  const unread = botShowsUnread(bot);
  const onLiveCall = liveBadgeFor(bot.id, liveMedia, liveCall);
  const tooltip = botTooltip(bot, instances);
  const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued ? t("task.queued") : "";
  const label = [bot.name, bot.chiefOfStaff ? t("sidebar.bot.chiefOfStaff") : "", onLiveCall ? t("call.live.badge") : "", status, unread ? t("task.unread") : ""].filter(Boolean).join(" · ");
  const reorder = pinnedCircleDragHandlers(bot.id, { drag, dragging, prevId, nextId });
  const open = () => openBot(dispatch, bot, showThreads);
  const rename = (name: string) => {
    if (!remoteClient) return dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
    void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
      .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
      .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu({ botId: bot.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else {
      reorder.onKeyDown?.(event);
    }
  };
  const dot = (testId: string, tone: string) => <span data-testid={testId} aria-hidden="true" className={cn("absolute -right-0.5 -top-0.5 size-3 rounded-full", tone, RING)} />;
  return (
    <div
      role={renaming ? undefined : "button"}
      tabIndex={renaming ? undefined : 0}
      data-sidebar-bot-row={bot.id}
      data-sidebar-tile={primary ? "primary" : "pinned"}
      draggable={Boolean(drag) && !renaming}
      aria-label={renaming ? undefined : label}
      aria-current={selected && !renaming ? "page" : undefined}
      aria-busy={deleting || undefined}
      aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      title={tooltip}
      {...reorder}
      onClick={(event: MouseEvent) => { if (!renaming && !(event.target instanceof HTMLInputElement)) open(); }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
      className={cn(
        "flex h-[92px] w-[78px] shrink-0 cursor-default flex-col items-center rounded-[10px] bg-[var(--tile)] px-1 pt-2 transition-colors duration-150", SIMPLE_ROW_FOCUS,
        selected ? "[--tile:var(--color-raised)]" : "[--tile:var(--color-panel)] hover:[--tile:color-mix(in_srgb,var(--color-raised)_50%,var(--color-panel))]",
        pinnedCircleDragClass({ drag, dragging, drop }),
      )}
    >
      <span className="relative flex">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={56}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          animated={working || unread || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {primary && bot.chiefOfStaff && (
          <span data-testid="chief-badge" className={cn("absolute -bottom-px -right-px flex size-4 items-center justify-center rounded-full bg-[#E8993A] text-white", RING)}>
            <Crown size={10} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
          </span>
        )}
        {onLiveCall ? (
          <span data-testid="live-call-badge" className={cn("absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-success", RING)}>
            <Phone size={9} strokeWidth={2.5} aria-hidden="true" />
          </span>
        ) : waiting ? (
          <span data-testid="waiting-dot" aria-hidden="true" className={cn("absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-warning text-[11px] font-black leading-none text-panel", RING)}>!</span>
        ) : working ? dot("working-dot", "bg-success")
          : teammateWait ? dot("teammate-wait-dot", "bg-accent")
          : queued ? dot("queued-dot", "bg-ink-tertiary")
          : unread ? dot("unread-dot", "bg-accent")
          : null}
        {deleting && (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-panel/60 text-ink-secondary">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="mt-1.5 flex w-full min-w-0 justify-center">
        <RenameTitle
          value={bot.name}
          editRequest={renameRequest}
          title={tooltip}
          onCommit={rename}
          onEditingChange={setRenaming}
          className="min-w-0 truncate text-center text-[13px] font-medium leading-4 text-ink"
          inputClassName="w-full rounded bg-inset px-1 text-center text-[13px] font-medium leading-4"
        />
      </span>
    </div>
  );
});

/** The sidebar while the first run's Chief step is open over an app with no bots of the person's own yet. */
export function SidebarNoBots() {
  const { state } = useStore();
  const chiefStep = useChiefStepOpen();
  if (!chiefStep || state.bots.some((bot) => !bot.hidden && !bot.defaultBot)) return null;
  return <p data-sidebar-empty="" className="px-5 pt-4 text-[13px] leading-[18px] text-ink-tertiary">{t("onboarding.shell.noBots")}</p>;
}

export function SidebarTileGrid({ primary, pinned, row }: { primary: Bot | null; pinned: Bot[]; row: (bot: Bot) => BotRowProps }) {
  const order = usePinnedCircleDrag(pinned);
  if (!primary && order.ranked.length === 0) return null;
  return (
    <div data-sidebar-tiles="" className="flex max-h-[40vh] flex-wrap justify-center gap-1 overflow-y-auto px-3 pb-4 pt-2.5" {...order.frameProps}>
      {primary && <SidebarBotTile {...row(primary)} primary />}
      {order.ranked.map((bot) => <SidebarBotTile key={bot.id} {...row(bot)} {...order.dragProps(bot)} />)}
      <span role="status" className="sr-only">{order.moved}</span>
    </div>
  );
}
