import { track } from "@/lib/analytics";
import { OrganizationIdentity } from "./OrganizationIdentity";
import { approvalCardOutcome } from "./ApprovalCard";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Archive,
  BellDot,
  Bot as BotIcon,
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
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Phone,
  Pin,
  PinOff,
  Plus,
  Search,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, currentTaskBot, openThread, type Action, type AppState, type Bot, type BotProject, type Group, type InstanceInfo, type Message } from "@/state/store";
import { approvalModeFor } from "../../shared/approval-mode";
import { avatarCropRadius, botAvatarProfile } from "../../shared/bot-avatar";
import { peerLine } from "@/lib/peer-message";
import { liveActivityLabel } from "@/lib/live-activity";
import { llmThreadTitlesEnabled } from "@/lib/feature-flags";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { searchMatchesThreads, useSearchDisclosure } from "@/lib/search-disclosure";
import { useHeldMenuMotion, useMenuMotion } from "./MenuMotion";
import { lastNonReceipt } from "@/lib/receipts";
import { activityPreview, botEngine } from "@/lib/failed-turn";
import { activeLocale, t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { FullAccessWarning } from "./FullAccessWarning";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { WorkingDots } from "./WorkingIndicator";
import { nextRename } from "@/lib/rename";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel } from "./TeamLibraryPanel";
import { ShareTeamDialog } from "./ShareTeamDialog";
import { TeamDialog } from "./TeamDialog";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import { BotProjectDialog, FolderActions, FolderIcon, navigateThreadMenu } from "./BotProjects";
import { draggedFolder, FOLDER_DRAG_TYPE, moveFolder, placeFolder } from "@/lib/folder-order";
import { folderUnreadThreadIds, markFolderRead } from "@/lib/folder-read";
import { orderedThreadList, SidebarThreadRow, stampClock, threadRecency, useRelativeNow, useSnoozeExpiry, visibleSidebarThreads } from "./SidebarThreadRow";
import {
  loadCollapsedSections,
  loadSectionOrder,
  loadSidebarAttentionPinned,
  loadSidebarWidth,
  clampSidebarWidth,
  saveCollapsedSections,
  saveSectionOrder,
  saveSidebarAttentionPinned,
  saveSidebarWidth,
  setSidebarDensity,
  toggleCollapsedSection,
  useSidebarDensity,
  usePinnedCircles,
  useUniversalPins,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  ATTENTION_SECTION_ID,
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  PINNED_THREADS_SECTION_ID,
  TOOLS_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  pinnedCircleThreadListVisible,
  sameSectionOrder,
  sidebarConnectorPreview,
  sidebarGoalRunPreview,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { botListItemPointerIntent } from "@/lib/sidebar-selection";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarAppsButton, SidebarFooterNav } from "./SidebarFooterNav";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";
import { useCloudOwner } from "./CloudOwner";
import { profileInitials, SidebarProfileMenu } from "./SidebarProfileMenu";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { useShowThreads } from "@/lib/thread-preferences";
import { botShowsUnread } from "@/lib/bot-unread";
import { attentionHasRunningWork, attentionJumpAction, attentionTriggerLabel, attentionUnpinAction, AttentionThreadRows, crossBotAttentionThreads, crossBotPinnedThreads, SidebarBotActivity, sidebarBotActivityTasks } from "./SidebarBotActivity";
import { SidebarAttentionPanel } from "./SidebarAttentionPanel";
import { SidebarPinnedThreadsPanel } from "./SidebarPinnedThreadsPanel";
import { useLiveMedia } from "@/lib/live-call-media";
import { LiveCallPill, liveBadgeFor } from "./LiveCallPill";
import { ShortcutHint } from "./ShortcutHint";
import { citationPreviewText } from "@/lib/citations";
import { isClientCancellation } from "../../shared/client-cancel";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useAdvancedMode } from "@/lib/interface-mode";

/** Vertical centre of the macOS traffic lights, in CSS px from the window
 * top: electron/window-chrome.mjs sets trafficLightPosition.y = 16 and the
 * buttons are 14px tall. The sidebar's top row is twice this tall so its
 * centred controls sit on the lights' line. */
export const MAC_TRAFFIC_LIGHT_CENTER_Y = 23;

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

/** `visible` is the bot's visible branch (visibleMessages), which the row
 * already works out once per transcript. */
function preview(bot: Bot, visible: Message[], instances: InstanceInfo[]): string {
  if (bot.activity === "waiting-on-you") return t("sidebar.preview.waiting");
  if (bot.waitingForTeammates) return t("sidebar.preview.waitingOnTeammate");
  if (bot.busy) return t("sidebar.preview.working");
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from — read past
  // the harness's receipts (digest, compaction) to the reply a person reads
  const last = lastNonReceipt(visible);
  if (!last) return "";
  // a settled approval card says what happened, as the card itself does;
  // its title is the question it asked, which nobody is waiting on now
  if (last.kind === "options" && last.card) {
    return (last.card.requestId && last.card.tool && !last.card.questionRequest && approvalCardOutcome(last.card)) || last.card.title;
  }
  // a failed turn reads as the chat row says it, never "error: …"
  if (last.kind === "activity" && last.tool) return activityPreview(last.tool, botEngine(bot, instances), last.dataResult);
  if (last.kind === "screen") return t("sidebar.preview.screenFrame");
  if (last.kind === "connector" && last.connector) return sidebarConnectorPreview(last.connector, t);
  const peer = peerLine(last);
  if (peer) return `${peer.name}: ${peer.body}`;
  if (last.role !== "user" && isClientCancellation(last.text ?? "")) return t("chat.turnStopped");
  return citationPreviewText(last.text ?? "");
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

/** The same point the bot row's context menu and "more" button already use. */
function openBotContextMenu(onMenu: (menu: MenuState) => void, botId: string, event: React.MouseEvent) {
  event.preventDefault();
  onMenu({ botId, x: event.clientX, y: event.clientY });
}

function groupPreview(group: Group, bots: Bot[], instances: InstanceInfo[]): string {
  if (group.busyBotId) {
    return t("sidebar.preview.botWorking", {
      name: bots.find((b) => b.id === group.busyBotId)?.name ?? t("sidebar.preview.aBot"),
    });
  }
  if (group.working) return t("sidebar.preview.teamWorking");
  const last = lastNonReceipt(group.messages);
  if (!last) return t("sidebar.preview.noMessages");
  if (last.kind === "text" && last.role !== "user" && isClientCancellation(last.text ?? "")) {
    const stopped = t("chat.turnStopped");
    return last.from ? `${last.from.name}: ${stopped}` : stopped;
  }
  const text = last.kind === "activity" && last.tool
    ? activityPreview(last.tool, botEngine(bots.find((bot) => bot.id === last.from?.botId), instances), last.dataResult)
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : last.kind === "connector" && last.connector
        ? sidebarConnectorPreview(last.connector, t)
        : (last.text ?? "");
  const readable = citationPreviewText(text);
  if (last.role === "user") return t("sidebar.preview.you", { text: readable });
  return last.from ? `${last.from.name}: ${readable}` : readable;
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
  quiet = false,
  query = "",
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  /** Quiet rows: name and status only (see sidebar-preferences). */
  quiet?: boolean;
  query?: string;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  // a search opens this room only when it has a matching thread to show,
  // and clearing it puts the room back as it was (MOCA-293)
  const [threadsOpen, setThreadsOpen] = useSearchDisclosure(`group:${group.id}`, query ?? "", searchMatchesThreads(query ?? "", group.tasks), selected);
  const wasSelected = useRef(selected);
  useEffect(() => {
    // Search can unmount the selected room. Only a new selection opens it;
    // remounting must preserve the person's remembered disclosure choice.
    if (selected && !wasSelected.current) setThreadsOpen(true);
    wasSelected.current = selected;
  }, [selected]);
  // one thread is the room itself; the disclosure and the list only earn
  // their place once there is a second thread to show
  const hasThreadList = (group.tasks?.length ?? 1) > 1 || Boolean(query);
  const expanded = !group.dm && threadsOpen && density !== "icons" && hasThreadList;
  // quiet rows keep the line only while the room reports work in progress
  const groupStatus = Boolean(group.busyBotId) || Boolean(group.working);
  const roomBusy = groupStatus;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <>
    <div className="group relative">
    <button
      data-sidebar-group-row={group.id}
      // with no thread list open, the row is the conversation being looked at
      aria-current={selected && !expanded ? "page" : undefined}
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
        density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-1.5 py-1 pl-6 pr-9" : "gap-2 py-1.5 pl-6 pr-9",
        selected && !expanded ? "bg-raised/70" : "hover:bg-raised/40",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedMauses members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{group.name}</span>
          {selected && last && !expanded && <span className="shrink-0 text-[10px] text-ink-secondary">{formatTime(last.at)}</span>}
          {(expanded || (quiet && !groupStatus)) && group.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
        </div>
        {!expanded && (!quiet || groupStatus) && <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-secondary">{groupPreview(group, state.bots, state.instances)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>}
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
    {!group.dm && density !== "icons" && hasThreadList && <button type="button" aria-label={t(expanded ? "task.collapseNamed" : "task.expandNamed", { name: group.name })} aria-expanded={expanded}
      onClick={() => setThreadsOpen((open) => !open)} className="absolute left-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
      <ChevronRight aria-hidden="true" size={12} className={cn("transition-transform", expanded && "rotate-90")} />
    </button>}
    {!group.dm && density !== "icons" && <button type="button" disabled={roomBusy} aria-label={t("task.newShort")} title={t(roomBusy ? "task.newBusy" : "task.newShort")}
      onClick={() => { setThreadsOpen(true); dispatch({ type: "newGroupTask", groupId: group.id }); }}
      className="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink disabled:opacity-40 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70 touch:disabled:opacity-40"><Plus size={14} /></button>}
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
  const now = useRelativeNow();
  const [showAll, setShowAll] = useState(false);
  const busy = Boolean(group.working || group.busyBotId);
  const waiting = state.bots.find((bot) => bot.id === group.busyBotId)?.activity === "waiting-on-you";
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => ({
    ...task, busy: task.threadId === group.threadId && busy, unread: task.threadId === group.threadId && group.unread,
    activity: task.threadId === group.threadId && waiting ? "waiting-on-you" as const : undefined,
  }));
  const visible = orderedThreadList(visibleSidebarThreads(tasks, group.threadId, query, [], showAll));
  useRevealedThreadRow(state.revealThread, selected ? group.threadId : null);
  // One set of row actions per room; they read the room as it is when used.
  const latest = useRef(group);
  latest.current = group;
  const groupId = group.id;
  const actions = useMemo(() => ({
    onSelect: (task: { threadId: string }) => {
      if (task.threadId !== latest.current.threadId) dispatch({ type: "switchGroupTask", groupId, threadId: task.threadId });
      else dispatch({ type: "select", id: groupId });
    },
    onRename: (task: { threadId: string }, title: string) => dispatch({ type: "renameGroupTask", groupId, threadId: task.threadId, title }),
    onDelete: (task: { threadId: string }) => dispatch({ type: "deleteGroupTask", groupId, threadId: task.threadId }),
    onPin: (task: { threadId: string; title: string }, pinned: boolean) => dispatch({ type: "pinGroupTask", groupId, threadId: task.threadId, pinned, title: task.title }),
  }), [groupId, dispatch]);
  const locale = activeLocale();
  return <div className="mb-2 space-y-0.5" role="group" aria-label={t("task.namedList", { name: group.name })}>
    {visible.map((task) => <SidebarThreadRow key={task.threadId} task={task} ownerId={group.id} current={selected && task.threadId === group.threadId} compact={density === "compact"}
      now={stampClock(threadRecency(task), now)} locale={locale} {...actions} />)}
    {!query && !showAll && tasks.length > visible.length && <button type="button" onClick={() => setShowAll(true)} className="pl-6 pr-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">{t("task.showAll", { count: tasks.length })}</button>}
  </div>;
}

/** Copy for the room delete confirmation. Deleting a room drops its messages
 * and every thread in it and turns off the routines that run there; the bots
 * in it are untouched. Bot⇄bot rooms are labelled threads in the menu. */
export function roomDeleteCopy(group: Pick<Group, "name" | "dm">) {
  const isBotChat = Boolean(group.dm);
  return {
    title: t("sidebar.room.deleteConfirmTitle", { name: group.name }),
    body: isBotChat
      ? t("sidebar.room.deleteChatBody", { name: group.name })
      : t("sidebar.room.deleteChannelBody", { name: group.name }),
    confirmLabel: isBotChat ? t("sidebar.room.deleteChat") : t("sidebar.room.deleteChannel"),
    tone: "danger" as const,
  };
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
  onDelete,
}: {
  menu: { groupId: string; x: number; y: number } | null;
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
  onDelete: (groupId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const group = shown ? state.groups.find((g) => g.id === shown.groupId) : undefined;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    if (!menu) return;
    setDraft(state.groups.find((g) => g.id === menu.groupId)?.name ?? "");
    setRenaming(false);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
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
  }, [menu, onClose]);

  if (!motion.shown || !group || !shown) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(shown.y, window.innerHeight - 204);
  const left = Math.min(shown.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      style={{ top, left }}
      className={cn("fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
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
          void copyText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("sidebar.copyConversationId")}
      </button>
      {!remoteClient && <button
        onClick={() => {
          onClose();
          onDelete(group.id);
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
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const motion = useHeldMenuMotion(anchor);
  const shown = motion.value;
  const heldCurrent = useRef(current);
  if (anchor) heldCurrent.current = current;
  const trimmed = name.trim();

  useEffect(() => {
    if (!anchor) return;
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
  }, [anchor, onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...(state.sections ?? []),
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  if (!motion.shown || !shown) return null;
  const sectionCurrent = heldCurrent.current;
  const top = Math.max(8, Math.min(shown.y, window.innerHeight - 300));
  const left = Math.min(shown.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className={cn("fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-2 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
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
                section === sectionCurrent ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === sectionCurrent && <Check size={14} className="shrink-0 text-accent" />}
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
      {sectionCurrent && (
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
}: {
  menu: MenuState | null;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onDelete: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
  onNewFolder: (botId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const bot = shown ? state.bots.find((b) => b.id === shown.botId) : undefined;
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !shown) return;
    const place = () => {
      const { width, height } = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(shown.y, window.innerHeight - height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(shown.x, window.innerWidth - width - 8))}px`;
    };
    // Menu length changes with thread settings, permissions, and locale.
    // Measure after every render; the viewport cap handles short windows.
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  // Focus moves in once per open and back out on close. It stays apart from
  // the listeners below: Sidebar passes a fresh onClose every render, and
  // re-running this with them would pull focus back to the first item.
  useEffect(() => {
    if (!menu) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
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
  }, [menu, onClose]);

  if (!motion.shown || !bot || !shown) return null;
  const deleting = state.deletingBots[bot.id] === true;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
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
      style={{ top: shown.y, left: shown.x }}
      className={cn("fixed z-40 max-h-[calc(100dvh-16px)] w-[228px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
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
          void copyText(bot.threadId);
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
          void copyText(bot.threadId);
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
 * server drops every task transcript, the workspace (files + memory), staged
 * skill state, and any private computer the bot owns. Shared team computers
 * remain. */
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

export function archivedDeleteAllCopy() {
  return {
    title: t("sidebar.archived.deleteAllTitle"),
    body: t("sidebar.archived.deleteAllBody"),
    confirmLabel: t("sidebar.archived.deleteAll"),
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

// one empty list, so a bot without folders hands its rows the same array
const NO_FOLDERS: BotProject[] = [];

/** The thread tree under one bot row: project folders, then ungrouped rows.
 * Visibility folds old threads away. Pins stay, then the newest update.
 * Waiting and working stay visible as status, not as a sort key. It takes
 * its bot row's props and renders with that row. */
export function BotThreadList({ bot, selected, density, query, pendingQueued, reveal, locale, generatedTitles, dispatch, activityLabel, hidden = false }: BotRowProps & {
  /** The live verb for the open thread's row ("Reading a file"), from the
   * bot's visible tail; without it the row says Working. */
  activityLabel?: string;
  hidden?: boolean;
}) {
  const now = useRelativeNow();
  const tasks = (bot.tasks ?? [{ threadId: bot.threadId, title: t("task.newShort"), createdAt: 0 }])
    .filter((task) => !task.routineRunId)
    .map((task) => ({ ...task, queued: Boolean(pendingQueued[task.threadId]?.length) }));
  const projects = bot.projects ?? NO_FOLDERS;
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
  const [permissionRefresh, setPermissionRefresh] = useState<{ threadId: string; kind: "full" | "local-auto" } | null>(null);
  const currentProjectId = tasks.find((task) => task.threadId === bot.threadId)?.projectId;
  useEffect(() => {
    if (selected && currentProjectId) setCollapsed((previous) => {
      if (!previous.has(currentProjectId)) return previous;
      const next = new Set(previous);
      next.delete(currentProjectId);
      return next;
    });
  }, [selected, currentProjectId]);
  useSnoozeExpiry(tasks);
  // Pin, then newest update. Search keeps the same order among matches.
  const visibleTasks = orderedThreadList(visibleSidebarThreads(tasks, bot.threadId, query, projects, showAll));
  // A folder rises with the thread of its that sits highest in that order.
  // An empty index sorts last. Saved order breaks ties, and still governs
  // move up and down.
  const visibleProjectIndex = (projectId: string) => visibleTasks.findIndex((task) => task.projectId === projectId);
  const folderRank = (projectId: string) => {
    const index = visibleProjectIndex(projectId);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const orderedProjects = query ? projects : [...projects].sort((a, b) => folderRank(a.id) - folderRank(b.id) || projects.indexOf(a) - projects.indexOf(b));
  useRevealedThreadRow(reveal, selected ? bot.threadId : null);
  // One set of row actions per bot; they read the bot as it is when used.
  const latest = useRef(bot);
  latest.current = bot;
  const botId = bot.id;
  const actions = useMemo(() => ({
    onSelect: (task: { threadId: string }) => {
      if (task.threadId !== latest.current.threadId) dispatch({ type: "switchTask", botId, threadId: task.threadId });
      else dispatch({ type: "select", id: botId });
    },
    onRename: (task: { threadId: string }, title: string) => dispatch({ type: "renameTask", botId, threadId: task.threadId, title }),
    onRegenerateTitle: generatedTitles ? (task: { threadId: string }, onSettled: (ok: boolean) => void) => dispatch({ type: "regenerateTaskTitle", botId, threadId: task.threadId, onSettled }) : undefined,
    onDelete: (task: { threadId: string }) => dispatch({ type: "deleteTask", botId, threadId: task.threadId }),
    onMove: (task: { threadId: string }, projectId: string | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { projectId } }),
    onArchive: (task: { threadId: string }, archivedAt: number | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { archivedAt } }),
    onPin: (task: { threadId: string }, pinned: boolean) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { pinned } }),
    onSnooze: (task: { threadId: string }, snoozedUntil: number | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { snoozedUntil } }),
    onRefreshPermissions: (task: { threadId: string }) => {
      const current = latest.current;
      const mode = approvalModeFor(current);
      const threadMode = approvalModeFor(currentTaskBot(current, task.threadId));
      if (mode === "full" && threadMode !== "full") {
        setPermissionRefresh({ threadId: task.threadId, kind: "full" });
        return;
      }
      if (mode === "auto" && current.computer === "local" && threadMode !== "auto") {
        setPermissionRefresh({ threadId: task.threadId, kind: "local-auto" });
        return;
      }
      dispatch({ type: "refreshTaskPermissions", botId, threadId: task.threadId });
    },
  }), [botId, dispatch, generatedTitles]);
  const renderThread = (task: (typeof tasks)[number]) => {
    const thread = currentTaskBot(bot, task.threadId);
    return <SidebarThreadRow key={task.threadId} task={{ ...task, busy: thread.busy, activity: thread.activity, waitingForTeammates: thread.waitingForTeammates }} ownerId={bot.id} current={selected && task.threadId === bot.threadId} compact={density === "compact"} folders={projects}
      activityLabel={task.threadId === bot.threadId ? activityLabel : undefined} now={stampClock(threadRecency(task), now)} locale={locale} {...actions} />;
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
    <div hidden={hidden} className="mb-2 space-y-0.5" role="group" aria-label={t("task.namedList", { name: bot.name })}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) event.stopPropagation(); }}
      onDrop={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) { event.preventDefault(); event.stopPropagation(); resetFolderDrag(); } }}>
      {!hidden && <>
      {orderedProjects.map((project) => {
        const index = projects.indexOf(project);
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
            className={cn("group/folder flex items-center gap-0.5 rounded-md pl-0.5 text-ink-secondary hover:bg-raised/30",
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
              className="flex size-6 items-center justify-center rounded opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/folder:opacity-100 max-md:opacity-70 touch:opacity-70"><Plus size={12} /></button>
            <FolderActions project={project} canMoveUp={index > 0} canMoveDown={index < projects.length - 1} canMarkRead={folderUnreadThreadIds(bot, project.id).length > 0} saving={reordering || markingRead}
              menu={folderMenu?.projectId === project.id ? folderMenu : null} onMenuChange={(menu) => setFolderMenu(menu ? { ...menu, projectId: project.id } : null)}
              onEdit={() => setEditingProject(project.id)} onMove={(direction, onSaved) => saveOrder(moveFolder(projectIds, project.id, direction), onSaved)}
              onMarkRead={(onSaved) => { void readFolder(project.id, onSaved); }} />
          </div>
          {open && <div role="group" aria-label={t("task.namedList", { name: project.name })}>
            {visible.map(renderThread)}
            {projectTasks.length === 0 && <p className="px-2.5 py-1 text-[11px] text-ink-tertiary">{t("task.empty")}</p>}
          </div>}
        </div>;
      })}
      {reorderError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{reorderError}</p>}
      <span role="status" className="sr-only">{reorderStatus}</span>
      {readError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{readError}</p>}
      <span role="status" className="sr-only">{readStatus}</span>
      {projects.length > 0 && ungrouped.length > 0 && <div className="pl-6 pr-3 pb-1 pt-2 text-[10.5px] text-ink-tertiary">{t("task.list")}</div>}
      {ungrouped.map(renderThread)}
      {!query && !showAll && tasks.length > visibleTasks.length && <button type="button" onClick={() => setShowAll(true)} className="pl-6 pr-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">{t("task.showAll", { count: tasks.length })}</button>}
      <FullAccessWarning
        open={permissionRefresh?.kind === "full"}
        scope="thread"
        onCancel={() => setPermissionRefresh(null)}
        onConfirm={() => {
          const threadId = permissionRefresh?.threadId;
          setPermissionRefresh(null);
          if (threadId) dispatch({ type: "refreshTaskPermissions", botId: bot.id, threadId });
        }}
      />
      <LocalComputerAutoWarning
        open={permissionRefresh?.kind === "local-auto"}
        onCancel={() => setPermissionRefresh(null)}
        onConfirm={() => {
          const threadId = permissionRefresh?.threadId;
          setPermissionRefresh(null);
          if (threadId) dispatch({ type: "refreshTaskPermissions", botId: bot.id, threadId, acknowledgeLocalAuto: true });
        }}
      />
      {projectToEdit && <BotProjectDialog bot={bot} project={projectToEdit} onClose={() => setEditingProject(null)} />}
      </>}
    </div>
  );
}

/** What a bot row shows besides its bot. The sidebar works these out once
 * per store event (botRowProps) and the row is memoized on them, so an event
 * re-renders only the rows whose bot, or whose part of these, changed. */
export interface BotRowProps {
  bot: Bot;
  selected: boolean;
  deleting: boolean;
  /** The selected bot's mascot nudge; null on every other row. */
  mascotMotion: AppState["mascotMotion"];
  /** A thread being opened from a chip or #Title link, when it is one of
   * this bot's; null otherwise. */
  reveal: AppState["revealThread"];
  pendingQueued: AppState["pendingQueued"];
  instances: InstanceInfo[];
  liveCall: AppState["liveCall"];
  /** The app language. Rows show catalog strings, so a change re-renders them. */
  locale: string;
  generatedTitles: boolean;
  density: SidebarDensity;
  /** Quiet rows: name and status only (see sidebar-preferences). */
  quiet: boolean;
  query: string;
  dispatch: Dispatch<Action>;
  onMenu: (menu: MenuState) => void;
}

/** One bot row's props from the store state and the sidebar's layout. */
export function botRowProps(
  state: AppState,
  dispatch: Dispatch<Action>,
  bot: Bot,
  layout: Pick<BotRowProps, "density" | "quiet" | "query" | "onMenu">,
): BotRowProps {
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const reveal = state.revealThread;
  return {
    ...layout,
    bot,
    selected,
    deleting: state.deletingBots[bot.id] === true,
    mascotMotion: selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null,
    reveal: reveal && (bot.threadId === reveal.threadId || bot.tasks?.some((task) => task.threadId === reveal.threadId)) ? reveal : null,
    pendingQueued: state.pendingQueued,
    instances: state.instances,
    liveCall: state.liveCall,
    locale: activeLocale(),
    generatedTitles: llmThreadTitlesEnabled(state.config),
    dispatch,
  };
}

/** The bot's visible branch, worked out again only when its transcript or
 * active leaf changes, not on every change to the bot. */
function useVisibleMessages(bot: Bot): Message[] {
  const { messages, activeLeafId } = bot;
  return useMemo(() => visibleMessages({ messages, activeLeafId }), [messages, activeLeafId]);
}

export const PinnedBotCircle = memo(function PinnedBotCircle({ bot, selected, mascotMotion, pendingQueued, dispatch, onMenu }: BotRowProps) {
  const visible = useVisibleMessages(bot);
  const activityTasks = sidebarBotActivityTasks(bot, pendingQueued);
  const waiting = bot.activity === "waiting-on-you" || activityTasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || activityTasks.some((task) => task.busy || task.activity === "working"));
  const unread = bot.unread || activityTasks.some((task) => task.unread);
  const radius = avatarCropRadius(botAvatarProfile(bot).avatarCrop);
  return (
    <button
      type="button"
      data-sidebar-bot-row={bot.id}
      aria-current={selected ? "page" : undefined}
      aria-label={`${bot.name}${waiting ? ` · ${t("sidebar.preview.waiting")}` : working ? ` · ${t("chat.activity.working")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`}
      title={bot.name}
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
      className="flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1 text-center outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
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
  );
});

/** The same pinned bots as the circle grid, as normal rows, so their threads
 * and thread menu stay reachable. Not a reorderable section. */
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
      {!collapsed && bots.map((bot) => <BotListItem key={bot.id} {...row(bot)} />)}
    </div>
  );
}

function PinnedBotRoster({
  bots,
  density,
  circles,
  row,
}: {
  bots: Bot[];
  density: SidebarDensity;
  circles: boolean;
  row: (bot: Bot) => BotRowProps;
}) {
  if (circles && density !== "icons") {
    return (
      <div
        data-sidebar-pinned-circles=""
        className="grid gap-1 px-1 pb-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}
      >
        {bots.map((bot) => <PinnedBotCircle key={bot.id} {...row(bot)} />)}
      </div>
    );
  }
  return (
    <>
      {bots.map((bot) => <BotListItem key={bot.id} {...row(bot)} />)}
    </>
  );
}

export const BotListItem = memo(function BotListItem(props: BotRowProps) {
  const { bot, selected, deleting, mascotMotion, reveal, pendingQueued, instances, liveCall, density, quiet, query, dispatch, onMenu } = props;
  const showThreads = useShowThreads();
  const liveMedia = useLiveMedia();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  // a search opens this bot only when it has a matching thread or folder to
  // show, and clearing it puts the bot back as it was (MOCA-293)
  const [threadsOpen, setThreadsOpen] = useSearchDisclosure(`bot:${bot.id}`, showThreads ? query : "", searchMatchesThreads(query, bot.tasks, bot.projects));
  // a thread opened from a chip or #Title link: unfold this bot so the row
  // it lands on is on screen (BotThreadList scrolls it into view)
  useEffect(() => { if (reveal && showThreads) setThreadsOpen(true); }, [reveal, showThreads]);
  // one thread is the bot itself; the disclosure only earns its place once
  // there is a list (a second thread or a folder) to open
  const hasThreadList = (bot.tasks?.filter((task) => !task.routineRunId).length ?? 1) > 1 || (bot.projects?.length ?? 0) > 0 || Boolean(query);
  const iconOnly = density === "icons";
  const expanded = showThreads && !iconOnly && threadsOpen && hasThreadList;
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? (showThreads ? 26 : 40) : (showThreads ? 32 : 56);
  // the visible branch, so a version switch changes the row with the chat
  const visible = useVisibleMessages(bot);
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
        ? cn(showThreads ? "gap-1.5 py-1" : "gap-2 py-1.5", showThreads ? "pl-6 pr-9 group-hover:pr-[5.75rem] group-focus-within:pr-[5.75rem] max-md:pr-[5.75rem] touch:pr-[5.75rem]" : "pl-2 pr-9")
        : cn(showThreads ? "gap-2 py-2" : "gap-3 py-2.5", showThreads ? "pl-6 pr-9 group-hover:pr-[5.75rem] group-focus-within:pr-[5.75rem] max-md:pr-[5.75rem] touch:pr-[5.75rem]" : "pl-2 pr-9"),
    // Chief of Staff is called out by the crown label below, not by tinting
    // the whole row — an accent border + fill read as "selected" even when
    // another bot was active.
    selected ? "bg-raised/70" : "hover:bg-raised/40",
  );
  const activityTasks = sidebarBotActivityTasks(bot, pendingQueued);
  const waiting = bot.activity === "waiting-on-you" || activityTasks.some((task) => task.activity === "waiting-on-you");
  // Real work in a sibling still outranks an idle coordination wait.
  const working = !waiting && (Boolean(bot.busy) || activityTasks.some((task) => task.busy || task.activity === "working"));
  const teammateWait = !waiting && !working && (Boolean(bot.waitingForTeammates) || activityTasks.some((task) => Boolean(task.waitingForTeammates)));
  const queued = activityTasks.some((task) => task.queued);
  const unread = botShowsUnread(bot);
  // this window, a phone or another window is on a Live call with the bot
  const onLiveCall = liveBadgeFor(bot.id, liveMedia, liveCall);
  // quiet rows drop the last-message preview but keep a line that reports
  // something happening now; an idle bot is just its name
  const statusLine = deleting || working || waiting || teammateWait || queued;
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
          // decorative; working/unread/motion are the real signals).
          animated={working || unread || (mascotMotion?.kind ?? "none") !== "none"}
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
        {teammateWait && <span data-testid="teammate-wait-dot" role="status" aria-label={t("sidebar.preview.waitingOnTeammate")} title={t("sidebar.preview.waitingOnTeammate")}
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-accent", iconOnly ? "size-3" : "size-2.5")} />}
        {!teammateWait && !waiting && !working && queued && <span data-testid="queued-dot" role="status" aria-label={t("task.queued")} title={t("task.queued")}
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-ink-secondary", iconOnly ? "size-3" : "size-2.5")} />}
        {onLiveCall && iconOnly && (
          // icons-only rows have no name line: the badge sits on the avatar,
          // opposite the presence dot
          <span className="absolute -right-1 -top-1 flex rounded-full bg-panel p-0.5">
            <Phone className="size-3 shrink-0 text-success" role="img" aria-label={t("call.live.badge")} data-testid="live-call-badge">
              <title>{t("call.live.badge")}</title>
            </Phone>
          </span>
        )}
      </span>
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        {title && !renaming && !quiet && (
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
            {quiet && bot.chiefOfStaff && !renaming && (
              // quiet rows fold the Chief of Staff line into a crown right
              // after the name; the label lives in the tooltip and for
              // screen readers
              <Crown size={12} className="shrink-0 text-accent" role="img" aria-label={t("sidebar.bot.chiefOfStaff")} data-testid="chief-crown">
                <title>{t("sidebar.bot.chiefOfStaff")}</title>
              </Crown>
            )}
            {onLiveCall && !iconOnly && !renaming && (
              <Phone className="size-3 shrink-0 text-success" role="img" aria-label={t("call.live.badge")} data-testid="live-call-badge">
                <title>{t("call.live.badge")}</title>
              </Phone>
            )}
          </span>
          {selected && last && !renaming && !expanded && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 touch:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
          {(expanded || (quiet && !statusLine)) && unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
        </div>
        {bot.chiefOfStaff && !renaming && !quiet && (
          // Chief of Staff gets its own line under the name so a long name
          // and the title badge keep the full width of the name line.
          <span className="flex items-center gap-1 text-[11.5px] font-medium leading-4 text-accent">
            <Crown size={11} className="shrink-0" /> {t("sidebar.bot.chiefOfStaff")}
          </span>
        )}
        {(!expanded || deleting) && (!quiet || statusLine) && <div className="flex items-center justify-between gap-2">
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
                <span className="truncate">{waiting ? t("sidebar.preview.waiting") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued ? t("task.queued") : preview(bot, visible, instances)}</span>
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
    openBotContextMenu(onMenu, bot.id, event);
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
              : `${bot.name}${onLiveCall ? ` · ${t("call.live.badge")}` : ""}${waiting ? ` · ${t("sidebar.preview.waiting")}` : working ? ` · ${t("chat.activity.working")}` : teammateWait ? ` · ${t("sidebar.preview.waitingOnTeammate")}` : queued ? ` · ${t("task.queued")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`
            : undefined
        }
        aria-busy={deleting || undefined}
        // with no thread list open, the row is the conversation being looked at
        aria-current={selected && !expanded && !renaming ? "page" : undefined}
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
      {showThreads && !iconOnly && hasThreadList && <button
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
        {showThreads && <button type="button" aria-label={t("task.newShort")} title={t("task.newShort")} onClick={() => { setThreadsOpen(true); dispatch({ type: "newTask", botId: bot.id }); }}
          className="pointer-events-none absolute right-[3.75rem] top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70"><Plus size={14} /></button>}
        {showThreads && <button type="button" aria-label={t("folder.newNamed", { name: bot.name })} title={t("folder.new")} onClick={() => { setThreadsOpen(true); setCreatingProject(true); }}
          className="pointer-events-none absolute right-8 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70"><FolderPlus size={14} /></button>}
        <button type="button" aria-label={t("sidebar.bot.actions", { name: bot.name })} title={t("sidebar.bot.actions", { name: bot.name })} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ botId: bot.id, x: rect.left, y: rect.bottom }); }}
          className="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70"><MoreHorizontal size={15} /></button>
      </>}
      {deleting && iconOnly && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-card p-1 text-ink-secondary">
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
    </div>
    {/* Keep folder expansion state mounted while the preference is off. The
        hidden list omits its children, including any thread-menu portals. */}
    {!iconOnly && threadsOpen && hasThreadList && <BotThreadList {...props} hidden={!showThreads}
      // the same live verb the chat pane derives from the visible tail
      // ("Reading a file"), for the open thread's row while it works
      activityLabel={liveActivityLabel(last)}
      query={bot.name.toLowerCase().includes(query.toLowerCase()) || bot.title.toLowerCase().includes(query.toLowerCase()) ? "" : query} />}
    {!expanded && <SidebarBotActivity bot={bot} density={density} pendingQueued={pendingQueued} dispatch={dispatch} />}
    {showThreads && creatingProject && <BotProjectDialog bot={bot} onClose={() => setCreatingProject(false)} />}
    </>
  );
});

export function ArchivedBotRow({
  bot,
  restoring,
  deleting,
  disabled,
  onRestore,
  onDelete,
}: {
  bot: Bot;
  restoring: boolean;
  deleting: boolean;
  disabled: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
      <BotAvatar bot={bot} state="happy" size={42} animated={false} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || t("sidebar.archived.botFallback")}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={onRestore}
          disabled={disabled || deleting}
          className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {restoring && <Loader2 size={13} className="animate-spin" />}
          {t("sidebar.archived.restore")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled || deleting}
          aria-label={t("sidebar.archived.deleteAria", { name: bot.name })}
          className="flex items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] text-danger hover:bg-danger/10 disabled:opacity-40"
        >
          {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          {t("common.delete")}
        </button>
      </div>
    </div>
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
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Bot | "all" | null>(null);
  const [error, setError] = useState("");
  const deleting = bots.some((bot) => Boolean(state.deletingBots[bot.id]));
  const locked = restoringAll || Boolean(busyId) || deleting || Boolean(pendingDelete);

  useEffect(() => {
    if (bots.length === 0) onClose();
  }, [bots.length, onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, onClose]);

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
      onMouseDown={(event) => event.target === event.currentTarget && !locked && onClose()}
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
                disabled={locked}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                {t("sidebar.archived.restoreAll")}
              </button>
            )}
            {bots.length > 0 && (
              <button
                type="button"
                onClick={() => setPendingDelete("all")}
                disabled={locked}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                <Trash2 size={13} />
                {t("sidebar.archived.deleteAll")}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={locked}
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
              <ArchivedBotRow
                key={bot.id}
                bot={bot}
                restoring={busyId === bot.id}
                deleting={Boolean(state.deletingBots[bot.id])}
                disabled={locked}
                onRestore={() => void restore(bot)}
                onDelete={() => setPendingDelete(bot)}
              />
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        {...(pendingDelete === "all"
          ? archivedDeleteAllCopy()
          : botConfirmCopy("delete", pendingDelete?.name ?? ""))}
        icon={<Trash2 size={18} />}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const target = pendingDelete;
          setPendingDelete(null);
          if (target === "all") {
            for (const bot of bots) dispatch({ type: "deleteBot", botId: bot.id });
            return;
          }
          dispatch({ type: "deleteBot", botId: target.id });
        }}
      />
    </div>,
    document.body,
  );
}

/** A named team's context menu: add bots, rename, share the whole team,
 * delete. Exported for a markup test. */
export function TeamMenuItems({ onAddBots, onRename, onShare, onDelete }: {
  onAddBots: () => void;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-raised";
  return (
    <>
      <button type="button" role="menuitem" autoFocus className={item} onClick={onAddBots}><Users size={14} />{t("team.addBots")}</button>
      <button type="button" role="menuitem" className={item} onClick={onRename}><Pencil size={14} />{t("team.rename")}</button>
      <button type="button" role="menuitem" className={item} onClick={onShare}><Share2 size={14} />{t("team.share")}</button>
      <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={onDelete}><Trash2 size={14} />{t("team.delete")}</button>
    </>
  );
}

export function Sidebar({ open, onClose, collapseToIcons = false }: {
  open: boolean;
  onClose: () => void;
  /** Show the avatar rail regardless of the saved density: a side panel is
   * open and the window cannot seat the full sidebar, the chat and the
   * panel (App decides). The saved choice is untouched and returns when the
   * panel closes or the window grows. */
  collapseToIcons?: boolean;
}) {
  const { state, dispatch } = useStore();
  const now = useRelativeNow();
  const cloudOwner = useCloudOwner(state.config?.cloudHome === true);
  // The Show me how tip ends when the server menu it points at closes,
  // whatever was chosen (components/CloudHowTo.tsx); Add a Cloud… chosen
  // there shows as the dialog opened from it (cloud_dialog_shown).
  const endHowTo = useCallback(() => {
    track("cloud_howto", { result: "closed" });
    dispatch({ type: "cloudHowTo", open: false });
  }, [dispatch]);
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<{ kind: BotConfirmKind; bot: Bot } | null>(null);
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [newTeam, setNewTeam] = useState(false);
  const [teamMenu, setTeamMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const teamMotion = useHeldMenuMotion(teamMenu);
  const teamMenuReturn = useRef<HTMLElement | null>(null);
  const closeTeamMenu = () => {
    (teamMenuReturn.current?.isConnected ? teamMenuReturn.current : sidebarRef.current)?.focus();
    setTeamMenu(null);
  };
  const renamedTeam = (oldName: string, newName: string) => {
    const replace = (ids: string[]) => [...new Set(ids.map(id => id === userSectionId(oldName) ? userSectionId(newName) : id))];
    setCollapsedSections(current => { const next = replace(current); saveCollapsedSections(next); return next; });
    setSectionOrder(current => { const next = replace(current); saveSectionOrder(next); return next; });
    requestAnimationFrame(() => {
      const header = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])]
        .find(element => element.dataset.section === newName);
      (header?.querySelector<HTMLElement>("button") ?? header ?? sidebarRef.current)?.focus();
    });
  };
  const [deletingTeam, setDeletingTeam] = useState<string | null>(null);
  const [teamDeletePending, setTeamDeletePending] = useState(false);
  const teamDeleteRunning = useRef(false);
  const [moveToTeam, setMoveToTeam] = useState<string | null>(null);
  const [renameTeam, setRenameTeam] = useState<string | null>(null);
  const [shareTeam, setShareTeam] = useState<string | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);
  const deletingRoom = deletingRoomId ? state.groups.find((g) => g.id === deletingRoomId) : undefined;
  const [plusOpen, setPlusOpen] = useState(false);
  const plusMotion = useMenuMotion(plusOpen);
  const advanced = useAdvancedMode();
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionMotion = useMenuMotion(attentionOpen);
  const [attentionPinned, setAttentionPinnedState] = useState(() => loadSidebarAttentionPinned());
  const setAttentionPinned = (pinned: boolean) => {
    setAttentionPinnedState(pinned);
    saveSidebarAttentionPinned(pinned);
  };
  const [newRoom, setNewRoom] = useState(false);
  const [newFolderBotId, setNewFolderBotId] = useState<string | null>(null);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  // Chosen in Settings → Appearance; the header's collapse button only flips
  // between the avatar rail and the last expanded density.
  const storedDensity = useSidebarDensity();
  const density = collapseToIcons ? "icons" : storedDensity;
  const defaultWidth = density === "compact" ? 272 : 320;
  const sidePanelOpen = state.computerOpen || state.inspectorOpen;
  const maxSidebarWidth = sidePanelOpen ? defaultWidth : Math.min(480, window.innerWidth - 320);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSidebarWidth());
  const widthRef = useRef(sidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeTo = (width: number) => {
    const next = clampSidebarWidth(width, sidePanelOpen ? defaultWidth + 320 : window.innerWidth);
    if (next === Math.round(sidebarRef.current?.getBoundingClientRect().width ?? defaultWidth)) return null;
    widthRef.current = next;
    sidebarRef.current?.style.setProperty("--sidebar-width", `${next}px`);
    return next;
  };
  const finishResize = () => {
    setResizing(false);
    if (widthRef.current !== null) {
      setSidebarWidth(widthRef.current);
      saveSidebarWidth(widthRef.current);
    }
  };
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(
    () => density === "icons" ? "comfortable" : density,
  );
  const pinnedCircles = usePinnedCircles();
  const universalPins = useUniversalPins();
  const [pinnedCircleThreadsCollapsed, setPinnedCircleThreadsCollapsed] = useState(true);
  // Compact is the quiet sidebar: a row is its name and its status, nothing
  // else (see the `quiet` prop on BotListItem and GroupListItem).
  const quietRows = density === "compact";
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });

  // The density can change here or from Settings, so react to the value
  // rather than to either control.
  useEffect(() => {
    if (density !== "icons") setLastExpandedDensity(density);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
  }, [density]);

  const toggleCollapsed = () => {
    setSidebarDensity(density === "icons" ? lastExpandedDensity : "icons");
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open || confirm || deletingRoom) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, confirm, deletingRoom]);

  // Each header menu root wraps its trigger and its popover.
  const attentionMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(attentionOpen, attentionMenuRef, () => setAttentionOpen(false));
  usePopoverDismiss(plusOpen, plusMenuRef, () => setPlusOpen(false));

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
  // macOS owns inset traffic lights; Windows hides the native bar and draws
  // caption buttons over the header's right end. Either way this top row is
  // the window's drag handle (ChatView/GroupView headers do the same).
  const draggableChrome = macInset || capabilities.windowChrome === "win-caption";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = draggableChrome
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = draggableChrome
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
        preview(b, visibleMessages(b), state.instances).toLowerCase().includes(q) ||
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
  } = partitionSidebarBots(matchingBots, { universalPins });
  const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups(visibleGroups);

  // User sections keep first-appearance order. The saved layout keeps an
  // empty section's former slot so it returns there when content comes back.
  const sectionNames: string[] = (state.sections ?? []).filter((name) => !q || name.toLowerCase().includes(q.toLowerCase()));
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
    ...(pinnedBots.length > 0 && !universalPins ? [PINNED_SECTION_ID] : []),
    ...(unsectionedRooms.length > 0 ? [CHANNELS_SECTION_ID] : []),
    ...(botChats.length > 0 ? [BOT_CHATS_SECTION_ID] : []),
    ...(unsectionedBots.length > 0 ? [BOTS_SECTION_ID] : []),
    ...sectionNames.map(userSectionId),
  ];
  const sectionIds = orderedSidebarSections(naturalSectionIds, sectionOrder);
  // Circle mode removes these bots from the normal rows. Their thread list
  // stays at the bottom and is not part of the draggable section order.
  const showPinnedCircleThreads = pinnedCircleThreadListVisible(pinnedCircles, density, pinnedBots.length);
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
  // Every thread across every bot that needs the person right now — the
  // same rule and order as the sidebar tree, so the bell can never
  // disagree with it.
  const attention = crossBotAttentionThreads(state.bots, state.pendingQueued, undefined, state.groups);
  // Every pinned thread across every bot and room — the thread-level twin
  // of the built-in pinned-bots section, which only ever covered whole bots.
  const pinnedThreads = crossBotPinnedThreads(state.bots, state.groups, state.pendingQueued);
  const pendingBotUndo = teamFeedback?.restoreBot;
  const botRow = (bot: Bot) => botRowProps(state, dispatch, bot, { density, quiet: quietRows, query: q, onMenu: setMenu });

  return (
    <aside
      ref={sidebarRef}
      tabIndex={-1}
      aria-label={t("sidebar.aria")}
      data-native-view-overlay
      data-sidebar
      style={{ "--sidebar-width": `${widthRef.current ?? defaultWidth}px` } as CSSProperties}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel",
        resizing ? "transition-none" : "transition-[width] duration-200",
        density === "icons" ? "w-[80px]" : density === "compact" ? "w-[272px] md:w-[var(--sidebar-width)]" : "w-[320px] md:w-[var(--sidebar-width)]",
        sidePanelOpen ? density === "compact" ? "md:max-w-[272px]" : "md:max-w-[320px]" : "md:max-w-[calc(100vw-320px)]",
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
      {/* The bot list scrolls on under the head (top row, search, pinned
          panels) and the foot (places and profile), both liquid glass. The
          frame fills the sidebar, so the resize handle inside it still
          spans the sidebar's full height. */}
      <GlassScrollFrame className="flex-1">
      <GlassBar edge="top">
      {/* One top row: [traffic lights] [drag space] [server] [buttons].
          macOS owns inset traffic lights; Linux/Windows use native chrome.
          On macOS the row is twice the lights' centre line tall, so
          items-center puts every control on that line. The server switcher
          sits at the right, just left of the buttons, so the left stays an
          empty drag region clear of the lights; where the row is too tight
          for its name and a visible gap, it shows icon + chevron only, and
          the buttons never wrap. The row is `relative` so the switcher's
          error note hangs inside the sidebar.
          The icons rail is too narrow for a row and stacks instead, server
          switcher underneath. */}
      <div
        data-sidebar-top-row
        className={cn(
          "flex items-center",
          density === "icons" ? "flex-col gap-1 px-2 pt-3.5 pb-1" : "relative pl-4 pr-2",
          density !== "icons" && !macInset && "h-12",
        )}
        style={density !== "icons" && macInset ? { ...windowDragStyle, height: MAC_TRAFFIC_LIGHT_CENTER_Y * 2 } : windowDragStyle}
      >
        {macInset ? (
          // The lights span 16-76px on macOS 26; from the row's 16px inset this
          // ends 12px past them, so nothing clickable starts before 88px.
          <div aria-hidden="true" data-traffic-light-space className={density === "icons" ? "h-5 w-full" : "w-[72px] shrink-0"} />
        ) : browser ? (
          <div className={cn("flex shrink-0 items-center gap-2", density !== "icons" && "mr-3")}>
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : null}
        {density !== "icons" && (
          // Everything between the lights and the buttons; the switcher's
          // pill reads this slot's width (container `sidebar-top`). Once the
          // slot can hold a truncated name (96px), a 24px drag gap stays and
          // the name ellipsizes inside the 140px cap. Narrower than that, the
          // name hides and the spacer may shrink to nothing. On macOS at
          // 320px the slot is about 121px in Advanced and 189px in Simple.
          <div data-sidebar-top-slot className="@container/sidebar-top flex min-w-0 flex-1 items-center">
            {/* Empty, so it stays a drag region; it takes the slack, which
                keeps the switcher beside the buttons. The 24px floor applies
                only while the name is showing, so a 240px sidebar can still
                fit icon and chevron. */}
            <div data-sidebar-top-spacer className="min-w-0 flex-1 @min-[96px]/sidebar-top:min-w-6" />
            {/* Gives way first when the row is tight; only the switcher's own
                button opts out of the drag region. */}
            <div data-sidebar-top-switcher className="flex min-w-0 max-w-[140px] items-center">
              <DesktopWorkspaceSwitcher inline cloudHome={state.config?.cloudHome === true} owner={cloudOwner} howTo={state.cloudHowTo} onMenuClosed={endHowTo} />
            </div>
          </div>
        )}
        <div
          data-sidebar-top-buttons
          className={cn("relative flex shrink-0 items-center", density === "icons" ? "flex-col gap-1" : "ml-0.5 gap-0.5")}
          style={windowNoDragStyle}
        >
          {/* Simple mode keeps only "+". Expand stays so an icons rail is never a dead end. */}
          {!collapseToIcons && (advanced || density === "icons") && <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={density === "icons" ? t("sidebar.density.expand") : t("sidebar.density.collapseAria")}
            className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            title={density === "icons" ? t("sidebar.density.expand") : t("sidebar.density.collapse")}
          >
            {density === "icons" ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>}
          {advanced && <div ref={attentionMenuRef} className={density === "icons" ? "relative" : "contents"}>
            <button
              type="button"
              onClick={() => setAttentionOpen((o) => !o)}
              aria-label={attentionTriggerLabel(attention.length)}
              title={attentionTriggerLabel(attention.length)}
              className="relative flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Activity size={17} strokeWidth={2} />
              {attention.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-0.5 text-[9.5px] font-semibold leading-4 text-ink">{attention.length > 9 ? "9+" : attention.length}</span>
              )}
              {attentionHasRunningWork(attention) && (
                <span data-header-activity="" className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-success" aria-hidden="true" />
              )}
            </button>
            {attentionMotion.shown && (
              <>
                <div className={cn(
                  "absolute top-full z-40 mt-1 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                  density === "icons" ? "left-0" : "right-0",
                  density === "icons" ? "w-72" : density === "compact" ? "w-60 md:w-[min(240px,calc(var(--sidebar-width)_-_32px))]" : "w-72 md:w-[min(288px,calc(var(--sidebar-width)_-_32px))]",
                  attentionMotion.className,
                )} {...attentionMotion.exitProps}>
                  <div className="flex items-center gap-1 pb-1 pl-3.5 pr-2 pt-1.5">
                    <span className="flex-1 text-[13px] font-medium text-ink">{t("attention.title")}</span>
                    <button
                      type="button"
                      onClick={() => setAttentionPinned(!attentionPinned)}
                      aria-label={t(attentionPinned ? "attention.unpin" : "attention.pin")}
                      title={t(attentionPinned ? "attention.unpin" : "attention.pin")}
                      className="flex size-6 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {attentionPinned ? <PinOff size={14} /> : <Pin size={14} />}
                    </button>
                  </div>
                  {attention.length === 0 ? (
                    <div className="px-3.5 py-2.5 text-[13px] text-ink-secondary">{t("attention.empty")}</div>
                  ) : (
                    <AttentionThreadRows entries={attention} onJump={(entry) => { setAttentionOpen(false); dispatch(attentionJumpAction(entry)); }} />
                  )}
                </div>
              </>
            )}
          </div>}
          {/* `contents` keeps the popover anchored to the header row */}
          <div ref={plusMenuRef} className="contents">
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")}
            className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            title={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")}
          >
            <Plus size={17} strokeWidth={2} />
          </button>
          {plusMotion.shown && (
            <>
              <div className={cn(
                "absolute top-full z-40 mt-1 w-52 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
                plusMotion.className,
              )} {...plusMotion.exitProps}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    dispatch({ type: "toggleNewBot", open: true });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  <span className="flex-1">{t("sidebar.newBot")}</span>
                  <ShortcutHint id="new-bot" />
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
                {!remoteClient && <button
                  onClick={() => { setPlusOpen(false); setNewTeam(true); }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <FolderPlus size={16} className="text-ink-secondary" /> {t("team.create")}
                </button>}
                {!remoteClient && <>
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
      </div>

      {density === "icons" && <DesktopWorkspaceSwitcher compact cloudHome={state.config?.cloudHome === true} owner={cloudOwner} howTo={state.cloudHowTo} onMenuClosed={endHowTo} />}
      <OrganizationIdentity compact={density === "icons"} />
      {/* Search */}
      <div className={cn("pt-1 pb-3", density === "icons" ? "hidden" : "px-3")}>
        <div className="flex items-center gap-2 rounded-md border border-hairline/40 bg-inset/40 px-2.5 py-1.5 focus-within:border-focus">
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

      {universalPins && pinnedBots.length > 0 && (
        <div
          data-sidebar-universal-pins=""
          // vh, not %: inside the glass head a percentage has no height to
          // resolve against and would stop capping the list.
          className="max-h-[min(40vh,280px)] shrink-0 overflow-y-auto border-b border-hairline/40 px-2 pb-2"
        >
          {density !== "icons" && !pinnedCircles && (
            <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              {t("sidebar.section.pinned")}
            </div>
          )}
          <PinnedBotRoster
            bots={pinnedBots}
            density={density}
            circles={pinnedCircles}
            row={botRow}
          />
        </div>
      )}

      {attentionPinned && density !== "icons" && (
        <SidebarAttentionPanel
          entries={attention}
          density={density}
          onUnpin={() => setAttentionPinned(false)}
          onJump={(entry) => dispatch(attentionJumpAction(entry))}
          collapsed={sectionCollapsed(ATTENTION_SECTION_ID)}
          onToggle={layoutInteractive ? () => toggleSection(ATTENTION_SECTION_ID) : undefined}
        />
      )}

      {density !== "icons" && (
        <SidebarPinnedThreadsPanel
          entries={pinnedThreads}
          density={density}
          now={now}
          onJump={(entry) => dispatch(attentionJumpAction(entry))}
          onUnpin={(entry) => dispatch(attentionUnpinAction(entry))}
          collapsed={sectionCollapsed(PINNED_THREADS_SECTION_ID)}
          onToggle={layoutInteractive ? () => toggleSection(PINNED_THREADS_SECTION_ID) : undefined}
        />
      )}
      </GlassBar>

      {density !== "icons" && <div
        role="separator"
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={240}
        aria-valuemax={maxSidebarWidth}
        aria-valuenow={Math.min(sidebarWidth ?? defaultWidth, maxSidebarWidth)}
        tabIndex={0}
        data-sidebar-resize
        className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none hover:bg-accent/20 focus-visible:bg-accent/30 md:block"
        style={windowNoDragStyle}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const next = resizeTo(event.clientX - (sidebarRef.current?.getBoundingClientRect().left ?? 0));
          if (next !== null) event.currentTarget.setAttribute("aria-valuenow", String(next));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) finishResize();
        }}
        onPointerCancel={finishResize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const limit = sidePanelOpen ? defaultWidth : Math.min(480, window.innerWidth - 320);
          const next = resizeTo(Math.min(widthRef.current ?? defaultWidth, limit) + (event.key === "ArrowRight" ? 16 : -16));
          if (next === null) return;
          setSidebarWidth(next);
          saveSidebarWidth(next);
        }}
      />}

      {/* Bot list */}
      <GlassScroller className="px-2">
        <div className="flex flex-col gap-0.5">
          {matchingBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">{t("sidebar.noMatch", { query })}</div>
          )}
          {unsectionedChief && (
            <div className="mb-1.5">
              <BotListItem {...botRow(unsectionedChief)} />
            </div>
          )}
          {sectionIds.map((id, index) => {
            const sectionName = userSectionName(id);
            const sectionChiefItems = sectionName
              ? sectionChiefs.filter((bot) => bot.section === sectionName)
              : [];
            const sectionGroupItems =
              id === CHANNELS_SECTION_ID
                ? unsectionedRooms
                : id === BOT_CHATS_SECTION_ID
                  ? botChats
                  : sectionName
                    ? sectionedRooms.filter((group) => group.section === sectionName)
                    : [];
            const sectionBotItems =
              id === PINNED_SECTION_ID
                ? pinnedBots
                : id === BOTS_SECTION_ID
                  ? unsectionedBots
                  : sectionName
                    ? sectionedBots.filter((bot) => bot.section === sectionName)
                    : [];
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
                    onContextMenu={!remoteClient && layoutInteractive && sectionName ? (event) => {
                      event.preventDefault();
                      teamMenuReturn.current = event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget;
                      setTeamMenu({ name: sectionName, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)) });
                    } : undefined}
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
                    onDelete={!remoteClient && sectionName ? () => setDeletingTeam(sectionName) : undefined}
                  />
                )}
                {collapsed && queued.length > 0 && <button type="button" onClick={() => toggleSection(id)}
                  title={`${t("task.queued")} · ${queued.join(", ")}`} aria-label={`${t("sidebar.section.expand", { name: sectionLabel(id) })} · ${t("task.queued")} · ${queued.join(", ")}`}
                  className="mx-3 mb-1 self-start rounded bg-raised/50 px-2 py-0.5 text-[10px] text-ink-secondary hover:text-ink">{t("task.queued")} · {queued.length}</button>}
                {!collapsed && (
                  <>
                    {sectionChiefItems.map((bot) => <BotListItem key={bot.id} {...botRow(bot)} />)}
                    {sectionGroupItems.map((group) => (
                      <GroupListItem
                        key={group.id}
                        group={group}
                        density={density}
                        quiet={quietRows}
                        query={q}
                        onMenu={setRoomMenu}
                      />
                    ))}
                    {id === PINNED_SECTION_ID ? (
                      <PinnedBotRoster
                        bots={sectionBotItems}
                        density={density}
                        circles={pinnedCircles}
                        row={botRow}
                      />
                    ) : sectionBotItems.map((bot) => <BotListItem key={bot.id} {...botRow(bot)} />)}
                    {!remoteClient && sectionName && layoutInteractive && (
                      <button onClick={() => setMoveToTeam(sectionName)} aria-label={t(state.bots.some(bot => !bot.hidden && bot.section?.trim() === sectionName) ? "team.manageBotsIn" : "team.addBotsTo", { name: sectionName })}
                        className="mx-3 my-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">
                        <Plus size={13} /> {t(state.bots.some(bot => !bot.hidden && bot.section?.trim() === sectionName) ? "team.manageBots" : "team.addBots")}
                      </button>
                    )}
                  </>
                )}
                {dropTarget?.id === id && dropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
              </div>
            );
          })}
          <SearchResults query={query} onLanded={() => setQuery("")} />
          {showPinnedCircleThreads && (
            <PinnedCircleThreadSection
              bots={pinnedBots}
              collapsed={pinnedCircleThreadsCollapsed}
              onToggle={() => setPinnedCircleThreadsCollapsed((collapsed) => !collapsed)}
              row={botRow}
            />
          )}
        </div>
      </GlassScroller>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

      <GlassBar edge="bottom">
      {/* This window's Live call, while its chat is not on screen. Outside
          the scrolling sections, so it always shows. */}
      <LiveCallPill
        currentBotId={state.activeView === "chat" ? state.selectedId : null}
        onOpen={(botId, threadId) => openThread(dispatch, { botId, threadId }, state)}
        iconOnly={density === "icons"}
      />

      {/* Footer */}
      <div className={cn("pb-3 pt-2", density === "icons" ? "px-2" : "px-3")}>
        <SidebarFooterNav
          density={density}
          collapsed={sectionCollapsed(TOOLS_SECTION_ID)}
          onToggleCollapsed={layoutInteractive ? () => toggleSection(TOOLS_SECTION_ID) : undefined}
        />
        {density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
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
          // The place rows and the profile row are two different kinds of
          // thing — places to go, versus who you are and what the app is —
          // so they get clear space between them (none when Simple mode has
          // no place rows and the profile row leads). A hairline lived here
          // briefly and made it worse: full-bleed, it ran within a few pixels
          // of the profile row's rounded hover pill, and the two hover states
          // read as one crowded block rather than two rows. Apps sits at the
          // end of the profile row.
          <div className="flex items-center gap-1 not-first:mt-3">
            <div className="min-w-0 flex-1">
              <SidebarProfileMenu />
            </div>
            <SidebarAppsButton />
          </div>
        )}
      </div>
      </GlassBar>
      </GlassScrollFrame>

      <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={requestArchive}
          onDelete={(bot) => setConfirm({ kind: "delete", bot })}
          onMoveToSection={(botId) => {
            if (!menu) return;
            setSectionPicker({ botId, x: menu.x, y: menu.y });
          }}
          onNewFolder={setNewFolderBotId}
        />
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
      {newTeam && <TeamDialog onClose={() => setNewTeam(false)} />}
      {renameTeam && <TeamDialog section={renameTeam} rename onRenamed={renamedTeam} onClose={() => setRenameTeam(null)} />}
      {teamMotion.shown && teamMotion.value && createPortal(<div className={cn("fixed inset-0 z-40", teamMotion.closing && "pointer-events-none")} onMouseDown={closeTeamMenu}>
        <div role="menu" aria-label={teamMotion.value.name} style={{ left: teamMotion.value.x, top: teamMotion.value.y }}
          className={cn("absolute w-[220px] rounded-xl border border-hairline/50 bg-menu p-1.5 text-ink shadow-xl", teamMotion.className)} {...teamMotion.exitProps}
          onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
            if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeTeamMenu(); return; }
            navigateThreadMenu(event);
          }}>
          <TeamMenuItems
            onAddBots={() => { closeTeamMenu(); setMoveToTeam(teamMotion.value!.name); }}
            onRename={() => { closeTeamMenu(); setRenameTeam(teamMotion.value!.name); }}
            onShare={() => { closeTeamMenu(); setShareTeam(teamMotion.value!.name); }}
            onDelete={() => { closeTeamMenu(); setDeletingTeam(teamMotion.value!.name); }}
          />
        </div>
      </div>, document.body)}
      <ConfirmDialog open={deletingTeam !== null} title={t("team.deleteTitle", { name: deletingTeam ?? "" })}
        body={t("team.deleteKeepBotsDescription")} confirmLabel={t("team.delete")} returnFocusRef={sidebarRef}
        pending={teamDeletePending}
        onCancel={() => { if (!teamDeleteRunning.current) setDeletingTeam(null); }} onConfirm={() => {
          const name = deletingTeam;
          if (!name || teamDeleteRunning.current) return;
          teamDeleteRunning.current = true;
          setTeamDeletePending(true);
          void api(`/api/sidebar-sections?section=${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(({ sections }) => { dispatch({ type: "sectionDeleted", section: name, sections }); setDeletingTeam(null); })
            .catch(cause => setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) }))
            .finally(() => { teamDeleteRunning.current = false; setTeamDeletePending(false); });
        }} />
      {moveToTeam && <TeamDialog section={moveToTeam} onClose={() => setMoveToTeam(null)} />}
      {shareTeam !== null && <ShareTeamDialog team={shareTeam} onClose={() => setShareTeam(null)} />}
      <SectionPicker
          current={sectionPicker ? state.bots.find((b) => b.id === sectionPicker.botId)?.section : undefined}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => {
            if (!sectionPicker) return;
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
      <RoomContextMenu
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => {
            if (!roomMenu) return;
            setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y });
          }}
          onDelete={(groupId) => {
            // The closing menu remains mounted briefly for its exit animation.
            // Give the dialog a stable opener instead of that disappearing item.
            sidebarRef.current?.focus();
            setDeletingRoomId(groupId);
          }}
        />
      <ConfirmDialog
        open={deletingRoom !== undefined}
        {...roomDeleteCopy(deletingRoom ?? { name: "" })}
        icon={<Trash2 size={18} />}
        returnFocusRef={sidebarRef}
        onCancel={() => setDeletingRoomId(null)}
        onConfirm={() => {
          // Read the room from live state: it may have been removed elsewhere
          // while the dialog was open.
          const groupId = deletingRoom?.id;
          setDeletingRoomId(null);
          if (groupId) dispatch({ type: "deleteGroup", groupId });
        }}
      />
      <SectionPicker
          current={roomSectionPicker ? state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section : undefined}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) => {
            if (!roomSectionPicker) return;
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } });
          }}
        />
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
                (result.members === 0 && result.presets
                  ? t("sidebar.presetsImported", { count: result.presets })
                  : result.members === 1
                  ? t("sidebar.teamImportedOne")
                  : t("sidebar.teamImportedMany", { count: result.members })) +
                (result.connections ? ` · ${t("sidebar.connectionsToFinish", { count: result.connections })}` : ""),
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
