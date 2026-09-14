import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, BookOpen, Crown, MessageCircle, Minus, Monitor, MoreHorizontal, Pencil, Plus, Trash2, Users } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { teamMapStatus, type TeamMapSection } from "@/lib/team-map";
import { COMPUTER_DRAG_TYPE, fitTeams, layoutTeams, orderBots, parseBotOrders, parsePositions, reorderBot, zoomAt, type Point, type View } from "@/lib/team-canvas";
import { BotAvatar } from "./Avatar";
import { ProviderMark } from "./ProviderIcons";

type Gesture = {
  id: number;
  start: Point;
  view: View;
  positions: Record<string, Point>;
  moved: boolean;
} & ({ kind: "pan" } | { kind: "team"; key: string; origin: Point } | { kind: "bot"; bot: Bot });

const iconButton = "flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";
const menuButton = "flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] text-ink-secondary hover:bg-control hover:text-ink";

function BotCard({ bot, selected, moving, connected, onComputer, onArrange }: {
  bot: Bot;
  selected: boolean;
  moving: boolean;
  connected: boolean;
  onComputer?: (bot: Bot) => void;
  onArrange?: (bot: Bot, delta: number) => void;
}) {
  const { state, dispatch } = useStore();
  const status = teamMapStatus(bot);
  const instance = state.instances.find((item) => item.instanceId === bot.modelSelection.instanceId);
  const model = instance?.models.options.find((item) => item.id === bot.modelSelection.model)?.label ?? bot.modelSelection.model;
  return <article className={cn("relative h-[126px] w-[236px] shrink-0 rounded-xl border bg-card shadow-sm transition-colors",
    selected ? "border-accent/60 ring-1 ring-accent/15" : connected ? "border-accent/40" : "border-hairline/50 hover:border-ink-secondary/40", moving && "opacity-35")}>
    <button data-bot-id={bot.id} aria-label={t("canvas.editBot", { name: bot.name })}
      onClick={() => dispatch({ type: "toggleSettings", botId: bot.id, section: "identity", open: true })}
      title={onArrange ? t("canvas.reorderHint") : undefined}
      onKeyDown={(event) => {
        if (!onArrange || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault(); event.stopPropagation();
        onArrange(bot, event.key === "ArrowUp" ? -1 : 1);
      }}
      className="flex h-[82px] w-full cursor-grab items-center gap-3 rounded-t-xl px-4 text-left active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-accent">
      <BotAvatar bot={bot} size={38} motion="none" motionKey={0} animated={false} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5"><span className="truncate text-[14px] font-semibold">{bot.name}</span>
          {bot.chiefOfStaff && <Crown size={12} className="shrink-0 text-warning" aria-label={t("chat.chiefOfStaff")} />}</span>
        <span className="mt-1 block truncate text-[11px] text-ink-secondary">{bot.title || (bot.chiefOfStaff ? t("chat.chiefOfStaff") : t("canvas.bot"))}</span>
      </span>
    </button>
    <div className="flex h-[43px] items-center gap-1 border-t border-hairline/30 px-2">
      <button className={cn(iconButton, "size-8")} aria-label={t("canvas.openBotChat", { name: bot.name })} title={t("canvas.openChat")}
        onClick={() => dispatch({ type: "select", id: bot.id })}><MessageCircle size={13} /></button>
      {status.tone !== "idle" && <span className="flex items-center gap-1.5 text-[10px] text-ink-secondary" title={status.label}>
        <span className={cn("size-1.5 rounded-full", status.tone === "success" ? "bg-success" : status.tone === "warning" ? "bg-warning" : status.tone === "danger" ? "bg-danger" : "bg-ink-secondary/35")} />
        {status.label}
      </span>}
      {selected && onComputer && <button className={cn(iconButton, "size-8")} aria-label={t("canvas.botComputer", { name: bot.name })} title={t("computer.tab.computer")}
        onClick={() => onComputer(bot)}><Monitor size={13} /></button>}
      <button aria-label={t("canvas.changeModel", { name: bot.name })} title={`${t("canvas.defaultModel")}: ${model}`}
        onClick={() => dispatch({ type: "toggleSettings", botId: bot.id, section: "model", open: true })}
        className="ml-auto flex h-8 min-w-0 max-w-[130px] items-center gap-1.5 rounded-md px-2 text-[10px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
        <span className="flex size-3.5 shrink-0 items-center justify-center"><ProviderMark driverKind={instance?.driverKind ?? ""} size={13} /></span>
        <span className="truncate">{model || t("canvas.defaultModel")}</span>
      </button>
    </div>
  </article>;
}

export function TeamCanvas({ sections, canManage, onMove, onInstructions, onEditTeam, onDeleteTeam, isEmpty, onComputer, onComputerDrop, onTeamComputer, teamComputers = {}, connectedBotIds = [] }: {
  sections: TeamMapSection<Bot>[];
  canManage: boolean;
  onMove: (bot: Bot, destination: string) => Promise<boolean | void>;
  onInstructions: (key: string, label: string) => void;
  onEditTeam: (section: string, rename?: boolean) => void;
  onDeleteTeam: (section: string) => void;
  isEmpty: (section: string) => boolean;
  onComputer?: (bot: Bot) => void;
  onComputerDrop?: (resourceId: string, sectionKey: string) => void;
  onTeamComputer?: (sectionKey: string) => void;
  teamComputers?: Record<string, { name: string; state?: string }>;
  connectedBotIds?: string[];
}) {
  const { state } = useStore();
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const keyboardFocus = useRef(false);
  const storageKey = useRef<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [botOrders, setBotOrders] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<View>({ x: 40, y: 40, scale: 1 });
  const [dragged, setDragged] = useState<{ bot: Bot; point: Point } | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [computerDropKey, setComputerDropKey] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<{ botId: string; after: boolean } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [menuAbove, setMenuAbove] = useState<string | null>(null);
  const tiles = useMemo(() => layoutTeams(sections, positions), [sections, positions]);
  const current = useRef({ view, positions, tiles, selectedId: state.selectedId, settingsOpen: state.settingsOpen });
  current.current = { view, positions, tiles, selectedId: state.selectedId, settingsOpen: state.settingsOpen };

  // Layout is personal presentation, not team configuration. Key it to the
  // workspace's identity so switching hosted workspaces never shares a layout.
  useEffect(() => {
    let active = true;
    void api("/.well-known/openmausbot/environment", { signal: AbortSignal.timeout(5_000) }).then((environment) => {
      if (!active || typeof environment.environmentId !== "string") return;
      storageKey.current = `omb-team-canvas:${environment.environmentId}`;
      try {
        const saved = parsePositions(localStorage.getItem(storageKey.current));
        setPositions((previous) => ({ ...saved, ...previous }));
        setBotOrders(parseBotOrders(localStorage.getItem(`${storageKey.current}:bot-order`)));
      } catch { /* Private browsing may disable storage; the canvas still works. */ }
    }).catch(() => { /* Older companions can use the canvas without persistence. */ }).finally(() => { if (active) setLayoutLoaded(true); });
    return () => { active = false; };
  }, []);

  const savePositions = (next: Record<string, Point>) => {
    setPositions(next);
    if (!storageKey.current) return;
    try {
      localStorage.setItem(storageKey.current, JSON.stringify(Object.fromEntries(sections
        .filter((section) => Object.hasOwn(next, section.key)).map((section) => [section.key, next[section.key]]))));
    } catch { /* A full/disabled store must not prevent arranging teams. */ }
  };
  const personalOrder = (key: string) => Object.hasOwn(botOrders, key) ? botOrders[key] : [];
  const saveBotOrder = (section: TeamMapSection<Bot>, lane: Bot[], bot: Bot, index: number) => {
    const next = { ...botOrders, [section.key]: [
      ...reorderBot(lane, bot.id, index),
      ...orderBots(bot.chiefOfStaff ? section.members : section.chiefs, personalOrder(section.key)).map((item) => item.id),
    ] };
    setBotOrders(next);
    if (storageKey.current) {
      try { localStorage.setItem(`${storageKey.current}:bot-order`, JSON.stringify(next)); }
      catch { /* Personal ordering remains usable when browser storage is unavailable. */ }
    }
    setAnnouncement(t("canvas.arrangedBot", { name: bot.name, team: section.name }));
  };
  const arrangeBot = (bot: Bot, delta: number) => {
    const section = sections.find((item) => item.key === (bot.section?.trim() ?? ""));
    if (!section) return;
    const lane = orderBots(bot.chiefOfStaff ? section.chiefs : section.members, personalOrder(section.key));
    saveBotOrder(section, lane, bot, lane.findIndex((item) => item.id === bot.id) + delta);
  };
  const fit = useCallback(() => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (bounds) setView(fitTeams(current.current.tiles, bounds.width, bounds.height));
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let previousSize: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect();
      if (!previousSize) fit();
      else {
        const card = current.current.settingsOpen ? [...element.querySelectorAll<HTMLElement>("[data-bot-id]")]
          .find((node) => node.dataset.botId === current.current.selectedId)?.getBoundingClientRect() : undefined;
        const dx = card ? bounds.width / 2 - (card.left - bounds.left + card.width / 2) : (bounds.width - previousSize.width) / 2;
        const dy = card ? bounds.height / 2 - (card.top - bounds.top + card.height / 2) : (bounds.height - previousSize.height) / 2;
        setView((previous) => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
      }
      previousSize = { width: bounds.width, height: bounds.height };
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  // Fit membership changes too: a growing team can push later rows outside
  // the view. Ordinary status updates and manual arranging never trigger this.
  const teamSizes = JSON.stringify(tiles.map(({ key, width, height }) => [key, width, height]));
  useEffect(() => { fit(); }, [fit, teamSizes, layoutLoaded]);
  useEffect(() => {
    const open = viewport.current?.querySelector<HTMLDetailsElement>("details[open]");
    const bounds = viewport.current?.getBoundingClientRect();
    if (open && bounds) setMenuAbove(open.getBoundingClientRect().bottom > bounds.bottom - 210 * view.scale
      ? open.closest<HTMLElement>("[data-team-key]")?.dataset.teamKey ?? null : null);
  }, [view, teamSizes]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("details[open]")) return;
      event.preventDefault();
      if (gesture.current) return;
      const previous = current.current.view;
      const bounds = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const scale = Math.min(1.5, Math.max(0.3, previous.scale * Math.exp(-event.deltaY * 0.006)));
        setView(zoomAt(previous, scale, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }));
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
        setView({ ...previous, x: previous.x - event.deltaX * unit, y: previous.y - event.deltaY * unit });
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    const element = event.target as HTMLElement;
    const botId = element.closest<HTMLElement>("[data-bot-id]")?.dataset.botId;
    const teamKey = element.closest<HTMLElement>("[data-arrange-team]")?.dataset.arrangeTeam;
    const bot = botId ? sections.flatMap((section) => [...section.chiefs, ...section.members]).find((item) => item.id === botId) : undefined;
    if (!bot && teamKey === undefined && element.closest("button, details, a, input, [data-team-key]")) return;
    if (bot && (moving || !layoutLoaded)) return;
    if (teamKey !== undefined && !layoutLoaded) return;
    const common = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, view, positions, moved: false };
    const tile = teamKey === undefined ? undefined : tiles.find((item) => item.key === teamKey);
    gesture.current = bot ? { ...common, kind: "bot", bot } : tile ? { ...common, kind: "team", key: tile.key, origin: tile } : { ...common, kind: "pan" };
    suppressClick.current = false;
    // Capture only after the drag threshold, otherwise a simple button click
    // would be retargeted to the canvas and never open settings.
  };
  const destinationAt = (x: number, y: number) => {
    const section = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-team-key]");
    return section && viewport.current?.contains(section) ? section.dataset.teamKey ?? null : null;
  };
  const insertionAt = (bot: Bot, y: number) => {
    const section = sections.find((item) => item.key === (bot.section?.trim() ?? ""));
    if (!section) return null;
    const lane = orderBots(bot.chiefOfStaff ? section.chiefs : section.members, personalOrder(section.key));
    const remaining = lane.filter((item) => item.id !== bot.id);
    const cards = [...(viewport.current?.querySelectorAll<HTMLElement>("[data-bot-id]") ?? [])];
    const index = remaining.findIndex((item) => {
      const bounds = cards.find((card) => card.dataset.botId === item.id)?.closest("article")?.getBoundingClientRect();
      return bounds ? y < bounds.top + bounds.height / 2 : false;
    });
    return { section, lane, remaining, index: index < 0 ? remaining.length : index };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    if (event.buttons === 0) { finish(event, true); return; }
    const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < 5) return;
    active.moved = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (active.kind === "pan") setView({ ...active.view, x: active.view.x + dx, y: active.view.y + dy });
    if (active.kind === "team") setPositions({ ...active.positions, [active.key]: { x: active.origin.x + dx / view.scale, y: active.origin.y + dy / view.scale } });
    if (active.kind === "bot") {
      const bounds = event.currentTarget.getBoundingClientRect();
      setDragged({ bot: active.bot, point: { x: event.clientX - bounds.left, y: event.clientY - bounds.top } });
      const destination = destinationAt(event.clientX, event.clientY);
      const sameTeam = destination === (active.bot.section?.trim() ?? "");
      setDropKey(sameTeam || canManage ? destination : null);
      const position = sameTeam ? insertionAt(active.bot, event.clientY) : null;
      const anchor = position?.remaining[position.index] ?? position?.remaining.at(-1);
      setInsertion(position && anchor ? { botId: anchor.id, after: position.index === position.remaining.length } : null);
    }
  };
  const finish = (event?: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const active = gesture.current;
    if (!active || (event && active.id !== event.pointerId)) return;
    gesture.current = null;
    suppressClick.current = active.moved;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    setDragged(null);
    setDropKey(null);
    setInsertion(null);
    if (viewport.current?.hasPointerCapture(active.id)) viewport.current.releasePointerCapture(active.id);
    if (cancelled) { setPositions(active.positions); setView(active.view); return; }
    if (!active.moved) return;
    if (active.kind === "team" && event) savePositions({ ...active.positions, [active.key]: {
      x: active.origin.x + (event.clientX - active.start.x) / active.view.scale,
      y: active.origin.y + (event.clientY - active.start.y) / active.view.scale,
    } });
    if (active.kind === "bot" && event) {
      const destination = destinationAt(event.clientX, event.clientY);
      if (destination === null) return;
      if (destination === (active.bot.section?.trim() ?? "")) {
        const position = insertionAt(active.bot, event.clientY);
        if (position) saveBotOrder(position.section, position.lane, active.bot, position.index);
        return;
      }
      if (!canManage) return;
      setMoving(active.bot.id);
      setAnnouncement(t("canvas.reviewMove", { name: active.bot.name, team: destination || t("settings.section.general") }));
      void onMove(active.bot, destination).then((moved) => {
        setAnnouncement(moved === false ? t("canvas.moveCancelled") : t("canvas.moved", { name: active.bot.name, team: destination || t("settings.section.general") }));
      }).catch((error: unknown) => {
        setAnnouncement(error instanceof Error ? error.message : String(error));
      }).finally(() => setMoving(null));
    }
  };
  const zoom = (factor: number) => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (bounds) setView(zoomAt(view, Math.max(0.3, Math.min(1.5, view.scale * factor)), { x: bounds.width / 2, y: bounds.height / 2 }));
  };
  const dropSection = sections.find((section) => section.key === dropKey);
  const dropHint = computerDropKey !== null ? t("canvas.assignComputer", { team: sections.find((section) => section.key === computerDropKey)?.name ?? computerDropKey })
    : dragged && dropSection ? (dragged.bot.section?.trim() ?? "") === dropSection.key
      ? t("canvas.arrangeBot", { name: dragged.bot.name, team: dropSection.name }) : t("canvas.moveBot", { name: dragged.bot.name, team: dropSection.name })
      : null;

  return <div ref={viewport} role="region" aria-label={t("canvas.region")} tabIndex={0} data-team-canvas
    className="relative min-h-0 flex-1 touch-none overflow-clip outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    style={{ backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--color-ink-secondary) 18%, transparent) 1px, transparent 1px)", backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
    onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
    onDragOver={(event) => {
      if (!canManage || !onComputerDrop || !event.dataTransfer.types.includes(COMPUTER_DRAG_TYPE)) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-team-key]");
      const key = target && event.currentTarget.contains(target) ? target.dataset.teamKey ?? null : null;
      setComputerDropKey(key);
      if (key !== null) { event.preventDefault(); event.dataTransfer.dropEffect = "link"; }
    }}
    onDragLeave={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setComputerDropKey(null);
    }}
    onDrop={(event) => {
      setComputerDropKey(null);
      if (!canManage || !onComputerDrop || !event.dataTransfer.types.includes(COMPUTER_DRAG_TYPE)) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-team-key]");
      const key = target && event.currentTarget.contains(target) ? target.dataset.teamKey : undefined;
      const resourceId = event.dataTransfer.getData(COMPUTER_DRAG_TYPE);
      if (key === undefined || !sections.some((section) => section.key === key) || !resourceId) return;
      event.preventDefault();
      onComputerDrop(resourceId, key);
    }}
    onDragEnd={() => setComputerDropKey(null)}
    onPointerDownCapture={(event) => {
      keyboardFocus.current = false;
      if (!(event.target as HTMLElement).closest("details")) event.currentTarget.querySelectorAll("details[open]").forEach((element) => element.removeAttribute("open"));
    }}
    onKeyDownCapture={(event) => { if (event.key === "Tab") keyboardFocus.current = true; }}
    onPointerLeave={() => { if (gesture.current && !gesture.current.moved) finish(undefined, true); }}
    onLostPointerCapture={() => { if (gesture.current) finish(undefined, true); }}
    onFocusCapture={(event) => {
      if (!keyboardFocus.current || !(event.target instanceof HTMLElement) || !event.target.closest("[data-canvas-world]")) return;
      const bounds = event.currentTarget.getBoundingClientRect(), target = event.target.getBoundingClientRect();
      const dx = target.left < bounds.left + 16 ? bounds.left + 16 - target.left : target.right > bounds.right - 16 ? bounds.right - 16 - target.right : 0;
      const dy = target.top < bounds.top + 16 ? bounds.top + 16 - target.top : target.bottom > bounds.bottom - 70 ? bounds.bottom - 70 - target.bottom : 0;
      if (dx || dy) setView((previous) => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
    }}
    onClickCapture={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { finish(undefined, true); event.currentTarget.querySelectorAll("details[open]").forEach((element) => {
        element.querySelector("summary")?.focus({ preventScroll: true });
        element.removeAttribute("open");
      }); }
      if (event.target !== event.currentTarget) return;
      const directions: Record<string, Point> = { ArrowLeft: { x: 60, y: 0 }, ArrowRight: { x: -60, y: 0 }, ArrowUp: { x: 0, y: 60 }, ArrowDown: { x: 0, y: -60 } };
      const delta = directions[event.key];
      if (delta) { event.preventDefault(); setView({ ...view, x: view.x + delta.x, y: view.y + delta.y }); }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.2); }
      if (event.key === "-") { event.preventDefault(); zoom(1 / 1.2); }
      if (event.key === "0") { event.preventDefault(); fit(); }
    }}>
    <div data-canvas-world className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
      {sections.map((section, index) => {
        const tile = tiles[index];
        const hierarchy = section.chiefs.length > 0 && section.members.length > 0;
        const dropping = computerDropKey === section.key || (dragged && dropKey === section.key && (dragged.bot.section?.trim() ?? "") !== section.key);
        const computer = Object.hasOwn(teamComputers, section.key) ? teamComputers[section.key] : undefined;
        const renderBot = (bot: Bot) => <div key={bot.id} className="relative">
          {insertion?.botId === bot.id && <div className={cn("pointer-events-none absolute inset-x-1 h-0.5 rounded bg-accent", insertion.after ? "-bottom-[9px]" : "-top-[9px]")} />}
          <BotCard bot={bot} selected={state.selectedId === bot.id && state.settingsOpen} moving={dragged?.bot.id === bot.id || moving === bot.id}
            connected={connectedBotIds.includes(bot.id)} onComputer={onComputer} onArrange={layoutLoaded ? arrangeBot : undefined} />
        </div>;
        return <section key={section.key} data-team-key={section.key} aria-label={t("canvas.teamRegion", { name: section.name })}
          className={cn("absolute rounded-2xl border bg-panel/90 shadow-sm has-[details[open]]:z-20 data-[computer-dropping=true]:border-accent data-[computer-dropping=true]:ring-2 data-[computer-dropping=true]:ring-accent/25", dropping ? "border-accent ring-2 ring-accent/25" : "border-hairline/50")}
          style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height }}>
          <header className="flex h-16 items-center gap-2 px-5">
            <button data-arrange-team={section.key} disabled={!layoutLoaded} aria-label={t("canvas.arrange", { name: section.name })}
              title={t("canvas.arrangeHint")} className="min-w-0 flex-1 cursor-grab rounded-md py-2 text-left active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-accent"
              onKeyDown={(event) => {
                const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
                if (!delta) return;
                event.preventDefault(); event.stopPropagation();
                const step = event.shiftKey ? 40 : 10;
                savePositions({ ...positions, [section.key]: { x: tile.x + delta[0] * step, y: tile.y + delta[1] * step } });
              }}>
              <h2 className="truncate text-[13px] font-semibold tracking-tight">{section.name}</h2>
            </button>
            {computer && <button aria-label={t("canvas.teamComputer", { team: section.name, name: computer.name })} title={`${computer.name}${computer.state ? ` · ${computer.state}` : ""}`}
              disabled={!onTeamComputer} onClick={() => onTeamComputer?.(section.key)}
              className="flex min-w-0 max-w-[120px] shrink items-center gap-1.5 rounded-md px-1.5 py-2 text-[10px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none">
              <Monitor size={12} className="shrink-0" /><span className="truncate">{computer.name}</span>
            </button>}
            <span className="text-[11px] tabular-nums text-ink-secondary">{section.chiefs.length + section.members.length}</span>
            {canManage && <details className="relative" onToggle={(event) => {
              if (event.currentTarget.open) {
                const bounds = viewport.current?.getBoundingClientRect();
                setMenuAbove(bounds && event.currentTarget.getBoundingClientRect().bottom > bounds.bottom - 210 * view.scale ? section.key : null);
                viewport.current?.querySelectorAll("details[open]").forEach((element) => { if (element !== event.currentTarget) element.removeAttribute("open"); });
              }
            }}>
              <summary aria-label={t("canvas.manageTeam", { name: section.name })} className={cn(iconButton, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}><MoreHorizontal size={17} /></summary>
              <div className={cn("absolute right-0 z-30 w-[220px] rounded-xl border border-hairline bg-panel p-1.5 shadow-xl", menuAbove === section.key ? "bottom-10" : "top-10")} onClick={(event) => {
                const menu = event.currentTarget.closest("details");
                menu?.querySelector("summary")?.focus();
                menu?.removeAttribute("open");
              }}>
                <button className={menuButton} onClick={() => onEditTeam(section.key)} aria-label={t("team.moveTo", { name: section.name })}><Users size={14} />{t("team.moveTo", { name: section.name })}</button>
                <button className={menuButton} onClick={() => onInstructions(section.key, section.name)} aria-label={t("team.instructionsEdit", { name: section.name })}><BookOpen size={14} />{t("team.instructions")}</button>
                {section.key && isEmpty(section.key) && <>
                  <button className={menuButton} onClick={() => onEditTeam(section.key, true)} aria-label={t("team.renameAria", { name: section.name })}><Pencil size={14} />{t("team.renameEmpty")}</button>
                  <button className={cn(menuButton, "hover:text-danger")} onClick={() => onDeleteTeam(section.key)} aria-label={t("team.deleteAria", { name: section.name })}><Trash2 size={14} />{t("team.deleteEmpty")}</button>
                </>}
              </div>
            </details>}
          </header>
          {dropping && <div className="pointer-events-none absolute -top-7 left-2 z-30 max-w-[calc(100%-16px)] truncate rounded-md bg-accent px-2 py-1 text-[10px] text-white shadow-sm">{dropHint}</div>}
          <div className="flex items-center px-5 pb-5">
            {section.chiefs.length > 0 && <div className="flex flex-col gap-4">{orderBots(section.chiefs, personalOrder(section.key)).map(renderBot)}</div>}
            {hierarchy && <div className="flex w-10 shrink-0 justify-center text-ink-secondary/35" aria-hidden="true"><ArrowRight size={22} strokeWidth={1} /></div>}
            {section.members.length > 0 && <div className="flex flex-col gap-4">{orderBots(section.members, personalOrder(section.key)).map(renderBot)}</div>}
            {section.chiefs.length + section.members.length === 0 && <p className="flex h-[126px] w-[236px] items-center justify-center rounded-xl border border-dashed border-hairline/70 px-6 text-center text-[12px] leading-relaxed text-ink-secondary">{t("canvas.dropHere")}</p>}
          </div>
        </section>;
      })}
    </div>
    {dragged && <div className="pointer-events-none absolute z-40 rounded-xl border border-accent/40 bg-card px-4 py-3 text-[13px] shadow-lg" style={{ left: dragged.point.x + 16, top: dragged.point.y + 16 }}>
      <span className="flex items-center gap-2"><BotAvatar bot={dragged.bot} size={24} animated={false} />{dragged.bot.name}</span>
      {dropHint && <p className="mt-1 text-[10px] text-ink-secondary">{dropHint}</p>}
    </div>}
    <div className="pointer-events-none absolute inset-x-5 bottom-5 flex items-end justify-between gap-3">
      <div className="min-w-0 rounded-lg bg-app/90 px-2 py-1.5 text-[11px] text-ink-secondary">
        <p className="max-sm:hidden">{t("canvas.hint")}</p>
        <p role="status" aria-live="polite" className="max-w-[440px]">{dropHint ?? announcement}</p>
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-xl border border-hairline/60 bg-panel p-1 shadow-sm">
        <button className={iconButton} aria-label={t("canvas.zoomOut")} onClick={() => zoom(1 / 1.2)}><Minus size={15} /></button>
        <button className="min-w-12 rounded-md px-1 py-2 text-[11px] tabular-nums text-ink-secondary hover:bg-control" aria-label={t("canvas.fit")} title={t("canvas.fitHint")} onClick={fit}>{Math.round(view.scale * 100)}%</button>
        <button className={iconButton} aria-label={t("canvas.zoomIn")} onClick={() => zoom(1.2)}><Plus size={15} /></button>
      </div>
    </div>
  </div>;
}
