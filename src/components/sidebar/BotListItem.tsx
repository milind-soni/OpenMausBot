import { useEffect, useState } from "react";
import { ChevronRight, Crown, FolderPlus, Loader2, MoreHorizontal, Pin } from "lucide-react";
import { api, formatTime, useStore, visibleMessages, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import { stateForBot } from "@/lib/mascot";
import { BotAvatar } from "../Avatar";
import { RenameTitle } from "../RenameTitle";
import { WorkingDots } from "../WorkingIndicator";
import { BotProjectDialog } from "../BotProjects";
import { sidebarBotActivityTasks, SidebarBotActivity } from "../SidebarBotActivity";
import { botListItemPointerIntent } from "@/lib/sidebar-selection";
import { useShowThreads } from "@/lib/thread-preferences";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import type { MenuState } from "./BotContextMenu";
import { BotThreadList } from "./BotThreadList";

export function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return t("sidebar.preview.waiting");
  if (bot.busy) return t("sidebar.preview.working");
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return t("sidebar.preview.screenFrame");
  const peer = peerLine(last);
  if (peer) return `${peer.name}: ${peer.body}`;
  return last.text ?? "";
}

export function BotListItem({
  bot,
  density,
  query = "",
  menu = null,
  onMenu,
}: {
  bot: Bot;
  density: SidebarDensity;
  query?: string;
  menu?: MenuState | null;
  onMenu: (menu: MenuState) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  // the parent Sidebar owns the open menu, so this row's actions button is
  // expanded only while the open menu belongs to it
  const menuOpen = menu?.botId === bot.id;
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
              {formatTime(last.at)}
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
        <button type="button" aria-label={t("sidebar.bot.actions", { name: bot.name })} title={t("sidebar.bot.actions", { name: bot.name })} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? `bot-menu-${bot.id}` : undefined} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ botId: bot.id, x: rect.left, y: rect.bottom }); }}
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

