import { OrganizationIdentity } from "./OrganizationIdentity";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Archive,
  Bot as BotIcon,
  CalendarDays,
  Check,
  FolderPlus,
  Library,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";

import { InitialsAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel } from "./TeamLibraryPanel";
import { TeamDialog } from "./TeamDialog";
import { BotProjectDialog } from "./BotProjects";
import { FOLDER_DRAG_TYPE } from "@/lib/folder-order";
import {
  loadCollapsedSections,
  loadSectionOrder,
  loadSidebarAttentionPinned,
  loadSidebarDensity,
  saveCollapsedSections,
  saveSectionOrder,
  saveSidebarAttentionPinned,
  saveSidebarDensity,
  toggleCollapsedSection,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sameSectionOrder,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarMoreMenu } from "./SidebarMoreMenu";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";
import { profileInitials, SidebarProfileMenu } from "./SidebarProfileMenu";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { useShowThreads } from "@/lib/thread-preferences";
import { AttentionThreadRows, crossBotAttentionThreads, sidebarBotActivityTasks } from "./SidebarBotActivity";
import { SidebarAttentionPanel } from "./SidebarAttentionPanel";
import { ShortcutHint } from "./ShortcutHint";

import { BotListItem, preview } from "./sidebar/BotListItem";
import { BotContextMenu, type MenuState } from "./sidebar/BotContextMenu";
import { GroupListItem } from "./sidebar/GroupListItem";
import { RoomContextMenu } from "./sidebar/RoomContextMenu";
import { NewRoomPanel } from "./sidebar/NewRoomPanel";
import { SectionPicker } from "./sidebar/SectionPicker";
import { ArchivedBotsPanel } from "./sidebar/ArchivedBots";
import { currentArchivableBot, botConfirmCopy, type BotConfirmKind } from "./sidebar/BotConfirm";

export { GroupListItem, GroupThreadList } from "./sidebar/GroupListItem";
export { BotContextMenu } from "./sidebar/BotContextMenu";
export { ArchivedBotRow } from "./sidebar/ArchivedBots";
export {
  archivedDeleteAllCopy,
  BotDeleteMenuItem,
  botConfirmCopy,
  type BotConfirmKind,
  currentArchivableBot,
} from "./sidebar/BotConfirm";
export { BotThreadList } from "./sidebar/BotThreadList";
export { BotListItem } from "./sidebar/BotListItem";

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

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const attentionRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<{ kind: BotConfirmKind; bot: Bot } | null>(null);
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [newTeam, setNewTeam] = useState(false);
  const [moveToTeam, setMoveToTeam] = useState<string | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
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
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    setDensityOpen(false);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
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
    if (!plusOpen) return;
    const closePlusMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPlusOpen(false);
        importReturnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closePlusMenu);
    return () => window.removeEventListener("keydown", closePlusMenu);
  }, [plusOpen]);

  useEffect(() => {
    if (!attentionOpen) return;
    const closeAttentionMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAttentionOpen(false);
        attentionRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeAttentionMenu);
    return () => window.removeEventListener("keydown", closeAttentionMenu);
  }, [attentionOpen]);

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
  const attention = crossBotAttentionThreads(state.bots, state.pendingQueued);
  const pendingBotUndo = teamFeedback?.restoreBot;

  return (
    <aside
      ref={sidebarRef}
      tabIndex={-1}
      aria-label={t("sidebar.aria")}
      data-native-view-overlay
      data-sidebar
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel transition-[width] duration-200",
        density === "icons" ? "w-[80px]" : density === "compact" ? "w-[272px]" : "w-[320px]",
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
            ref={attentionRef}
            type="button"
            onClick={() => setAttentionOpen((o) => !o)}
            aria-label={t("attention.title")}
            title={t("attention.title")}
            className="relative flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Activity size={20} strokeWidth={2} />
            {attention.length > 0 && (
              <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-accent px-0.5 text-[9.5px] font-semibold leading-4 text-ink">{attention.length > 9 ? "9+" : attention.length}</span>
            )}
          </button>
          {attentionOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setAttentionOpen(false)} />
              <div className={cn(
                "absolute top-full z-40 mt-1 w-72 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <div className="flex items-center gap-1 pb-1 pl-3.5 pr-2 pt-1.5">
                  <span className="flex-1 text-[13px] font-medium text-ink">{t("attention.title")}</span>
                  <button
                    type="button"
                    onClick={() => setAttentionPinned(!attentionPinned)}
                    aria-label={t(attentionPinned ? "attention.unpin" : "attention.pin")}
                    title={t(attentionPinned ? "attention.unpin" : "attention.pin")}
                    className="flex size-6 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
                  >
                    {attentionPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </div>
                {attention.length === 0 ? (
                  <div className="px-3.5 py-2.5 text-[13px] text-ink-secondary">{t("attention.empty")}</div>
                ) : (
                  <AttentionThreadRows entries={attention} onJump={(entry) => { setAttentionOpen(false); dispatch({ type: "switchTask", botId: entry.botId, threadId: entry.task.threadId }); }} />
                )}
              </div>
            </>
          )}
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
                "absolute top-full z-40 mt-1 w-52 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    dispatch({ type: "openOverlay", kind: "newBot", open: true });
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

      <DesktopWorkspaceSwitcher compact={density === "icons"} />
      <OrganizationIdentity compact={density === "icons"} />
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

      {attentionPinned && density !== "icons" && (
        <SidebarAttentionPanel
          entries={attention}
          density={density}
          onUnpin={() => setAttentionPinned(false)}
          onJump={(entry) => dispatch({ type: "switchTask", botId: entry.botId, threadId: entry.task.threadId })}
        />
      )}

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
                menu={menu}
                onMenu={setMenu}
              />
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
                        menu={menu}
                        onMenu={setMenu}
                      />
                    ))}
                    {sectionGroupItems.map((group) => (
                      <GroupListItem
                        key={group.id}
                        group={group}
                        density={density}
                        query={q}
                        menu={roomMenu}
                        onMenu={setRoomMenu}
                      />
                    ))}
                    {sectionBotItems.map((bot) => (
                      <BotListItem
                        key={bot.id}
                        bot={bot}
                        density={density}
                        query={q}
                        menu={menu}
                        onMenu={setMenu}
                      />
                    ))}
                    {!remoteClient && sectionName && layoutInteractive && sectionChiefItems.length + sectionGroupItems.length + sectionBotItems.length === 0 && (
                      <button onClick={() => setMoveToTeam(sectionName)} aria-label={t("team.addBotsTo", { name: sectionName })}
                        className="mx-3 my-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">
                        <Plus size={13} /> {t("team.addBots")}
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
            data-tour="nav-automations"
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
            onClick={() => dispatch({ type: "openOverlay", kind: "plugins", open: true })}
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
                tourId: "nav-automations",
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
                tourId: "nav-apps",
                label: t("sidebar.nav.connectedApps"),
                icon: <Puzzle size={18} />,
                onSelect: () => dispatch({ type: "openOverlay", kind: "plugins", open: true }),
              },
            ]}
          />
        )}
        {density === "icons" ? (
          <div className="flex items-center justify-center">
            <button
              onClick={() => dispatch({ type: "openOverlay", kind: "appSettings", open: true })}
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
      {newTeam && <TeamDialog onClose={() => setNewTeam(false)} />}
      {moveToTeam && <TeamDialog section={moveToTeam} onClose={() => setMoveToTeam(null)} />}
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          returnFocusRef={sidebarRef}
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
          returnFocusRef={importReturnRef}
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
