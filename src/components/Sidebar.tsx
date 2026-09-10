import { track } from "@/lib/analytics";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  BellDot,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Crown,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, visibleMessages, currentTaskBot, type AppState, type Bot, type Group } from "@/state/store";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { WorkingDots } from "./WorkingIndicator";
import { nextRename } from "@/lib/rename";
import { downloadAllBots } from "@/lib/team-files";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import { BotProjectDialog, FolderActions, FolderIcon, navigateThreadMenu, NewThreadButton } from "./BotProjects";
import { draggedFolder, FOLDER_DRAG_TYPE, moveFolder, placeFolder } from "@/lib/folder-order";
import { folderUnreadThreadIds, markFolderRead } from "@/lib/folder-read";
import { SidebarThreadRow, visibleSidebarThreads } from "./SidebarThreadRow";
import {
  loadCollapsedSections,
  loadRowOrder,
  loadSectionOrder,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_EXPANDED_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  clampSidebarWidth,
  loadSidebarDensity,
  loadSidebarWidth,
  saveCollapsedSections,
  saveRowOrder,
  saveSectionOrder,
  saveSidebarDensity,
  saveSidebarWidth,
  sidebarIsRail,
  widthForDensity,
  toggleCollapsedSection,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveRowWithinList,
  orderedSidebarRows,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sameSectionOrder,
  sidebarGoalRunPreview,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarStamp,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { botListItemPointerIntent } from "@/lib/sidebar-selection";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarMoreMenu } from "./SidebarMoreMenu";
import { profileInitials, SidebarProfileMenu } from "./SidebarProfileMenu";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { useShowThreads } from "@/lib/thread-preferences";
import { SidebarBotActivity, sidebarBotActivityTasks } from "./SidebarBotActivity";

const SECTION_LABEL_KEYS: Record<string, LocaleKey> = {
  [PINNED_SECTION_ID]: "sidebar.section.pinned",
  [CHANNELS_SECTION_ID]: "sidebar.section.channels",
  [BOT_CHATS_SECTION_ID]: "sidebar.section.botChats",
  [BOTS_SECTION_ID]: "sidebar.section.bots",
};

/** The four built-in section names come from the catalog; a section someone
 * named themselves is their text and stays exactly as typed. */
function sectionLabel(id: string): string {
  const key = SECTION_LABEL_KEYS[id];
  return key ? t(key) : sidebarSectionLabel(id);
}

function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return t("sidebar.preview.waiting");
  if (bot.busy) return t("sidebar.preview.working");
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return t("sidebar.preview.screenFrame");
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return t("sidebar.preview.botWorking", {
      name: bots.find((b) => b.id === group.busyBotId)?.name ?? t("sidebar.preview.aBot"),
    });
  }
  if (group.working) return t("sidebar.preview.teamWorking");
  const last = group.messages.at(-1);
  if (!last) return t("sidebar.preview.noMessages");
  const text = last.kind === "activity" && last.tool
    ? last.tool.name
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : (last.text ?? "");
  if (last.role === "user") return t("sidebar.preview.you", { text });
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** A small member stack identifies a group without turning it into a card. */
function StackedMauses({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-7" : "size-8";
  const singleSize = iconOnly ? 44 : density === "compact" ? 26 : 32;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 2);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-2.5">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={iconOnly ? 30 : 20} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-4 items-center justify-center rounded-full border border-hairline/40 bg-raised text-[9px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

export function GroupListItem({
  group,
  density,
  query = "",
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  query?: string;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const [threadsOpen, setThreadsOpen] = useState(selected || Boolean(query));
  useEffect(() => { if (selected || query) setThreadsOpen(true); }, [selected, query]);
  const expanded = !group.dm && threadsOpen && density !== "icons";
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <>
    <div className="group relative">
    <button
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
        density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-1.5 py-1 pl-6 pr-2" : "gap-2 py-1.5 pl-6 pr-2",
        selected && !expanded ? "bg-raised/70" : "hover:bg-raised/40",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedMauses members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{group.name}</span>
          {selected && last && !expanded && <span className="shrink-0 text-[10px] text-ink-secondary">{sidebarStamp(last.at)}</span>}
          {expanded && group.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
        </div>
        {!expanded && <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>}
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
    {!group.dm && density !== "icons" && <button type="button" aria-label={t(expanded ? "task.collapseNamed" : "task.expandNamed", { name: group.name })} aria-expanded={expanded}
      onClick={() => setThreadsOpen((open) => !open)} className="absolute left-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
      <ChevronRight aria-hidden="true" size={12} className={cn("transition-transform", expanded && "rotate-90")} />
    </button>}
    </div>
    {expanded && <GroupThreadList group={group} selected={selected} density={density} query={group.name.toLowerCase().includes(query.toLowerCase()) ? "" : query} />}
    </>
  );
}

/** Scroll the row of a thread the person asked to open into view, once the
 * switch has landed and that thread is the one on screen. `block: nearest`
 * keeps an already-visible row still. */
function useRevealedThreadRow(reveal: AppState["revealThread"], currentThreadId: string | null) {
  useEffect(() => {
    if (!reveal || reveal.threadId !== currentThreadId) return;
    const row = document.querySelector<HTMLElement>(`[data-sidebar-thread-row="${CSS.escape(reveal.threadId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [reveal, currentThreadId]);
}

export function GroupThreadList({ group, selected, density = "comfortable", query = "" }: { group: Group; selected: boolean; density?: SidebarDensity; query?: string }) {
  const { state, dispatch } = useStore();
  const [showAll, setShowAll] = useState(false);
  const busy = Boolean(group.working || group.busyBotId);
  const waiting = state.bots.find((bot) => bot.id === group.busyBotId)?.activity === "waiting-on-you";
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => ({
    ...task, busy: task.threadId === group.threadId && busy, unread: task.threadId === group.threadId && group.unread,
    activity: task.threadId === group.threadId && waiting ? "waiting-on-you" as const : undefined,
  }));
  const visible = visibleSidebarThreads(tasks, group.threadId, query, [], showAll);
  useRevealedThreadRow(state.revealThread, selected ? group.threadId : null);
  return <div className="mb-2 ml-5 space-y-0.5 border-l border-hairline/30 pl-2" role="group" aria-label={t("task.namedList", { name: group.name })}>
    {visible.map((task) => <SidebarThreadRow key={task.threadId} task={task} current={selected && task.threadId === group.threadId} compact={density === "compact"}
      onSelect={() => { if (task.threadId !== group.threadId) dispatch({ type: "switchGroupTask", groupId: group.id, threadId: task.threadId }); else dispatch({ type: "select", id: group.id }); }}
      onRename={(title) => dispatch({ type: "renameGroupTask", groupId: group.id, threadId: task.threadId, title })}
      onDelete={() => dispatch({ type: "deleteGroupTask", groupId: group.id, threadId: task.threadId })} />)}
    {!query && !showAll && tasks.length > visible.length && <button type="button" onClick={() => setShowAll(true)} className="px-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">{t("task.showAll", { count: tasks.length })}</button>}
    <button type="button" disabled={busy} onClick={() => dispatch({ type: "newGroupTask", groupId: group.id })} title={t(busy ? "task.newBusy" : "task.newShort")}
      className="mt-1 flex min-h-8 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-raised/40 hover:text-ink disabled:opacity-40"><Plus size={12} />{t("task.newShort")}</button>
  </div>;
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
  moveList = [],
  onMoveRow = () => {},
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
  /** ids of the list this group reorders inside, in render order */
  moveList?: string[];
  onMoveRow?: (direction: -1 | 1) => void;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const position = moveList.indexOf(group.id);
  const canReorder = position >= 0 && moveList.length > 1;
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 204 - (canReorder ? 80 : 0)));
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60"
    >
      {!remoteClient && (renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("sidebar.room.renameAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? t("sidebar.room.saveChatName") : t("sidebar.room.saveChannelName")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? t("sidebar.room.cancelChatRename") : t("sidebar.room.cancelChannelRename")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          {isBotChat ? t("sidebar.room.renameChat") : t("sidebar.room.renameChannel")}
        </button>
      ))}
      {canReorder && (
        <>
          <button
            onClick={() => {
              onMoveRow(-1);
              onClose();
            }}
            disabled={position === 0}
            className={cn(
              "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink",
              position === 0 ? "cursor-default opacity-40" : "hover:bg-raised/70",
            )}
          >
            <ArrowUp size={16} className="text-ink-secondary" />
            {t("sidebar.bot.moveUp")}
          </button>
          <button
            onClick={() => {
              onMoveRow(1);
              onClose();
            }}
            disabled={position === moveList.length - 1}
            className={cn(
              "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink",
              position === moveList.length - 1 ? "cursor-default opacity-40" : "hover:bg-raised/70",
            )}
          >
            <ArrowDown size={16} className="text-ink-secondary" />
            {t("sidebar.bot.moveDown")}
          </button>
        </>
      )}
      {!remoteClient && !isBotChat && (
        <button
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <FolderPlus size={16} className="text-ink-secondary" />
          {t("sidebar.section.moveToContext")}
        </button>
      )}
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("sidebar.copyConversationId")}
      </button>
      {!remoteClient && <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        {isBotChat ? t("sidebar.room.deleteChat") : t("sidebar.room.deleteChannel")}
      </button>}
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">{t("sidebar.newChannel.title")}</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("sidebar.newChannel.name")}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("sidebar.newChannel.context")}
          aria-label={t("sidebar.newChannel.contextAria")}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint={t("sidebar.newChannel.emptyHint")}
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {picked.size === 0
            ? t("sidebar.newChannel.create")
            : picked.size === 1
              ? t("sidebar.newChannel.createOne")
              : t("sidebar.newChannel.createMany", { count: picked.size })}
        </button>
      </div>
    </div>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
/** A heading's own menu: rename the context, step it up or down, or take the
 * label off. Built-in headings (Pinned, Groups, Bot threads, Bots) are derived
 * from bot state rather than typed by anyone, so they get only the two moves. */
function SectionContextMenu({
  menu,
  label,
  editable,
  canMoveUp,
  canMoveDown,
  onClose,
  onMove,
  onRename,
  onDelete,
}: {
  menu: { id: string; x: number; y: number };
  label: string;
  /** built-in headings (Pinned, Groups, Bots…) are not user labels */
  editable: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onClose: () => void;
  onMove: (direction: -1 | 1) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const saveRename = () => {
    const name = nextRename(label, draft);
    if (name) onRename(name);
    onClose();
  };
  const row = (disabled: boolean) =>
    cn(
      "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink",
      disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
    );
  const top = Math.min(menu.y, window.innerHeight - 200);
  const left = Math.min(menu.x, window.innerWidth - 240);

  return createPortal(
    <div
      data-section-menu
      data-sidebar
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60"
    >
      {editable && (renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={60}
            aria-label={t("sidebar.section.renameContextAria", { name: label })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={t("common.save")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(label);
            setRenaming(true);
          }}
          className={row(false)}
        >
          <Pencil size={16} className="text-ink-secondary" />
          {t("sidebar.section.renameContext")}
        </button>
      ))}
      <button onClick={() => { onMove(-1); onClose(); }} disabled={!canMoveUp} className={row(!canMoveUp)}>
        <ArrowUp size={16} className="text-ink-secondary" />
        {t("sidebar.bot.moveUp")}
      </button>
      <button onClick={() => { onMove(1); onClose(); }} disabled={!canMoveDown} className={row(!canMoveDown)}>
        <ArrowDown size={16} className="text-ink-secondary" />
        {t("sidebar.bot.moveDown")}
      </button>
      {editable && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => {
              onDelete();
              onClose();
            }}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
          >
            <Trash2 size={16} />
            {t("sidebar.section.deleteContext")}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-2 shadow-2xl shadow-black/60"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        {t("sidebar.section.moveToContext")}
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sidebar.section.newContext")}
          aria-label={t("sidebar.section.newContextAria")}
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          {t("common.add")}
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            {t("sidebar.section.removeFromContext")}
          </button>
        </>
      )}
    </div>
  );
}

export function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onDelete,
  onMoveToSection,
  onNewFolder,
  moveList = [],
  onMoveRow = () => {},
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onDelete: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
  /** ids of the list this bot reorders inside, in render order */
  moveList?: string[];
  onMoveRow?: (direction: -1 | 1) => void;
  onNewFolder: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const bot = state.bots.find((b) => b.id === menu.botId);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const place = () => {
      const { width, height } = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
    };
    // Menu length changes with thread settings, permissions, and locale.
    // Measure after every render; the viewport cap handles short windows.
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const deleting = state.deletingBots[bot.id] === true;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const position = moveList.indexOf(bot.id);
  const canReorder = position >= 0 && moveList.length > 1;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? t("sidebar.bot.archiveBlockedChief")
    : visibleBotCount <= 1
      ? t("sidebar.bot.archiveBlockedLast")
      : undefined;
  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return createPortal(
    <div
      ref={menuRef}
      data-bot-menu
      data-sidebar
      role="menu"
      aria-label={t("sidebar.bot.actions", { name: bot.name })}
      onKeyDown={navigateThreadMenu}
      style={{ top: menu.y, left: menu.x }}
      className="fixed z-40 max-h-[calc(100dvh-16px)] w-[228px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60"
    >
      {showThreads && <>
        {item(<Plus size={16} className="text-ink-secondary" />, t("task.newShort"), () => dispatch({ type: "newTask", botId: bot.id }))}
        {item(<FolderPlus size={16} className="text-ink-secondary" />, t("folder.new"), () => onNewFolder(bot.id))}
        {divider("threads")}
      </>}
      {remoteClient ? [
        item(<FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.bot.moveToSection"), () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.editProfile"), () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
      ] : [
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? t("sidebar.bot.unpin") : t("sidebar.bot.pin"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? t("sidebar.bot.removeChief") : t("sidebar.bot.makeChief"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? t("sidebar.bot.chiefNeedsEngine") : undefined,
          },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.bot.moveToSection"), () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        // For the people who never discover that a row is draggable.
        ...(canReorder ? [
          item(<ArrowUp size={16} className="text-ink-secondary" />, t("sidebar.bot.moveUp"), () => onMoveRow(-1), {
            disabled: position === 0,
          }),
          item(<ArrowDown size={16} className="text-ink-secondary" />, t("sidebar.bot.moveDown"), () => onMoveRow(1), {
            disabled: position === moveList.length - 1,
          }),
        ] : []),
        item(<BellDot size={16} className="text-ink-secondary" />, t("sidebar.bot.markUnread"), () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.editProfile"), () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true, section: "identity" });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, t("sidebar.bot.duplicate"), () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          t("sidebar.bot.archive"),
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        <BotDeleteMenuItem
          key="delete"
          deleting={deleting}
          onClick={() => {
            onClose();
            onDelete(bot);
          }}
        />,
      ]}
    </div>,
    document.body,
  );
}

export type BotConfirmKind = "archive" | "delete";

/** A confirmation may span live fleet updates; never authorize from its snapshot. */
export function currentArchivableBot(bots: readonly Bot[], id: string): Bot | undefined {
  const active = bots.filter((candidate) => !candidate.hidden);
  if (active.length <= 1) return undefined;
  return active.find((candidate) => candidate.id === id && !candidate.chiefOfStaff);
}

/** Copy for the archive / delete confirmation dialogs. Archiving keeps
 * everything and is reversible from Archived bots; deleting is not — the
 * server drops every task transcript, the workspace (files + memory), and
 * staged skill state with the bot. */
export function botConfirmCopy(kind: BotConfirmKind, name: string) {
  return kind === "archive"
    ? {
        title: t("sidebar.confirm.archiveTitle", { name }),
        body: t("sidebar.confirm.archiveBody", { name }),
        confirmLabel: t("sidebar.bot.archive"),
        tone: "neutral" as const,
      }
    : {
        title: t("sidebar.confirm.deleteTitle", { name }),
        body: t("sidebar.confirm.deleteBody", { name }),
        confirmLabel: t("common.delete"),
        tone: "danger" as const,
      };
}

export function BotDeleteMenuItem({ deleting, onClick }: { deleting: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={deleting}
      aria-busy={deleting || undefined}
      onClick={onClick}
      title={deleting ? t("sidebar.bot.deleteCheckingTitle") : undefined}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger",
        deleting ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      {deleting ? t("sidebar.bot.deleteChecking") : t("common.delete")}
    </button>
  );
}

export function BotThreadList({ bot, selected, density = "comfortable", query = "", hidden = false }: { bot: Bot; selected: boolean; density?: SidebarDensity; query?: string; hidden?: boolean }) {
  const { state, dispatch } = useStore();
  const tasks = (bot.tasks ?? [{ threadId: bot.threadId, title: t("task.newShort"), createdAt: 0 }])
    .filter((task) => !task.routineRunId)
    .map((task) => ({ ...task, queued: Boolean(state.pendingQueued[task.threadId]?.length) }));
  const projects = bot.projects ?? [];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ projectId: string; left: number; top: number } | null>(null);
  const [markingRead, setMarkingRead] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readStatus, setReadStatus] = useState("");
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [reorderStatus, setReorderStatus] = useState("");
  const [folderDrop, setFolderDrop] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const draggingFolder = useRef<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const currentProjectId = tasks.find((task) => task.threadId === bot.threadId)?.projectId;
  useEffect(() => {
    if (selected && currentProjectId) setCollapsed((previous) => {
      if (!previous.has(currentProjectId)) return previous;
      const next = new Set(previous);
      next.delete(currentProjectId);
      return next;
    });
  }, [selected, currentProjectId]);
  const visibleTasks = visibleSidebarThreads(tasks, bot.threadId, query, projects, showAll);
  useRevealedThreadRow(state.revealThread, selected ? bot.threadId : null);
  const renderThread = (task: (typeof tasks)[number]) => {
    const thread = currentTaskBot(bot, task.threadId);
    return <SidebarThreadRow key={task.threadId} task={{ ...task, busy: thread.busy, activity: thread.activity }} current={selected && task.threadId === bot.threadId} compact={density === "compact"} folders={projects}
      onSelect={() => { if (task.threadId !== bot.threadId) dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId }); else dispatch({ type: "select", id: bot.id }); }}
      onRename={(title) => dispatch({ type: "renameTask", botId: bot.id, threadId: task.threadId, title })}
      onDelete={() => dispatch({ type: "deleteTask", botId: bot.id, threadId: task.threadId })}
      onMove={(projectId) => dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { projectId } })} />;
  };
  const ungrouped = visibleTasks.filter((task) => !projects.some((project) => project.id === task.projectId));
  const projectToEdit = projects.find((project) => project.id === editingProject);
  const projectIds = projects.map((project) => project.id);
  const saveOrder = (ids: string[], onSaved?: () => void) => {
    if (reordering || ids.every((id, index) => id === projectIds[index])) return;
    setReordering(true); setReorderError(null); setReorderStatus(t("folder.reordering"));
    dispatch({ type: "reorderProjects", botId: bot.id, projectIds: ids,
      onSaved: () => { setReordering(false); setReorderStatus(t("folder.reordered")); onSaved?.(); },
      onError: (message) => { setReordering(false); setReorderStatus(""); setReorderError(message); } });
  };
  const resetFolderDrag = () => { draggingFolder.current = null; setFolderDrop(null); };
  const readFolder = async (projectId: string, onSaved: () => void) => {
    if (markingRead) return;
    setMarkingRead(true); setReadError(null); setReadStatus(t("folder.markingRead"));
    try {
      await markFolderRead(bot, projectId, api, (updated) => dispatch({ type: "botPatched", bot: updated }));
      setReadStatus(t("folder.markedRead"));
      onSaved();
    } catch (error) {
      setReadError(error instanceof Error ? error.message : String(error));
      setReadStatus("");
    } finally { setMarkingRead(false); }
  };
  return (
    <div hidden={hidden} className="mb-2 ml-5 space-y-0.5 border-l border-hairline/30 pl-2" role="group" aria-label={t("task.namedList", { name: bot.name })}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) event.stopPropagation(); }}
      onDrop={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) { event.preventDefault(); event.stopPropagation(); resetFolderDrag(); } }}>
      {!hidden && <>
      {projects.map((project, index) => {
        const projectTasks = tasks.filter((task) => task.projectId === project.id);
        const visible = visibleTasks.filter((task) => task.projectId === project.id);
        if (query && visible.length === 0 && !project.name.toLowerCase().includes(query.toLowerCase())) return null;
        const open = Boolean(query) || !collapsed.has(project.id);
        const waiting = projectTasks.some((task) => task.activity === "waiting-on-you");
        const working = projectTasks.some((task) => task.busy);
        return <div key={project.id} data-sidebar-project={project.id}>
          <div data-sidebar-folder-row={project.id} draggable={!reordering}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setFolderMenu({ projectId: project.id, left: event.clientX, top: event.clientY }); }}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify({ botId: bot.id, projectId: project.id }));
              draggingFolder.current = project.id;
            }}
            onDragEnd={(event) => { event.stopPropagation(); resetFolderDrag(); }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
              event.stopPropagation();
              if (!draggingFolder.current || reordering) { event.dataTransfer.dropEffect = "none"; return; }
              event.preventDefault(); event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              setFolderDrop({ id: project.id, place: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
            }}
            onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFolderDrop(null); }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
              event.preventDefault(); event.stopPropagation();
              const from = draggedFolder(event.dataTransfer.getData(FOLDER_DRAG_TYPE), bot.id, projectIds);
              const rect = event.currentTarget.getBoundingClientRect();
              if (from) saveOrder(placeFolder(projectIds, from, project.id, event.clientY < rect.top + rect.height / 2 ? "before" : "after"));
              resetFolderDrag();
            }}
            className={cn("group/folder flex items-center gap-0.5 rounded-md text-ink-secondary hover:bg-raised/30",
              folderDrop?.id === project.id && draggingFolder.current !== project.id && (folderDrop.place === "before" ? "shadow-[0_-2px_var(--color-accent)]" : "shadow-[0_2px_var(--color-accent)]"))}>
            <button type="button" aria-expanded={open} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
              return next;
            })} className="flex size-6 shrink-0 items-center justify-center rounded outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60" aria-label={t(open ? "task.collapseNamed" : "task.expandNamed", { name: project.name })}>
              <ChevronRight aria-hidden="true" size={11} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            </button>
            <button type="button" aria-label={t("folder.iconNamed", { name: project.name })} title={t("folder.iconNamed", { name: project.name })} onClick={() => setEditingProject(project.id)} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-raised"><FolderIcon emoji={project.emoji} size={14} /></button>
            <button type="button" data-sidebar-folder-label={project.id} draggable={!reordering} aria-expanded={open} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
              return next;
            })} className="flex min-h-8 min-w-0 flex-1 cursor-grab select-none items-center gap-1.5 py-1 text-left text-[13px] font-semibold active:cursor-grabbing" title={project.name}>
              <span className="truncate">{project.name}</span>
              <span className="shrink-0 text-[10px] font-normal opacity-50">{projectTasks.length}</span>
              {!open && (waiting ? <span className="text-[10px] text-warning">{t("task.waiting")}</span> : working ? <Loader2 size={10} className="shrink-0 animate-spin text-success" /> : projectTasks.some((task) => task.unread) ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} /> : null)}
            </button>
            <button type="button" title={t("task.newIn", { name: project.name })} aria-label={t("task.newIn", { name: project.name })} onClick={() => dispatch({ type: "newTask", botId: bot.id, projectId: project.id })}
              className="flex size-6 items-center justify-center rounded opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/folder:opacity-100 max-md:opacity-70"><Plus size={12} /></button>
            <FolderActions project={project} canMoveUp={index > 0} canMoveDown={index < projects.length - 1} canMarkRead={folderUnreadThreadIds(bot, project.id).length > 0} saving={reordering || markingRead}
              menu={folderMenu?.projectId === project.id ? folderMenu : null} onMenuChange={(menu) => setFolderMenu(menu ? { ...menu, projectId: project.id } : null)}
              onEdit={() => setEditingProject(project.id)} onMove={(direction, onSaved) => saveOrder(moveFolder(projectIds, project.id, direction), onSaved)}
              onMarkRead={(onSaved) => { void readFolder(project.id, onSaved); }} />
          </div>
          {open && <div className="ml-3 border-l border-hairline/25 pl-2" role="group" aria-label={t("task.namedList", { name: project.name })}>
            {visible.map(renderThread)}
            {projectTasks.length === 0 && <p className="px-2.5 py-1 text-[11px] text-ink-secondary/70">{t("task.empty")}</p>}
          </div>}
        </div>;
      })}
      {reorderError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{reorderError}</p>}
      <span role="status" className="sr-only">{reorderStatus}</span>
      {readError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{readError}</p>}
      <span role="status" className="sr-only">{readStatus}</span>
      {projects.length > 0 && ungrouped.length > 0 && <div className="px-3 pb-1 pt-2 text-[10.5px] text-ink-secondary/70">{t("task.list")}</div>}
      {ungrouped.map(renderThread)}
      {!query && !showAll && tasks.length > visibleTasks.length && <button type="button" onClick={() => setShowAll(true)} className="px-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">{t("task.showAll", { count: tasks.length })}</button>}
      <NewThreadButton bot={bot} className="mt-1 w-full rounded-md" />
      {projectToEdit && <BotProjectDialog bot={bot} project={projectToEdit} onClose={() => setEditingProject(null)} />}
      </>}
    </div>
  );
}

export function BotListItem({
  bot,
  density,
  query = "",
  onMenu,
}: {
  bot: Bot;
  density: SidebarDensity;
  query?: string;
  onMenu: (menu: MenuState) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const [threadsOpen, setThreadsOpen] = useState(Boolean(query));
  useEffect(() => { if (query && showThreads) setThreadsOpen(true); }, [query, showThreads]);
  // a thread opened from a chip or #Title link: unfold this bot so the row
  // it lands on is on screen (BotThreadList scrolls it into view)
  const reveal = state.revealThread;
  const revealHere = Boolean(reveal && (bot.threadId === reveal.threadId || bot.tasks?.some((task) => task.threadId === reveal.threadId)));
  useEffect(() => { if (revealHere && showThreads) setThreadsOpen(true); }, [reveal, revealHere, showThreads]);
  const deleting = state.deletingBots[bot.id] === true;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const iconOnly = density === "icons";
  const expanded = showThreads && !iconOnly && threadsOpen;
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? (showThreads ? 26 : 40) : (showThreads ? 32 : 56);
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  // the role from Bot Settings → Title. A badge or tooltip beside the name
  // (#866, #871) always traded the name's width against the title's; its own
  // line above the name lets both truncate independently instead.
  const title = bot.title.trim();
  const rowClass = cn(
    "flex w-full items-center rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? cn(showThreads ? "gap-1.5 py-1" : "gap-2 py-1.5", showThreads ? "pl-6 pr-9 group-hover:pr-16 group-focus-within:pr-16 max-md:pr-16" : "pl-2 pr-9")
        : cn(showThreads ? "gap-2 py-2" : "gap-3 py-2.5", showThreads ? "pl-6 pr-9 group-hover:pr-16 group-focus-within:pr-16 max-md:pr-16" : "pl-2 pr-9"),
    // Chief of Staff is called out by the crown label below, not by tinting
    // the whole row — an accent border + fill read as "selected" even when
    // another bot was active.
    selected ? "bg-raised/70" : "hover:bg-raised/40",
  );
  const activityTasks = sidebarBotActivityTasks(bot, state.pendingQueued);
  const waiting = bot.activity === "waiting-on-you" || activityTasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || activityTasks.some((task) => task.busy || task.activity === "working"));
  const queued = activityTasks.some((task) => task.queued);
  const unread = bot.unread || activityTasks.some((task) => task.unread);
  const body = (
    <>
      {/* flex, not inline: an inline wrapper adds a baseline gap under the
          avatar and makes the row taller than before the presence dot */}
      <span className="relative flex shrink-0">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={avatarSize}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          // Motion means something is happening. A resting bot holds a resting
          // pose — N idle rows bobbing at display rate was most of the app's
          // visible-idle CPU (states are keyword-derived, so "working" can be
          // decorative; busy/unread/motion are the real signals).
          animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {working && (
          // presence dot: green while the bot is working, ringed in the row's
          // ground so it reads on both a photo and the mascot. Also the only
          // activity signal in icons-only density, where the text is hidden.
          <span
            data-testid="working-dot"
            className={cn(
              "absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-success",
              iconOnly ? "size-3" : "size-2.5",
            )}
          />
        )}
        {waiting && <span data-testid="waiting-dot" role="status" aria-label={t("sidebar.preview.waiting")} title={t("sidebar.preview.waiting")}
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-warning", iconOnly ? "size-3" : "size-2.5")} />}
        {!waiting && !working && queued && <span data-testid="queued-dot" role="status" aria-label={t("task.queued")} title={t("task.queued")}
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-ink-secondary", iconOnly ? "size-3" : "size-2.5")} />}
      </span>
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        {title && !renaming && (
          // Its own line above the name: a badge or tooltip beside the name
          // (#866, #871) always traded the name's width against the title's —
          // stacking the two removes the competition entirely, so both can
          // truncate independently against the full row width.
          <div className="truncate text-[11px] font-medium leading-4 text-ink-secondary">{title}</div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 grow items-center gap-1.5 truncate text-[14px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => {
                if (remoteClient) {
                  void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                    .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                    .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
                } else {
                  dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
                }
              }}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[14px] font-semibold"
            />
          </span>
          {selected && last && !renaming && !expanded && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {sidebarStamp(last.at)}
            </span>
          )}
          {expanded && unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
        </div>
        {bot.chiefOfStaff && !renaming && (
          // Chief of Staff gets its own line under the name so a long name
          // and the title badge keep the full width of the name line.
          <span className="flex items-center gap-1 text-[11.5px] font-medium leading-4 text-accent">
            <Crown size={11} className="shrink-0" /> {t("sidebar.bot.chiefOfStaff")}
          </span>
        )}
        {(!expanded || deleting) && <div className="flex items-center justify-between gap-2">
          {deleting ? (
            <span role="status" className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-secondary">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              {t("sidebar.bot.deletingRow")}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-secondary">
              {working ? (
                // the same typing dots as the chat header; sized to the text's
                // line box so the row does not jump when work starts or ends
                <span className="flex h-[1.5em] items-center" role="status">
                  <WorkingDots size={3.5} />
                  <span className="sr-only">{t("sidebar.preview.working")}</span>
                </span>
              ) : (
                <span className="truncate">{waiting ? t("sidebar.preview.waiting") : queued ? t("task.queued") : preview(bot)}</span>
              )}
            </span>
          )}
          {unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />
          )}
        </div>}
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };
  const onSelect = (event: React.MouseEvent) => {
    if (renaming) return;
    const insideRenameInput = event.target instanceof HTMLInputElement;
    if (botListItemPointerIntent(event.type, insideRenameInput) === "select") {
      dispatch({ type: "select", id: bot.id });
    }
  };

  return (
    <>
    <div className="group relative" title={iconOnly ? bot.name : undefined}>
      {/* Keep this wrapper mounted while RenameTitle swaps its label for an
          input. Replacing the wrapper tree remounts RenameTitle, loses its
          editing state, and leaves the row stuck in rename mode. Omitting
          role=button also keeps the input visible to assistive technology. */}
      <div
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={
          !renaming && iconOnly
            ? deleting
              ? t("sidebar.bot.deletingAria", { name: bot.name })
              : `${bot.name}${waiting ? ` · ${t("sidebar.preview.waiting")}` : working ? ` · ${t("chat.activity.working")}` : queued ? ` · ${t("task.queued")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`
            : undefined
        }
        aria-busy={deleting || undefined}
        data-sidebar-bot-row={bot.id}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (renaming) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {showThreads && !iconOnly && <button
        type="button"
        aria-label={t(threadsOpen ? "task.collapseNamed" : "task.expandNamed", { name: bot.name })}
        aria-expanded={threadsOpen}
        onClick={() => setThreadsOpen((open) => !open)}
        className="absolute left-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60"
      ><ChevronRight aria-hidden="true" size={13} className={cn("transition-transform", threadsOpen && "rotate-90")} /></button>}
      {!renaming && iconOnly && unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {!renaming && !deleting && !iconOnly && <>
        {showThreads && <button type="button" aria-label={t("folder.newNamed", { name: bot.name })} title={t("folder.new")} onClick={() => { setThreadsOpen(true); setCreatingProject(true); }}
          className="pointer-events-none absolute right-8 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70"><FolderPlus size={14} /></button>}
        <button type="button" aria-label={t("sidebar.bot.actions", { name: bot.name })} title={t("sidebar.bot.actions", { name: bot.name })} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ botId: bot.id, x: rect.left, y: rect.bottom }); }}
          className="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70"><MoreHorizontal size={15} /></button>
      </>}
      {deleting && iconOnly && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-card p-1 text-ink-secondary">
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
    </div>
    {/* Keep folder expansion state mounted while the preference is off. The
        hidden list omits its children, including any thread-menu portals. */}
    {!iconOnly && threadsOpen && <BotThreadList bot={bot} selected={selected} density={density} hidden={!showThreads} query={bot.name.toLowerCase().includes(query.toLowerCase()) || bot.title.toLowerCase().includes(query.toLowerCase()) ? "" : query} />}
    {!expanded && <SidebarBotActivity bot={bot} density={density} />}
    {showThreads && creatingProject && <BotProjectDialog bot={bot} onClose={() => setCreatingProject(false)} />}
    </>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(t("sidebar.archived.restored", { name: bot.name }));
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(
        bots.length === 1
          ? t("sidebar.archived.restoredOne")
          : t("sidebar.archived.restoredMany", { count: bots.length }),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{t("sidebar.archived.title")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("sidebar.archived.subtitle")}</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                {t("sidebar.archived.restoreAll")}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label={t("sidebar.archived.close")}
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{t("sidebar.archived.count", { count: bots.length })}</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} state="happy" size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || t("sidebar.archived.botFallback")}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  {t("sidebar.archived.restore")}
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<{ kind: BotConfirmKind; bot: Bot } | null>(null);
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [newFolderBotId, setNewFolderBotId] = useState<string | null>(null);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);
  // Density is the shape of a row; width is how much room the column gives it.
  // They meet at the rail: drag far enough left and the sidebar becomes the
  // "icons" density, so the rail stays reachable from the handle and the menu.
  const [width, setWidthState] = useState<number>(() => loadSidebarWidth());
  // What the collapse button restores. Someone who dragged to 420 and folded
  // the sidebar away expects 420 back, not the default.
  const [lastExpandedWidth, setLastExpandedWidth] = useState<number>(() => {
    const saved = loadSidebarWidth();
    return sidebarIsRail(saved) ? SIDEBAR_DEFAULT_WIDTH : saved;
  });
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ x: number; width: number } | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  // Row order is one flat list for the whole sidebar; a drag only ever moves
  // a row next to another row in the same list, so the section it belongs to
  // — which is a team boundary, not decoration — can never change here.
  const [rowOrder, setRowOrder] = useState<string[]>(() => loadRowOrder());
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [rowDropTarget, setRowDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const rowDragRef = useRef<{
    from: string | null;
    list: string[];
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, list: [], over: null });
  const [sectionMenu, setSectionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sectionConfirm, setSectionConfirm] = useState<{ id: string; name: string; count: number } | null>(null);
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });

  const applyWidth = (next: number, persist: boolean) => {
    setWidthState(next);
    if (!sidebarIsRail(next)) setLastExpandedWidth(next);
    if (persist) saveSidebarWidth(next);
  };

  const setDensity = (next: SidebarDensity, nextWidth = widthForDensity(next)) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    applyWidth(next === "icons" ? SIDEBAR_RAIL_WIDTH : nextWidth, true);
    setDensityOpen(false);
  };

  /** The drag writes the width; crossing the snap point is what switches the
   * density, so a drag and the menu cannot disagree about the rail. */
  const setWidth = (value: number, persist: boolean) => {
    const clamped = clampSidebarWidth(value);
    const wantsRail = sidebarIsRail(clamped);
    if (wantsRail !== (density === "icons")) {
      setDensityState(wantsRail ? "icons" : lastExpandedDensity);
      if (wantsRail) setQuery("");
      saveSidebarDensity(wantsRail ? "icons" : lastExpandedDensity);
    }
    applyWidth(clamped, persist);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity, lastExpandedWidth);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // The same drag ComputerPanel.tsx uses on its own edge, mirrored: pointer
  // capture so the pointer may leave the handle, and one write to storage on
  // release rather than one per frame.
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = { x: event.clientX, width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragFrom.current) return;
    setWidth(dragFrom.current.width + (event.clientX - dragFrom.current.x), false);
  };
  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    dragFrom.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    // From the event, not from `width`: a pointerup in the same frame as the
    // last move would otherwise persist the width before that move.
    setWidth(from.width + (event.clientX - from.x), true);
  };
  // A pointer-only separator is unusable without a mouse. A step of 16px would
  // never cross the dead zone on its own, so the two edges of it are jumps:
  // one press leaves the rail, one press collapses back to it.
  const onResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    if (density === "icons") {
      if (step > 0) setWidth(SIDEBAR_MIN_EXPANDED_WIDTH, true);
      return;
    }
    setWidth(width <= SIDEBAR_MIN_EXPANDED_WIDTH && step < 0 ? SIDEBAR_RAIL_WIDTH : width + step, true);
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open || confirm) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, confirm]);

  useEffect(() => {
    if (!densityOpen) return;
    const closeDensityMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDensityOpen(false);
    };
    window.addEventListener("keydown", closeDensityMenu);
    return () => window.removeEventListener("keydown", closeDensityMenu);
  }, [densityOpen]);

  useEffect(() => {
    if (remoteClient) return;
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, [remoteClient]);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", { members: exported.members, scope: "backup" });
      setTeamFeedback({
        error: false,
        text: [
          t("sidebar.backup.downloaded", { members: exported.members }),
          exported.warnings.length ? t("sidebar.backup.notes", { count: exported.warnings.length }) : "",
          t("sidebar.backup.private"),
        ]
          .filter(Boolean)
          .join(" "),
      });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };


  // Archive and delete share one pending confirmation at a time.
  const requestArchive = (bot: Bot) => {
    const current = currentArchivableBot(state.bots, bot.id);
    if (current) setConfirm({ kind: "archive", bot: current });
  };

  const archiveBot = async ({ id }: Pick<Bot, "id">) => {
    const bot = currentArchivableBot(state.bots, id);
    if (!bot) return;
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: t("sidebar.bot.archived", { name: bot.name }),
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: t("sidebar.archived.restored", { name: bot.name }) });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  const matchingBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q) ||
        b.tasks?.some((task) => !task.routineRunId && task.title.toLowerCase().includes(q)) ||
        b.projects?.some((folder) => folder.name.toLowerCase().includes(q)),
    );
  const visibleGroups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q) || g.tasks?.some((task) => task.title.toLowerCase().includes(q)));
  const {
    unsectionedChief,
    pinnedBots,
    sectionChiefs,
    sectionedBots,
    unsectionedBots,
  } = partitionSidebarBots(matchingBots);
  const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups(visibleGroups);

  // User sections keep first-appearance order. The saved layout keeps an
  // empty section's former slot so it returns there when content comes back.
  const sectionNames: string[] = [];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedRooms) {
    if (!sectionNames.includes(group.section!)) sectionNames.push(group.section!);
  }
  const naturalSectionIds = [
    ...(pinnedBots.length > 0 ? [PINNED_SECTION_ID] : []),
    ...(unsectionedRooms.length > 0 ? [CHANNELS_SECTION_ID] : []),
    ...(botChats.length > 0 ? [BOT_CHATS_SECTION_ID] : []),
    ...(unsectionedBots.length > 0 ? [BOTS_SECTION_ID] : []),
    ...sectionNames.map(userSectionId),
  ];
  const sectionIds = orderedSidebarSections(naturalSectionIds, sectionOrder);
  const layoutInteractive = sidebarLayoutInteractive(density, q);
  const sectionCollapsed = (id: string) =>
    sidebarSectionCollapsed(id, collapsedSections, density, q);

  const toggleSection = (id: string) => {
    if (!layoutInteractive) return;
    const next = toggleCollapsedSection(collapsedSections, id);
    setCollapsedSections(next);
    saveCollapsedSections(next);
  };

  const commitSectionOrder = (visibleOrder: string[]) => {
    if (!layoutInteractive) return;
    const next = mergeSectionOrder(sectionOrder, visibleOrder);
    if (sameSectionOrder(next, sectionOrder)) return;
    setSectionOrder(next);
    saveSectionOrder(next);
  };

  const announceSectionPosition = (id: string, visibleOrder: string[]) => {
    const position = visibleOrder.indexOf(id);
    if (position < 0) return;
    setReorderAnnouncement(
      t("sidebar.section.moved", {
        name: sectionLabel(id),
        position: position + 1,
        count: visibleOrder.length,
      }),
    );
  };

  // Every visible row, in the order it renders. `placeSection` needs both ids
  // present in the array it edits, so a first drag starts from this rather
  // than from an empty saved list.
  const rowBase = orderedSidebarSections(
    [
      ...(unsectionedChief ? [unsectionedChief.id] : []),
      ...pinnedBots.map((bot) => bot.id),
      ...sectionChiefs.map((bot) => bot.id),
      ...sectionedBots.map((bot) => bot.id),
      ...unsectionedBots.map((bot) => bot.id),
      ...botChats.map((group) => group.id),
      ...unsectionedRooms.map((group) => group.id),
      ...sectionedRooms.map((group) => group.id),
    ],
    rowOrder,
  );

  const commitRowOrder = (next: string[]) => {
    // Merged, not replaced: a bot that is archived or filtered out right now
    // is absent from `next`, and its saved place should survive.
    const merged = mergeSectionOrder(rowOrder, next);
    if (sameSectionOrder(merged, rowOrder)) return;
    setRowOrder(merged);
    saveRowOrder(merged);
  };

  /** `orderedList` is the row's own list under the order it just landed in —
   * never the saved array, which spans every section and would announce a
   * position the user cannot see. */
  const announceRowPosition = (id: string, orderedList: string[]) => {
    const position = orderedList.indexOf(id);
    // Rows are bots AND groups; naming only bots left every group move silent
    // for a screen reader.
    const name =
      state.bots.find((candidate) => candidate.id === id)?.name ??
      state.groups.find((candidate) => candidate.id === id)?.name;
    if (position < 0 || !name) return;
    setReorderAnnouncement(
      t("sidebar.section.moved", { name, position: position + 1, count: orderedList.length }),
    );
  };

  /** One step, and only against a neighbour from the same rendered list. */
  const moveRow = (id: string, listIds: string[], direction: -1 | 1) => {
    if (!layoutInteractive) return;
    const ordered = orderedSidebarSections(listIds, rowOrder);
    const next = moveRowWithinList(rowBase, ordered, id, direction);
    commitRowOrder(next);
    announceRowPosition(id, orderedSidebarSections(listIds, next));
  };

  const resetRowDrag = () => {
    rowDragRef.current = { from: null, list: [], over: null };
    setDraggingRowId(null);
    setRowDropTarget(null);
  };

  const startRowDrag = (event: React.DragEvent<HTMLDivElement>, id: string, listIds: string[]) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-openmausbot-sidebar-row", id);
    rowDragRef.current = { from: id, list: listIds, over: null };
    setDraggingRowId(id);
  };

  const updateRowDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string, listIds: string[]) => {
    const from = rowDragRef.current.from;
    // Only inside the list the drag started in: crossing a section boundary
    // would change the bot's team, which a drag must never do silently.
    if (!layoutInteractive || !from || from === id || !listIds.includes(from)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    rowDragRef.current.over = next;
    setRowDropTarget(next);
  };

  const dropRow = (event: React.DragEvent<HTMLDivElement>) => {
    const { from, list, over } = rowDragRef.current;
    if (from && over && list.includes(over.id)) {
      event.preventDefault();
      event.stopPropagation();
      const next = placeSection(rowBase, from, over.id, over.place);
      commitRowOrder(next);
      announceRowPosition(from, orderedSidebarSections(list, next));
    }
    resetRowDrag();
  };

  /** A row plus its drop indicators. The wrapper carries the drag, so the row
   * component stays a row and knows nothing about ordering. */
  const rowWrapper = (id: string, listIds: string[], child: ReactNode) => {
    const reorderable = layoutInteractive && listIds.length > 1;
    const marker = (place: SectionDropPlace) =>
      rowDropTarget?.id === id && rowDropTarget.place === place && draggingRowId !== id ? (
        <div className="mx-2 h-0.5 rounded-full bg-accent" />
      ) : null;
    return (
      <div
        key={id}
        draggable={reorderable}
        onDragStart={reorderable ? (event) => startRowDrag(event, id, listIds) : undefined}
        onDragEnd={resetRowDrag}
        onDragOver={(event) => updateRowDropTarget(event, id, listIds)}
        onDrop={dropRow}
        className={cn("flex flex-col gap-0.5", draggingRowId === id && "opacity-40")}
      >
        {marker("before")}
        {child}
        {marker("after")}
      </div>
    );
  };

  /** The list a group reorders inside. Empty while reordering is off — on the
   * rail and during a search — so the menus do not offer a move that `moveRow`
   * would refuse. */
  const rowListForGroup = (groupId: string): string[] => {
    const group = state.groups.find((candidate) => candidate.id === groupId);
    if (!group || !layoutInteractive) return [];
    const list = group.dm
      ? botChats
      : group.section
        ? sectionedRooms.filter((candidate) => candidate.section === group.section)
        : unsectionedRooms;
    return orderedSidebarSections(list.map((candidate) => candidate.id), rowOrder);
  };

  /** The list a bot reorders inside — the one it renders in, never wider. */
  const rowListForBot = (botId: string): string[] => {
    const bot = state.bots.find((candidate) => candidate.id === botId);
    if (!bot || bot.hidden || bot.chiefOfStaff || !layoutInteractive) return [];
    const list = bot.pinned
      ? pinnedBots
      : bot.section
        ? sectionedBots.filter((candidate) => candidate.section === bot.section)
        : unsectionedBots;
    return orderedSidebarSections(list.map((candidate) => candidate.id), rowOrder);
  };

  const sectionMembers = (name: string) => ({
    bots: state.bots.filter((bot) => !bot.hidden && bot.section === name),
    groups: state.groups.filter((group) => group.section === name),
  });

  /** A context is a label its members carry, so renaming and deleting are the
   * same write: put a different label — or none — on every member. */
  const relabelSection = (name: string, next: string) => {
    const { bots, groups } = sectionMembers(name);
    if (remoteClient) {
      if (bots.length > 0) {
        void api("/api/sidebar-sections", {
          method: "POST",
          body: JSON.stringify({ name: next, botIds: bots.map((bot) => bot.id) }),
        })
          .then(({ bots: updated }) => updated.forEach((bot: Bot) => dispatch({ type: "botPatched", bot })))
          .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
      }
    } else {
      for (const bot of bots) {
        // "" and not undefined: JSON.stringify drops an undefined field, so
        // the clear would never reach the server — the same empty string the
        // context picker sends to remove one row from a context.
        dispatch({ type: "updateBot", botId: bot.id, patch: { section: next } });
      }
    }
    for (const group of groups) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { section: next } });
    }
  };

  const moveSidebarSection = (id: string, direction: -1 | 1) => {
    const next = moveSection(sectionIds, id, direction);
    if (sameSectionOrder(next, sectionIds)) return;
    commitSectionOrder(next);
    announceSectionPosition(id, next);
  };

  const resetSectionDrag = () => {
    sectionDragRef.current = { from: null, over: null };
    setDraggingSectionId(null);
    setDropTarget(null);
  };

  const updateSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!layoutInteractive || !sectionDragRef.current.from) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    sectionDragRef.current.over = next;
    setDropTarget(next);
  };

  const dropSection = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
    event.preventDefault();
    const from =
      event.dataTransfer.getData("application/x-openmausbot-sidebar-section") ||
      event.dataTransfer.getData("text/plain") ||
      sectionDragRef.current.from;
    const over = sectionDragRef.current.over;
    if (from && over) {
      const next = placeSection(sectionIds, from, over.id, over.place);
      if (!sameSectionOrder(next, sectionIds)) {
        commitSectionOrder(next);
        announceSectionPosition(from, next);
      }
    }
    resetSectionDrag();
  };
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingBotUndo = teamFeedback?.restoreBot;

  return (
    <aside
      ref={sidebarRef}
      tabIndex={-1}
      aria-label={t("sidebar.aria")}
      data-native-view-overlay
      data-sidebar
      style={{ width }}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel",
        // No width transition mid-drag: the pointer is the animation, and a
        // 200ms ease would lag a frame behind it.
        dragging ? "" : "transition-[width] duration-200",
        // The drawer below md keeps a width of its own; the inline width and
        // the handle are desktop only.
        "max-md:!w-[320px]",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* Drag the divider itself, the way the Computer panel is resized. It
          is focusable and carries its value, because arrow keys resize from
          here; it is only the drawer layout below md that has no divider. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar.resizeAria")}
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_RAIL_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={toggleCollapsed}
        className="absolute inset-y-0 -right-0.5 z-20 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none max-md:hidden"
      />
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex items-center pt-3.5 pb-1", density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-4")}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-14"} />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className={cn("relative flex items-center", density === "icons" ? "flex-col gap-1" : "gap-1")}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={density === "icons" ? t("sidebar.density.expand") : t("sidebar.density.collapseAria")}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={density === "icons" ? t("sidebar.density.expand") : t("sidebar.density.collapse")}
          >
            {density === "icons" ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDensityOpen((value) => !value)}
              aria-label={t("sidebar.density.chooseAria")}
              aria-expanded={densityOpen}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title={t("sidebar.density.title")}
            >
              <span aria-hidden="true" className="flex size-5 flex-col items-center justify-center gap-[3px]">
                <span className="h-px w-3.5 rounded-full bg-current" />
                <span className="h-px w-2.5 rounded-full bg-current" />
                <span className="h-px w-3.5 rounded-full bg-current" />
              </span>
            </button>
            {densityOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setDensityOpen(false)} />
                <div className={cn(
                  "absolute top-full z-40 mt-1 w-40 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                  density === "icons" ? "left-0" : "right-0",
                )}>
                  {(["comfortable", "compact", "icons"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDensity(option)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-raised/70",
                        density === option ? "text-accent" : "text-ink",
                      )}
                    >
                      {option === "icons"
                        ? t("sidebar.density.iconsOnly")
                        : option === "compact"
                          ? t("sidebar.density.compact")
                          : t("sidebar.density.comfortable")}
                      {density === option && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")}
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className={cn(
                "absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  {t("sidebar.newBot")}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  {t("sidebar.newChannel.title")}
                </button>
                {!remoteClient && <>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  title={t("sidebar.backup.hint")}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={16} className="text-ink-secondary" />}
                  {exportingTeam ? t("sidebar.backup.exporting") : t("sidebar.backup.export")}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  {t("sidebar.teamLibrary")}
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">{t("sidebar.archived.title")}</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
                </>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      <div className={cn("pt-1 pb-3", density === "icons" ? "hidden" : "px-3")}>
        <div className="flex items-center gap-2 rounded-md border border-hairline/40 bg-inset/40 px-2.5 py-1.5 focus-within:border-accent/50">
          <Search size={14} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder={t("sidebar.search")}
            aria-label={t("sidebar.searchAria")}
            className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {matchingBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">{t("sidebar.noMatch", { query })}</div>
          )}
          {unsectionedChief && (
            <div className="mb-1.5">
              <BotListItem
                bot={unsectionedChief}
                density={density}
                query={q}
                onMenu={setMenu}
              />
            </div>
          )}
          {sectionIds.map((id, index) => {
            const sectionName = userSectionName(id);
            const sectionChiefItems = sectionName
              ? sectionChiefs.filter((bot) => bot.section === sectionName)
              : [];
            const sectionGroupItems = orderedSidebarRows(
              id === CHANNELS_SECTION_ID
                ? unsectionedRooms
                : id === BOT_CHATS_SECTION_ID
                  ? botChats
                  : sectionName
                    ? sectionedRooms.filter((group) => group.section === sectionName)
                    : [],
              rowOrder,
            );
            const sectionBotItems = orderedSidebarRows(
              id === PINNED_SECTION_ID
                ? pinnedBots
                : id === BOTS_SECTION_ID
                  ? unsectionedBots
                  : sectionName
                    ? sectionedBots.filter((bot) => bot.section === sectionName)
                    : [],
              rowOrder,
            );
            // Groups and bots are separate lists inside one section, so a drag
            // never interleaves a group into the bots below it.
            const groupListIds = sectionGroupItems.map((group) => group.id);
            const botListIds = sectionBotItems.map((bot) => bot.id);
            const collapsed = sectionCollapsed(id);
            const queued = collapsed ? [...sectionChiefItems, ...sectionBotItems].flatMap((bot) =>
              sidebarBotActivityTasks(bot, state.pendingQueued).filter((task) => task.queued).map((task) => `${bot.name}: ${task.title}`)) : [];
            const attention = collapsed
              ? sidebarSectionAttention(
                  [...sectionChiefItems, ...sectionBotItems],
                  sectionGroupItems,
                )
              : undefined;
            return (
              <div
                key={id}
                data-sidebar-section-id={id}
                onDragOver={(event) => updateSectionDropTarget(event, id)}
                onDrop={dropSection}
                className={cn(
                  "flex flex-col gap-0.5",
                  density !== "icons" && index > 0 && "pt-3",
                )}
              >
                {dropTarget?.id === id && dropTarget.place === "before" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
                {density !== "icons" && (
                  <SidebarSectionHeader
                    name={sectionLabel(id)}
                    collapsed={collapsed}
                    attention={attention}
                    onToggle={layoutInteractive ? () => toggleSection(id) : undefined}
                    reorderable={layoutInteractive && sectionIds.length > 1}
                    dragging={draggingSectionId === id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-openmausbot-sidebar-section", id);
                      event.dataTransfer.setData("text/plain", id);
                      sectionDragRef.current = { from: id, over: null };
                      setDraggingSectionId(id);
                    }}
                    onDragEnd={resetSectionDrag}
                    onMove={(direction) => moveSidebarSection(id, direction)}
                    onOpenMenu={layoutInteractive ? (point) => setSectionMenu({ id, ...point }) : undefined}
                  />
                )}
                {collapsed && queued.length > 0 && <button type="button" onClick={() => toggleSection(id)}
                  title={`${t("task.queued")} · ${queued.join(", ")}`} aria-label={`${t("sidebar.section.expand", { name: sectionLabel(id) })} · ${t("task.queued")} · ${queued.join(", ")}`}
                  className="mx-3 mb-1 self-start rounded bg-raised/50 px-2 py-0.5 text-[10px] text-ink-secondary hover:text-ink">{t("task.queued")} · {queued.length}</button>}
                {!collapsed && (
                  <>
                    {sectionChiefItems.map((bot) => (
                      <BotListItem
                        key={bot.id}
                        bot={bot}
                        density={density}
                        query={q}
                        onMenu={setMenu}
                      />
                    ))}
                    {sectionGroupItems.map((group) => rowWrapper(group.id, groupListIds, (
                      <GroupListItem
                        group={group}
                        density={density}
                        query={q}
                        onMenu={setRoomMenu}
                      />
                    )))}
                    {sectionBotItems.map((bot) => rowWrapper(bot.id, botListIds, (
                      <BotListItem
                        bot={bot}
                        density={density}
                        query={q}
                        onMenu={setMenu}
                      />
                    )))}
                  </>
                )}
                {dropTarget?.id === id && dropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
              </div>
            );
          })}
          <SearchResults query={query} onLanded={() => setQuery("")} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", density === "icons" ? "px-2" : "px-3")}>
        {density === "icons" && (
          <>
          <button
            onClick={() => dispatch({ type: "showTeamMap" })}
            aria-label={density === "icons" ? t("sidebar.nav.teamMap") : undefined}
            title={density === "icons" ? t("sidebar.nav.teamMap") : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "team-map" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
            )}
          >
            <Network size={20} className={state.activeView === "team-map" ? "text-accent" : "text-ink-secondary"} />
            <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>{t("sidebar.nav.teamMap")}</span>
          </button>
          <button
            onClick={() => dispatch({ type: "showRoutines" })}
            aria-label={density === "icons" ? t("sidebar.nav.automations") : undefined}
            title={density === "icons" ? t("sidebar.nav.automations") : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
            )}
          >
            <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
            <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>{t("sidebar.nav.automations")}</span>
            {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
              <span className="size-2 rounded-full bg-danger" />
            )}
          </button>
          <button
            onClick={() => dispatch({ type: "togglePlugins", open: true })}
            className={cn("flex min-h-10 w-full items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "gap-3 px-3")}
            aria-label={density === "icons" ? t("sidebar.nav.connectedApps") : undefined}
            title={density === "icons" ? t("sidebar.nav.connectedApps") : undefined}
          >
            <Puzzle size={20} className="text-ink-secondary" />
            <span className={cn("text-[14px] text-ink", density === "icons" && "hidden")}>{t("sidebar.nav.connectedApps")}</span>
          </button>
          </>
        )}
        {density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
          {density !== "icons" && (
          <SidebarMoreMenu
            items={[
              {
                key: "team-map",
                label: t("sidebar.nav.teamMap"),
                icon: <Network size={18} />,
                active: state.activeView === "team-map",
                onSelect: () => dispatch({ type: "showTeamMap" }),
              },
              {
                key: "routines",
                label: t("sidebar.nav.automations"),
                icon: <CalendarDays size={18} />,
                active: state.activeView === "routines",
                // folded away, this dot would otherwise vanish with the row
                attention: state.routineRuns.some(
                  (run) => ["failed", "missed"].includes(run.status) && !run.seenAt,
                ),
                onSelect: () => dispatch({ type: "showRoutines" }),
              },
              {
                key: "plugins",
                label: t("sidebar.nav.connectedApps"),
                icon: <Puzzle size={18} />,
                onSelect: () => dispatch({ type: "togglePlugins", open: true }),
              },
            ]}
          />
        )}
        {density === "icons" ? (
          <div className="flex items-center justify-center">
            <button
              onClick={() => dispatch({ type: "toggleAppSettings" })}
              className="flex min-w-0 items-center justify-center rounded-xl px-2 py-2 text-left hover:bg-raised/50"
              aria-label={t("sidebar.appSettings")}
              title={state.config?.profile?.name?.trim() || t("sidebar.appSettings")}
            >
              <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            </button>
          </div>
        ) : (
          // The Tools row and the profile row are two different kinds of
          // thing — places to go, versus who you are and what the app is —
          // so they get clear space between them. A hairline lived here
          // briefly and made it worse: full-bleed, it ran within a few pixels
          // of the profile row's rounded hover pill, and the two hover states
          // read as one crowded block rather than two rows.
          <div className="mt-3">
            <SidebarProfileMenu />
          </div>
        )}
      </div>

      {menu && (
        <BotContextMenu
          moveList={rowListForBot(menu.botId)}
          onMoveRow={(direction) => moveRow(menu.botId, rowListForBot(menu.botId), direction)}
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={requestArchive}
          onDelete={(bot) => setConfirm({ kind: "delete", bot })}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
          onNewFolder={setNewFolderBotId}
        />
      )}
      {showThreads && newFolderBotId && state.bots.find((bot) => bot.id === newFolderBotId) && <BotProjectDialog bot={state.bots.find((bot) => bot.id === newFolderBotId)!} onClose={() => setNewFolderBotId(null)} />}
      <ConfirmDialog
        open={confirm !== null}
        {...(confirm ? botConfirmCopy(confirm.kind, confirm.bot.name) : botConfirmCopy("archive", ""))}
        icon={confirm?.kind === "delete" ? <Trash2 size={18} /> : <Archive size={18} />}
        onCancel={cancelConfirm}
        returnFocusRef={sidebarRef}
        onConfirm={() => {
          if (!confirm) return;
          const { kind, bot } = confirm;
          setConfirm(null);
          if (kind === "archive") void archiveBot(bot);
          else dispatch({ type: "deleteBot", botId: bot.id });
        }}
      />
      {sectionMenu && (
        <SectionContextMenu
          key={sectionMenu.id}
          menu={sectionMenu}
          label={sectionLabel(sectionMenu.id)}
          editable={userSectionName(sectionMenu.id) !== null}
          canMoveUp={layoutInteractive && sectionIds.indexOf(sectionMenu.id) > 0}
          canMoveDown={
            layoutInteractive &&
            sectionIds.indexOf(sectionMenu.id) >= 0 &&
            sectionIds.indexOf(sectionMenu.id) < sectionIds.length - 1
          }
          onClose={() => setSectionMenu(null)}
          onMove={(direction) => moveSidebarSection(sectionMenu.id, direction)}
          onRename={(next) => {
            const name = userSectionName(sectionMenu.id);
            if (name) relabelSection(name, next);
          }}
          onDelete={() => {
            const name = userSectionName(sectionMenu.id);
            if (!name) return;
            const { bots, groups } = sectionMembers(name);
            setSectionConfirm({ id: sectionMenu.id, name, count: bots.length + groups.length });
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(sectionConfirm)}
        title={t("sidebar.section.deleteTitle", { name: sectionConfirm?.name ?? "" })}
        body={t("sidebar.section.deleteBody", { count: sectionConfirm?.count ?? 0 })}
        confirmLabel={t("common.delete")}
        tone="danger"
        icon={<Trash2 size={18} />}
        returnFocusRef={sidebarRef}
        onCancel={() => setSectionConfirm(null)}
        onConfirm={() => {
          if (sectionConfirm) relabelSection(sectionConfirm.name, "");
          setSectionConfirm(null);
        }}
      />
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => {
            if (!remoteClient) {
              dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } });
              return;
            }
            void api("/api/sidebar-sections", {
              method: "POST",
              body: JSON.stringify({ name: section, botIds: [sectionPicker.botId] }),
            })
              .then(({ bots }) => bots.forEach((bot: Bot) => dispatch({ type: "botPatched", bot })))
              .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
          }}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          moveList={rowListForGroup(roomMenu.groupId)}
          onMoveRow={(direction) => moveRow(roomMenu.groupId, rowListForGroup(roomMenu.groupId), direction)}
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {!remoteClient && archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {!remoteClient && teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback({
              error: false,
              text:
                result.members === 1
                  ? t("sidebar.teamImportedOne")
                  : t("sidebar.teamImportedMany", { count: result.members }),
            });
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  {t("common.undo")}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
