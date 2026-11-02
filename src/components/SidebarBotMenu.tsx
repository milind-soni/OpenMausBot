import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, BellDot, Check, CheckCheck, ChevronRight, ClipboardCopy, Copy, Crown, FolderMinus, FolderOpen, FolderPlus, Loader2, MoreHorizontal, Pencil, Pin, PinOff, SquarePen, Trash2, Users } from "lucide-react";
import { api, useStore, openBot, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useHeldMenuMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { allThreadRows, BotDeleteMenuItem, useDeleteAllThreads } from "./BotMenuDelete";
import { HideDefaultBotItem } from "./DefaultBotControls";
import { navigateThreadMenu } from "./BotProjects";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { botUnreadThreadIds, markBotRead } from "@/lib/folder-read";
import { ownerMenuLabel, pickOwnerOf } from "./TeamOwner";
import { mayChangeOwner, useTeamPeople } from "@/state/team-people";
import { MENU_ITEM, MENU_ITEM_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { useShowThreads } from "@/lib/thread-preferences";
import { submenuPosition } from "./SidebarPopoverMenu";
import { submenuIntent, type SubmenuIntent } from "@/lib/submenu-intent";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useMoveToTeam } from "./MoveToTeam";
import type { MenuState } from "./Sidebar";
import { departmentNames, moveBotsToSection, useMayMoveBots } from "./bot-sections";

type Flyout = "more" | "move";

export function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onDelete,
  onMoveToSection,
  onNewFolder,
  onNewTaskFolder,
  onRename,
  onNewSection,
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
  const simpleMenu = !useAdvancedMode();
  const moreRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const hoveredRow = useRef<Element | null>(null);
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const [moreEngaged, setMoreEngaged] = useState(false);
  const moreIntent = useRef<SubmenuIntent | null>(null);
  moreIntent.current ??= submenuIntent({
    open: (key) => setFlyout(key as Flyout),
    close: () => { setFlyout(null); setMoreEngaged(false); },
    submenuBox: () => flyoutRef.current?.getBoundingClientRect() ?? null,
  });
  const flyoutRow = (key: Flyout | null) => (key === "more" ? moreRef.current : key === "move" ? moveRef.current : null);
  const rowFlyout = (row: Element | null): Flyout | null => (row && row === moreRef.current ? "more" : row && row === moveRef.current ? "move" : null);
  const more = moreIntent.current;
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const admin = useOwnerOrAdmin();
  const member = admin === false;
  const mayMove = useMayMoveBots();
  const clearThreads = useDeleteAllThreads(simpleMenu), moveToTeam = useMoveToTeam({ blocked: (bot) => (bot.defaultBot ? t("teamMove.blockedDefault", { name: bot.name }) : bot.chiefOfStaff ? t("teamMove.blockedChief") : state.bots.filter((candidate) => !candidate.hidden).length <= 1 ? t("teamMove.blockedLast") : undefined) });
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

  if (!motion.shown || !bot || !shown) return <>{clearThreads.dialog}{moveToTeam.dialog}</>;
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

  if (simpleMenu) {
    const showFlyout = (key: Flyout, focus: boolean) => {
      more.openNow(key);
      if (focus) requestAnimationFrame(() => flyoutRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
    };
    const copyId = item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => { void copyText(bot.threadId); });
    const current = bot.section?.trim() ?? "";
    const departments = departmentNames(state);
    const moveItems = [
      ...departments.map((name) => item(
        <span className="flex size-4 shrink-0 items-center justify-center">{name === current && <Check size={15} className="text-accent" />}</span>,
        name, () => moveBotsToSection(dispatch, [bot.id], name), { disabled: name === current },
      )),
      ...(departments.length ? [divider("move-new")] : []),
      ...(onNewSection ? [item(<FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.section.newContext"), () => onNewSection(bot.id))] : []),
      ...(current ? [item(<FolderMinus size={16} className="text-ink-secondary" />, t("sidebar.section.removeFromDepartment"), () => moveBotsToSection(dispatch, [bot.id], ""))] : []),
    ];
    const flyoutButton = (key: Flyout, ref: React.RefObject<HTMLButtonElement | null>, icon: React.ReactNode, label: string) => (
      <button
        key={key}
        ref={ref}
        type="button"
        role="menuitem"
        data-bot-menu-more={key === "more" ? "" : undefined}
        data-bot-menu-move={key === "move" ? "" : undefined}
        aria-haspopup="menu"
        aria-expanded={flyout === key}
        onClick={(event) => (flyout === key ? more.closeNow() : showFlyout(key, event.detail === 0))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          showFlyout(key, true);
        }}
        className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover", flyout === key && moreEngaged && "bg-menu-active")}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight size={15} aria-hidden="true" className="text-ink-secondary rtl:-scale-x-100" />
      </button>
    );
    const moveToSection = mayMove ? flyoutButton("move", moveRef, <FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.bot.moveToSection")) : null;
    const rename = onRename && item(<SquarePen size={16} className="text-ink-secondary" />, t("sidebar.bot.rename"), () => onRename(bot.id));
    const editProfile = item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.simple.editProfile"), () => {
      openForSettings();
      if (!state.settingsOpen) dispatch({ type: "toggleSettings", open: true });
    });
    const owner = team && mayChangeOwner(bot, team) ? item(<Users size={16} className="text-ink-secondary" />, ownerMenuLabel(bot, team), () => pickOwnerOf([bot], team, shown)) : null;
    const deleteAll = !member && allThreadRows(bot).length >= 2 ? [divider("more-threads"), item(<Trash2 size={16} />, t("task.deleteAllConversations"), () => clearThreads.ask(bot.id), { danger: true })] : [];
    const readState = readingBotId === bot.id || botUnreadThreadIds(bot).length > 0
      ? item(
        readingBotId === bot.id ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <CheckCheck size={16} className="text-ink-secondary" />,
        readingBotId === bot.id ? t("sidebar.bot.markingAllRead") : t("sidebar.bot.simple.markRead"),
        () => { void readAll(bot); },
        { disabled: readingBotId !== null, keepOpen: true },
      )
      : item(<BellDot size={16} className="text-ink-secondary" />, t("sidebar.bot.simple.markUnread"), () => dispatch({ type: "markUnread", botId: bot.id }));
    const moreItems = remoteClient ? [editProfile, owner, ...deleteAll] : [
      editProfile,
      chiefItem(),
      member ? null : item(<Copy size={16} className="text-ink-secondary" />, t("sidebar.bot.duplicate"), () => dispatch({ type: "duplicateBot", botId: bot.id })),
      owner,
      ...moveToTeam.items(bot, item),
      ...deleteAll,
    ];
    const moreRow = flyoutButton("more", moreRef, <MoreHorizontal size={16} className="text-ink-secondary" />, t("sidebar.bot.more"));
    const leave = bot.defaultBot ? [<HideDefaultBotItem key="hide" bot={bot} onDone={onClose} className={MENU_ITEM} />] : member ? [] : [
      item(<Archive size={16} className="text-ink-secondary" />, t("sidebar.bot.archive"), () => onArchive(bot), { disabled: archiveBlocked, hint: archiveHint }),
      <BotDeleteMenuItem key="delete" deleting={deleting} className={MENU_ITEM} onClick={() => { onClose(); onDelete(bot); }} />,
    ];
    return <>{clearThreads.dialog}{moveToTeam.dialog}{createPortal(
      <div
        ref={menuRef}
        data-bot-menu
        data-sidebar
        role="menu"
        aria-label={t("sidebar.bot.actions", { name: bot.name })}
        onKeyDown={navigateThreadMenu}
        onPointerOver={(event) => {
          const row = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null;
          if (!row || row === hoveredRow.current) return;
          const left = rowFlyout(hoveredRow.current);
          if (left) more.leaveRow(left);
          hoveredRow.current = row;
          const key = rowFlyout(row);
          more.enterRow(key ?? "row", key !== null, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => more.move({ x: event.clientX, y: event.clientY }, flyoutRow(flyout)?.contains(event.target as Node) === true)}
        onPointerLeave={() => {
          const left = rowFlyout(hoveredRow.current);
          if (left) more.leaveRow(left);
          hoveredRow.current = null;
          more.leaveMenu();
        }}
        style={{ top: shown.y, left: shown.x }}
        className={cn("fixed z-40 max-h-[calc(100dvh-16px)] w-max min-w-[198px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain", MENU_SHEET, motion.className)} {...motion.exitProps}
      >
        {remoteClient ? [moveToSection, ...(rename ? [divider("rename"), rename] : []), divider("copy"), copyId, moreRow] : [
          item(
            bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
            bot.pinned ? t("sidebar.bot.unpin") : t("sidebar.bot.pin"),
            () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
          ),
          moveToSection,
          readState,
          ...(rename ? [divider("rename"), rename] : []),
          divider("copy"),
          copyId,
          moreRow,
          ...(leave.length ? [divider("leave"), ...leave] : []),
        ]}
        {readError?.botId === bot.id && <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">{readError.message}</p>}
      </div>,
      document.body,
    )}{flyout && createPortal(
      <div
        ref={flyoutRef}
        data-bot-menu
        data-bot-menu-flyout={flyout}
        data-sidebar
        role="menu"
        aria-label={flyout === "more" ? t("sidebar.bot.more") : t("sidebar.bot.moveToSection")}
        onPointerEnter={() => { more.enterSubmenu(); setMoreEngaged(true); }}
        onPointerLeave={() => setMoreEngaged(false)}
        onFocus={() => setMoreEngaged(true)}
        onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setMoreEngaged(false); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            const row = flyoutRow(flyout);
            more.closeNow();
            row?.focus();
            return;
          }
          navigateThreadMenu(event);
        }}
        style={{ top: shown.y, left: shown.x }}
        className={cn("fixed z-40 max-h-[calc(100dvh-16px)] w-max min-w-[180px] max-w-[calc(100vw-16px)] animate-pop-in overflow-y-auto overscroll-contain", MENU_SHEET)}
      >
        {flyout === "more" ? moreItems : moveItems}
      </div>,
      document.body,
    )}</>;
  }

  return <>{clearThreads.dialog}{moveToTeam.dialog}{createPortal(
    <div
      ref={menuRef}
      data-bot-menu
      data-sidebar
      role="menu"
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
      {!member && item(<Trash2 size={16} />, t("task.deleteAll"), () => clearThreads.ask(bot.id), { danger: true })}
      {divider("threads")}
      {team && mayChangeOwner(bot, team) && item(<Users size={16} className="text-ink-secondary" />, ownerMenuLabel(bot, team), () => pickOwnerOf([bot], team, shown))}
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
        chiefItem(),
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
        !member && item(<Copy size={16} className="text-ink-secondary" />, t("sidebar.bot.duplicate"), () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => {
          void copyText(bot.threadId);
        }),
        divider("d3"), ...moveToTeam.items(bot, item),
        ...(bot.defaultBot ? [<HideDefaultBotItem key="hide" bot={bot} onDone={onClose} className={MENU_ITEM} />] : member ? [] : [
          item(<Archive size={16} className="text-ink-secondary" />, t("sidebar.bot.archive"), () => onArchive(bot), { disabled: archiveBlocked, hint: archiveHint }),
          <BotDeleteMenuItem key="delete" deleting={deleting} className={MENU_ITEM} onClick={() => { onClose(); onDelete(bot); }} />,
        ]),
      ]}
      {readError?.botId === bot.id && <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">{readError.message}</p>}
    </div>,
    document.body,
  )}</>;
}
