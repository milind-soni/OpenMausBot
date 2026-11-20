import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { overlayPortal as createPortal } from "@/components/ModalPresence";
import { Archive, BellDot, CheckCheck, ClipboardCopy, Copy, Crown, FolderOpen, FolderPlus, Loader2, MessagesSquare, Pause, Pencil, Pin, PinOff, Play, SquarePen, Trash2, Users } from "lucide-react";
import { isBotHeld, isEveryBotPaused, isPausedHere, setEveryBotPaused, setPaused } from "@/lib/bot-pause";
import { api, useStore, openBot, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useHeldMenuMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { BotDeleteMenuItem, useDeleteAllThreads } from "./BotMenuDelete";
import { DemoteDefaultBotItem, HideDefaultBotItem } from "./DefaultBotControls";
import { navigateThreadMenu } from "./BotProjects";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { userBotMenu } from "@/lib/own-team-bot";
import { botUnreadThreadIds, markBotRead } from "@/lib/folder-read";
import { ownerMenuLabel, pickOwnerOf } from "./TeamOwner";
import { mayChangeOwner, useTeamPeople } from "@/state/team-people";
import { MENU_ITEM, MENU_ITEM_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { useShowThreads } from "@/lib/thread-preferences";
import { submenuPosition } from "./SidebarPopoverMenu";
import { submenuIntent, type SubmenuIntent } from "@/lib/submenu-intent";
import { useMoveToMyCloud } from "./MoveToMyCloud";
import { useMoveToTeam } from "./MoveToTeam";
import type { MenuState } from "./Sidebar";
import { useMayMoveBots } from "./bot-sections";
import { openBotSettings } from "./bot-panel/panel-link";

type Flyout = "more" | "move";

export function BotContextMenu({
  menu, onClose, onArchive, onDelete, onMoveToSection, onNewFolder, onNewTaskFolder,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onDelete: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
  onNewFolder: (botId: string) => void;
  onNewTaskFolder: (botId: string) => void;
  onRename?: (botId: string) => void;
  /** Simple: "New department…" names a department in the sidebar, with this bot in it. */
  onNewSection?: (botId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);

  const moreRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const hoveredRow = useRef<Element | null>(null);
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const [, setMoreEngaged] = useState(false);
  const moreIntent = useRef<SubmenuIntent | null>(null);
  moreIntent.current ??= submenuIntent({
    open: (key) => setFlyout(key as Flyout),
    close: () => { setFlyout(null); setMoreEngaged(false); },
    submenuBox: () => flyoutRef.current?.getBoundingClientRect() ?? null,
  });
  const flyoutRow = (key: Flyout | null) => (key === "more" ? moreRef.current : key === "move" ? moveRef.current : null);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const admin = useOwnerOrAdmin();
  const member = admin === false;
  const mayMove = useMayMoveBots();
  const clearThreads = useDeleteAllThreads(false), moveToTeam = useMoveToTeam({ blocked: (bot) => (bot.defaultBot ? t("teamMove.blockedDefault", { name: bot.name }) : bot.chiefOfStaff ? t("teamMove.blockedChief") : state.bots.filter((candidate) => !candidate.hidden).length <= 1 ? t("teamMove.blockedLast") : undefined) });
  const moveToCloud = useMoveToMyCloud();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const bot = shown ? state.bots.find((b) => b.id === shown.botId) : undefined;
  const team = useTeamPeople();
  const menuRef = useRef<HTMLDivElement>(null);
  const latestMenu = useRef(menu);
  useLayoutEffect(() => { latestMenu.current = menu; }, [menu]);
  const readInFlight = useRef(false);
  const [readingBotId, setReadingBotId] = useState<string | null>(null);
  const [readError, setReadError] = useState<{ botId: string; message: string } | null>(null);
  useEffect(() => { setReadError(null); }, [menu?.botId]);
  const readAll = async (owner: Bot) => {
    if (readInFlight.current) return;
    readInFlight.current = true;
    setReadingBotId(owner.id);
    setReadError(null);
    const openedMenu = menu;
    try {
      await markBotRead(owner, api, (updated) => dispatch({ type: "botPatched", bot: updated }));
      if (latestMenu.current === openedMenu) onClose();
    } catch (error) {
      const guidance = t("sidebar.bot.markAllReadFailed");
      setReadError({ botId: owner.id, message: error instanceof Error ? `${guidance} ${error.message}` : guidance });
    } finally {
      readInFlight.current = false;
      setReadingBotId(null);
    }
  };
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !shown) return;
    const place = () => {
      const { width, height } = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(shown.y, window.innerHeight - height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(shown.x, window.innerWidth - width - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  // Kept apart from the listeners: onClose is fresh every render, and re-running this would pull focus back to the
  // first item.
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
  useEffect(() => {
    moreIntent.current?.reset();
    hoveredRow.current = null;
    setFlyout(null);
    setMoreEngaged(false);
  }, [menu]);
  useEffect(() => () => moreIntent.current?.reset(), []);
  useLayoutEffect(() => {
    const sheetOut = flyoutRef.current, row = flyoutRow(flyout), sheet = menuRef.current;
    if (!sheetOut || !row || !sheet) return;
    const place = submenuPosition(sheet.getBoundingClientRect(), row.getBoundingClientRect(), { width: sheetOut.offsetWidth, height: sheetOut.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    sheetOut.style.left = `${place.left}px`;
    sheetOut.style.top = `${place.top}px`;
  });

  if (!motion.shown || !bot || !shown) return <>{clearThreads.dialog}{moveToTeam.dialog}{moveToCloud.dialog}</>;
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
  const user = userBotMenu(bot, team?.me?.email), ownEdit = Boolean(team) && user.duplicate;
  const ownDelete = () => !team || !user.delete ? []
    : user.delete === "shared" ? [item(<Trash2 size={16} />, t("common.delete"), undefined, { danger: true, disabled: true, hint: t("sidebar.bot.deleteSharedAdminOnly") })]
      : [<BotDeleteMenuItem key="delete" deleting={deleting} className={MENU_ITEM} onClick={() => { onClose(); onDelete(bot); }} />];
  const chiefItem = () => item(
    <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
    bot.chiefOfStaff ? t("sidebar.bot.removeChief") : t("sidebar.bot.makeChief"),
    () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
    member ? { disabled: true, hint: t("sidebar.bot.chiefAdminOnly") }
      : { disabled: !bot.chiefOfStaff && !canCoordinate, hint: !bot.chiefOfStaff && !canCoordinate ? t("sidebar.bot.chiefNeedsEngine") : undefined },
  );
  const openForSettings = () => {
    if (state.selectedId === bot.id) dispatch({ type: "select", id: bot.id });
    else openBot(dispatch, bot, showThreads);
  };
  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string; keepOpen?: boolean },
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        if (!opts?.keepOpen) onClose();
      }}
      title={opts?.hint}
      className={cn(
        MENU_ITEM,
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-menu-hover",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} role="separator" className={MENU_ITEM_SEPARATOR} />;

  // Only the owner or an admin pauses; a bot paused with its department is resumed from the department's menu.
  const pausedHere = isPausedHere(state.config, "bot", bot.id), everyBotPaused = isEveryBotPaused(state.config);
  const pause = admin !== true ? null : item(pausedHere ? <Play size={16} className="text-ink-secondary" /> : <Pause size={16} className="text-ink-secondary" />,
    t(pausedHere ? "pause.resumeBot" : "pause.pauseBot"),
    () => { void setPaused("bot", bot.id, !pausedHere).catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) })); },
    !pausedHere && isBotHeld(state.config, bot.id) ? { disabled: true, hint: t(everyBotPaused ? "pause.byAll" : "pause.byDepartment") } : undefined);
  const pauseAll = admin !== true ? null : item(everyBotPaused ? <Play size={16} className="text-ink-secondary" /> : <Pause size={16} className="text-ink-secondary" />,
    t(everyBotPaused ? "pause.resumeAll" : "pause.pauseAll"),
    () => { void setEveryBotPaused(!everyBotPaused).catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) })); });

  const viewThreads = item(<MessagesSquare size={16} className="text-ink-secondary" />, t("sidebar.bot.simple.viewThreads"), () => {
    openForSettings();
    openBotSettings(dispatch, "history", { botId: bot.id });
  });



  return <>{clearThreads.dialog}{moveToTeam.dialog}{moveToCloud.dialog}{createPortal(
    <div
      ref={menuRef}
      data-bot-menu
      data-sidebar
      role="menu" data-look="menu"
      aria-label={t("sidebar.bot.actions", { name: bot.name })}
      onKeyDown={navigateThreadMenu}
      style={{ top: shown.y, left: shown.x }}
      className={cn("fixed z-40 max-h-[calc(100dvh-16px)] w-max min-w-[198px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain", MENU_SHEET, motion.className)} {...motion.exitProps}
    >
      {showThreads && <>
        {item(<SquarePen size={16} className="text-ink-secondary" />, t("task.newShort"), () => dispatch({ type: "newTask", botId: bot.id }))}
        {admin && item(<FolderOpen size={16} className="shrink-0 text-ink-secondary" />, t("task.folder.new"), () => onNewTaskFolder(bot.id))}
        {item(<FolderPlus size={16} className="text-ink-secondary" />, t("folder.new"), () => onNewFolder(bot.id))}
      </>}
      {viewThreads}
      {!member && item(<Trash2 size={16} />, t("task.deleteAll"), () => clearThreads.ask(bot.id), { danger: true })}
      {divider("threads")}
      {team && mayChangeOwner(bot, team) && item(<Users size={16} className="text-ink-secondary" />, ownerMenuLabel(bot, team), () => pickOwnerOf(bot, team, shown))}
      {remoteClient ? [
        mayMove && item(<FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.bot.moveToSection"), () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.editProfile"), () => {
          openForSettings();
          if (!state.settingsOpen) dispatch({ type: "toggleSettings", open: true });
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
        team ? null : chiefItem(),
        mayMove && item(<FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.bot.moveToSection"), () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, t("sidebar.bot.markUnread"), () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        item(
          readingBotId === bot.id ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <CheckCheck size={16} className="text-ink-secondary" />,
          readingBotId === bot.id ? t("sidebar.bot.markingAllRead") : t("sidebar.bot.markAllRead"),
          () => { void readAll(bot); },
          { disabled: readingBotId !== null || botUnreadThreadIds(bot).length === 0, keepOpen: true },
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.editProfile"), () => {
          openForSettings();
          if (!state.settingsOpen) dispatch({ type: "toggleSettings", open: true });
        }),
        (!member || ownEdit) && item(<Copy size={16} className="text-ink-secondary" />, t("sidebar.bot.duplicate"), () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        pause,
        pauseAll,
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => {
          void copyText(bot.threadId);
        }),
        divider("d3"), ...moveToTeam.items(bot, item), ...moveToCloud.items(bot, item),
        ...(bot.defaultBot ? [<HideDefaultBotItem key="hide" bot={bot} onDone={onClose} className={MENU_ITEM} />, ...(member ? [] : [<DemoteDefaultBotItem key="demote" bot={bot} onDone={onClose} className={MENU_ITEM} />])] : member ? ownDelete() : [
          item(<Archive size={16} className="text-ink-secondary" />, t("sidebar.bot.archive"), () => onArchive(bot), { disabled: archiveBlocked, hint: archiveHint }),
          <BotDeleteMenuItem key="delete" deleting={deleting} className={MENU_ITEM} onClick={() => { onClose(); onDelete(bot); }} />,
        ]),
      ]}
      {readError?.botId === bot.id && <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">{readError.message}</p>}
    </div>,
    document.body,
  )}</>;
}
