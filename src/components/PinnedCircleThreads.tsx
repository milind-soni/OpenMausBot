import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FolderPlus, Plus } from "lucide-react";
import { openBot, visibleMessages, type Bot, type Message } from "@/state/store";
import { avatarCropRadius, botAvatarProfile } from "../../shared/bot-avatar";
import { liveActivityLabel } from "@/lib/live-activity";
import { BotAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { searchMatchesThreads, useSearchDisclosure } from "@/lib/search-disclosure";
import { lastNonReceipt } from "@/lib/receipts";
import { t } from "@/lib/i18n";
import { BotProjectDialog } from "./BotProjects";
import { useShowThreads } from "@/lib/thread-preferences";
import { sidebarBotActivityTasks } from "./SidebarBotActivity";
import { setPinnedCircleOrder, usePinnedCircleOrder, type SidebarDensity } from "@/lib/sidebar-preferences";
import { PINNED_CIRCLE_DRAG_TYPE, pinnedCircleDropPlace, rankPinnedCircles, reorderPinnedCircles, type PinnedCircleDrop, type PinnedCircleDropPlace } from "@/lib/pinned-circle-order";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { BotListItem, BotThreadList, type BotRowProps } from "./Sidebar";

function useVisibleMessages(bot: Bot): Message[] {
  const { messages, activeLeafId } = bot;
  return useMemo(() => visibleMessages({ messages, activeLeafId }), [messages, activeLeafId]);
}

function botHasThreadList(bot: Pick<Bot, "tasks" | "projects">, query: string): boolean {
  return (bot.tasks?.filter((task) => !task.routineRunId).length ?? 1) > 1
    || (bot.projects?.length ?? 0) > 0
    || Boolean(query);
}

function threadListQuery(bot: Pick<Bot, "name" | "title">, query: string): string {
  const q = query.toLowerCase();
  return bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q) ? "" : query;
}

function pinnedCircleThreadPanelId(botId: string): string {
  return `pinned-circle-threads-${botId}`;
}

/** Columns of `repeat(auto-fill, minmax(84px, 1fr))` with `gap-1` (4px). */
function pinnedCircleColumns(width: number): number {
  return Math.max(1, Math.floor((width + 4) / (84 + 4)));
}

function chunkPinnedCircles<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += columns) rows.push(items.slice(index, index + columns));
  return rows;
}

export function PinnedCircleThreadPanel(props: BotRowProps) {
  const showThreads = useShowThreads();
  const { bot, query, dispatch } = props;
  const visible = useVisibleMessages(bot);
  const last = lastNonReceipt(visible);
  const [creatingProject, setCreatingProject] = useState(false);
  if (!showThreads) return null;
  return (
    <div id={pinnedCircleThreadPanelId(bot.id)} data-sidebar-pinned-circle-thread-list={bot.id} className="mt-1">
      <BotThreadList {...props} activityLabel={liveActivityLabel(last)} query={threadListQuery(bot, query)} />
      <div className="flex items-center gap-1 pl-6">
        <button type="button" aria-label={t("task.newShort")} title={t("task.newShort")} onClick={() => dispatch({ type: "newTask", botId: bot.id })}
          className="inline-flex h-7 items-center gap-1 rounded px-1 text-[13px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
          <Plus aria-hidden="true" size={13} />{t("task.newShort")}
        </button>
        <button type="button" aria-label={t("folder.newNamed", { name: bot.name })} title={t("folder.new")} onClick={() => setCreatingProject(true)}
          className="inline-flex h-7 items-center gap-1 rounded px-1 text-[13px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
          <FolderPlus aria-hidden="true" size={13} />{t("folder.new")}
        </button>
      </div>
      {creatingProject && <BotProjectDialog bot={bot} onClose={() => setCreatingProject(false)} />}
    </div>
  );
}

type PinnedCircleDrag = {
  reorder: (movedId: string, targetId: string, place: PinnedCircleDropPlace) => void;
  setDragging: (id: string | null) => void;
  setDrop: (drop: PinnedCircleDrop | null) => void;
};

export type PinnedCircleDragProps = { drag?: PinnedCircleDrag; dragging?: boolean; drop?: PinnedCircleDrop | null; prevId?: string; nextId?: string };

const circleDropPlace = (event: DragEvent<HTMLElement>) =>
  pinnedCircleDropPlace(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), document.documentElement.dir === "rtl");

const isCircleDrag = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(PINNED_CIRCLE_DRAG_TYPE);

function pinnedCircleDropClass({ axis, place }: PinnedCircleDrop): string {
  if (axis === "y") return place === "before" ? "shadow-[0_-2px_var(--color-accent)]" : "shadow-[0_2px_var(--color-accent)]";
  return place === "before" ? "shadow-[-2px_0_var(--color-accent)]" : "shadow-[2px_0_var(--color-accent)]";
}

export function pinnedCircleDragClass({ drag, dragging = false, drop = null }: PinnedCircleDragProps): string {
  return cn(drag && "cursor-grab select-none active:cursor-grabbing", dragging && "opacity-40", drop && !dragging && pinnedCircleDropClass(drop));
}

export function pinnedCircleDragHandlers(botId: string, { drag, dragging = false, prevId, nextId }: PinnedCircleDragProps) {
  if (!drag) return {};
  return {
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(PINNED_CIRCLE_DRAG_TYPE, botId);
      drag.setDragging(botId);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!isCircleDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      drag.setDrop(dragging ? null : { id: botId, ...circleDropPlace(event) });
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!isCircleDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      drag.reorder(event.dataTransfer.getData(PINNED_CIRCLE_DRAG_TYPE), botId, circleDropPlace(event).place);
      drag.setDragging(null);
      drag.setDrop(null);
    },
    onDragEnd: () => { drag.setDragging(null); drag.setDrop(null); },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.key === "ArrowUp" ? prevId : event.key === "ArrowDown" ? nextId : undefined;
      if (!target) return;
      event.preventDefault();
      drag.reorder(botId, target, event.key === "ArrowUp" ? "before" : "after");
    },
  };
}

export function usePinnedCircleDrag(bots: Bot[]) {
  const saved = usePinnedCircleOrder();
  const ranked = rankPinnedCircles(bots, saved);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<PinnedCircleDrop | null>(null);
  const [moved, setMoved] = useState("");
  const latest = useRef({ saved, shown: ranked });
  latest.current = { saved, shown: ranked };
  const drag = useMemo<PinnedCircleDrag>(() => ({
    reorder: (movedId, targetId, place) => {
      const current = latest.current;
      const next = reorderPinnedCircles(current.saved, current.shown.map((bot) => bot.id), movedId, targetId, place);
      if (!next) return;
      setPinnedCircleOrder(next);
      const order = rankPinnedCircles(current.shown, next);
      const position = order.findIndex((bot) => bot.id === movedId);
      setMoved(t("sidebar.section.moved", { name: order[position]!.name, position: position + 1, count: order.length }));
    },
    setDragging: setDraggingId,
    setDrop: (next) => setDrop((current) => current?.id === next?.id && current?.place === next?.place && current?.axis === next?.axis ? current : next),
  }), []);
  const dragProps = (bot: Bot): PinnedCircleDragProps => {
    if (ranked.length < 2) return {};
    const index = ranked.indexOf(bot);
    return { drag, dragging: draggingId === bot.id, drop: drop?.id === bot.id ? drop : null, prevId: ranked[index - 1]?.id, nextId: ranked[index + 1]?.id };
  };
  const frameProps = {
    onDragOver: (event: DragEvent<HTMLElement>) => { if (isCircleDrag(event)) { event.preventDefault(); event.stopPropagation(); } },
    onDrop: (event: DragEvent<HTMLElement>) => { if (isCircleDrag(event)) { event.preventDefault(); event.stopPropagation(); setDraggingId(null); setDrop(null); } },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null); },
  };
  return { ranked, dragProps, frameProps, moved };
}

export const PinnedBotCircle = memo(function PinnedBotCircle({
  threadPanelHost,
  drag,
  dragging = false,
  drop = null,
  prevId,
  nextId,
  ...props
}: BotRowProps & PinnedCircleDragProps & { threadPanelHost?: HTMLElement | null }) {
  const { bot, selected, mascotMotion, pendingQueued, reveal, density, query, dispatch, onMenu } = props;
  const showThreads = useShowThreads();
  const visible = useVisibleMessages(bot);
  const [threadsOpen, setThreadsOpen] = useSearchDisclosure(`bot:${bot.id}`, showThreads ? query : "", searchMatchesThreads(query, bot.tasks, bot.projects));
  // nonce, not the thread id: a second jump to the same thread opens it again
  useEffect(() => {
    if (reveal && showThreads) setThreadsOpen(true);
  }, [reveal?.nonce, showThreads]);
  const hasThreadList = botHasThreadList(bot, query);
  const expanded = showThreads && density !== "icons" && threadsOpen && hasThreadList;
  const activityTasks = sidebarBotActivityTasks(bot, pendingQueued);
  const waiting = bot.activity === "waiting-on-you" || activityTasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || activityTasks.some((task) => task.busy || task.activity === "working"));
  const unread = bot.unread || activityTasks.some((task) => task.unread);
  const radius = avatarCropRadius(botAvatarProfile(bot).avatarCrop);
  return (
    <div className="flex w-full min-w-0 flex-col items-center">
      <button
        type="button"
        data-sidebar-bot-row={bot.id}
        data-sidebar-pinned-circle={bot.id}
        draggable={Boolean(drag)}
        aria-current={selected ? "page" : undefined}
        aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        aria-label={`${bot.name}${waiting ? ` · ${t("sidebar.preview.waiting")}` : working ? ` · ${t("chat.activity.working")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`}
        title={bot.name}
        onClick={() => openBot(dispatch, bot, showThreads)}
        {...pinnedCircleDragHandlers(bot.id, { drag, dragging, prevId, nextId })}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex w-full min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1 text-center outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
          pinnedCircleDragClass({ drag, dragging, drop }),
        )}
      >
        <span className="relative">
          <span
            className={cn(
              "flex size-16 items-center justify-center overflow-hidden",
              selected && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
            )}
            style={{ borderRadius: radius }}
          >
            <BotAvatar
              bot={bot}
              state={stateForBot({ ...bot, messages: visible })}
              size={64}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
              animated={working || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
            />
          </span>
          {unread && (
            <span className="absolute top-0.5 right-0.5 size-2.5 rounded-full border-2 border-panel bg-accent" aria-label={t("task.unreadMany")} />
          )}
          {working && (
            <span
              data-testid="working-dot"
              className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel bg-success"
            />
          )}
          {waiting && (
            <span
              data-testid="waiting-dot"
              role="status"
              aria-label={t("sidebar.preview.waiting")}
              title={t("sidebar.preview.waiting")}
              className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel bg-warning"
            />
          )}
        </span>
        <span className="w-full truncate text-center text-[11px] leading-4 text-ink">{bot.name}</span>
      </button>
      {/* Same short slot on every circle, so a chevron on only some bots does not shift the row. */}
      {showThreads && density !== "icons" && <div className="flex h-4 w-full items-center justify-center">
        {hasThreadList && <button
          type="button"
          aria-label={t(threadsOpen ? "task.collapseNamed" : "task.expandNamed", { name: bot.name })}
          aria-expanded={threadsOpen}
          aria-controls={pinnedCircleThreadPanelId(bot.id)}
          onClick={() => setThreadsOpen((open) => !open)}
          className="flex size-4 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60"
        ><ChevronRight aria-hidden="true" size={13} className={cn("transition-transform", threadsOpen && "rotate-90")} /></button>}
      </div>}
      {expanded && threadPanelHost ? createPortal(<PinnedCircleThreadPanel {...props} />, threadPanelHost) : null}
    </div>
  );
});

function PinnedCircleGridRow({
  bots,
  columns,
  row,
  circleDrag,
}: {
  bots: Bot[];
  /** 0 until the grid has been measured: one auto-fill row is enough. */
  columns: number;
  row: (bot: Bot) => BotRowProps;
  circleDrag: (bot: Bot) => PinnedCircleDragProps;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: columns > 0 ? `repeat(${columns}, minmax(84px, 1fr))` : "repeat(auto-fill, minmax(84px, 1fr))" }}
      >
        {bots.map((bot) => <PinnedBotCircle key={bot.id} {...row(bot)} {...circleDrag(bot)} threadPanelHost={host} />)}
      </div>
      <div ref={setHost} />
    </div>
  );
}

export function PinnedCircleThreadSection({
  bots,
  collapsed,
  onToggle,
  row,
}: {
  bots: Bot[];
  collapsed: boolean;
  onToggle: () => void;
  row: (bot: Bot) => BotRowProps;
}) {
  const name = t("sidebar.section.pinned");
  const ranked = rankPinnedCircles(bots, usePinnedCircleOrder());
  return (
    <div data-sidebar-pinned-circle-threads="" className="flex flex-col gap-0.5 pt-3">
      <SidebarSectionHeader
        name={name}
        collapsed={collapsed}
        attention={collapsed ? sidebarSectionAttention(bots, []) : undefined}
        onToggle={onToggle}
        reorderable={false}
        dragging={false}
      />
      {!collapsed && ranked.map((bot) => <BotListItem key={bot.id} {...row(bot)} />)}
    </div>
  );
}

export function PinnedBotRoster({
  bots,
  density,
  circles,
  row,
  listItem: ListItem,
}: {
  bots: Bot[];
  density: SidebarDensity;
  circles: boolean;
  row: (bot: Bot) => BotRowProps;
  listItem: ComponentType<BotRowProps>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const circleLayout = circles && density !== "icons";
  const { ranked, dragProps: circleDrag, frameProps, moved } = usePinnedCircleDrag(bots);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || !circleLayout) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [circleLayout]);
  if (!circleLayout) {
    return (
      <>
        {ranked.map((bot) => <ListItem key={bot.id} {...row(bot)} />)}
      </>
    );
  }
  const columns = width > 0 ? pinnedCircleColumns(width) : 0;
  const circleRows = columns > 0 ? chunkPinnedCircles(ranked, columns) : [ranked];
  return (
    <div className="px-1 pb-1">
      <div ref={frame} data-sidebar-pinned-circles="" className="flex flex-col gap-1" {...frameProps}>
        {circleRows.map((rowBots) => (
          <PinnedCircleGridRow key={rowBots.map((bot) => bot.id).join("\0")} bots={rowBots} columns={columns} row={row} circleDrag={circleDrag} />
        ))}
      </div>
      <span role="status" className="sr-only">{moved}</span>
    </div>
  );
}
