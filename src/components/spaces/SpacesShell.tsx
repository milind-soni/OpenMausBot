import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Columns2, Columns3, Grid2x2, Square, X } from "lucide-react";

import { useStore, type Bot, type Group } from "@/state/store";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { BrowserWorkspace } from "@/components/BrowserWorkspace";
import { LocalVmWorkspace } from "@/components/LocalVmWorkspace";
import { ComputerPanel } from "@/components/ComputerPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/cn";
import { SpaceCard } from "./SpaceCard";
import { SpacesStage } from "./SpacesStage";
import { SpacesComposer } from "./SpacesComposer";
import { SpacesToasts } from "./SpacesToasts";
import { flipFrom } from "./spaces-flip";
import {
  TILE_COUNTS,
  layoutFor,
  transformForLayout,
  type CanvasView,
  type TileCount,
  type Viewport,
} from "./spaces-layout";
import { clampIndex, navigate, type NavIntent } from "./spaces-nav";
import { panBy, zoomAt, type View } from "./spaces-view";
import { nearestCardIndex } from "./spaces-nearest";
import { expireToasts, lastSettled, mergeToasts, settledSince, type Toast } from "./spaces-toasts";

/** Cards this far from the focused one keep their body once the canvas has
 * proved too heavy for this machine. */
const DEGRADED_LIVE_RADIUS = 9;
/** A frame slower than this is a dropped one at 60Hz, with headroom. */
const SLOW_FRAME_MS = 20;

function isGroup(subject: Bot | Group): subject is Group {
  return Array.isArray((subject as Group).memberIds);
}

function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  useEffect(() => {
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return viewport;
}

/**
 * Watches how long frames actually take during a transition. Everything-live is
 * the promise; on a machine that cannot hold it, distant cards park rather than
 * the whole canvas stuttering. Measured, not guessed — and sticky once tripped,
 * so it does not flap mid-gesture.
 */
function useFrameBudget(): { degraded: boolean; sample: () => void } {
  const [degraded, setDegraded] = useState(false);
  const running = useRef(false);

  const sample = useCallback(() => {
    if (degraded || running.current || typeof requestAnimationFrame !== "function") return;
    running.current = true;
    const frames: number[] = [];
    let previous = performance.now();
    const tick = (now: number) => {
      frames.push(now - previous);
      previous = now;
      if (frames.length < 24) {
        requestAnimationFrame(tick);
        return;
      }
      running.current = false;
      const sorted = [...frames].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      if (p95 > SLOW_FRAME_MS) setDegraded(true);
    };
    requestAnimationFrame(tick);
  }, [degraded]);

  return { degraded, sample };
}

export function SpacesShell({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const viewport = useViewport();
  const [view, setView] = useState<CanvasView>({ kind: "tile", per: 1 });
  // Remembered so leaving the grid returns to the split you were using.
  const lastTile = useRef<TileCount>(1);
  const [transitioning, setTransitioning] = useState(false);
  // Explicit view while the trackpad is driving; null means "follow the
  // preset for the current mode and card". Any key or click snaps back.
  const [freeView, setFreeView] = useState<View | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** A surface lifted out of a card to fill the canvas. */
  const [expanded, setExpanded] = useState<{ kind: "browser" | "vm"; botId: string } | null>(null);
  const { degraded, sample } = useFrameBudget();
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>());
  const expandOrigin = useRef<DOMRect | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bots first, then rooms — a stable order, so a card never moves between
  // visits and the spatial memory that makes this work stays intact.
  const subjects = useMemo<Array<Bot | Group>>(
    () => [...state.bots.filter((bot) => !bot.hidden), ...state.groups],
    [state.bots, state.groups],
  );
  const count = subjects.length;
  const layout = useMemo(() => layoutFor(count, viewport, view), [count, viewport, view]);
  const columns = layout.columns;

  const selectedIndex = subjects.findIndex((subject) => subject.id === state.selectedId);
  const index = clampIndex(selectedIndex >= 0 ? selectedIndex : 0, count);
  const focused = index >= 0 ? subjects[index] : null;

  const focus = useCallback(
    (id: string) => {
      dispatch({ type: "select", id });
    },
    [dispatch],
  );

  const move = useCallback(
    (intent: NavIntent) => {
      const next = navigate({ index, count, columns }, intent);
      if (next < 0 || next === index) return;
      focus(subjects[next].id);
    },
    [columns, count, focus, index, subjects],
  );

  const showView = useCallback(
    (next: CanvasView) => {
      if (next.kind === "tile") lastTile.current = next.per;
      setView((current) =>
        current.kind === next.kind && (current.kind !== "tile" || current.per === (next as { per: TileCount }).per)
          ? current
          : next,
      );
    },
    [],
  );
  const toGrid = useCallback(() => showView({ kind: "grid" }), [showView]);
  const toTiles = useCallback(() => showView({ kind: "tile", per: lastTile.current }), [showView]);

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (expanded) return;
      const typing =
        event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      // macOS reserves Control+Arrow (move a space) and Control+1..3 (switch
      // desktop) for Mission Control and swallows them before Electron sees
      // them, so Spaces uses Cmd-Opt. It also survives a focused text field.
      const spacesChord = event.metaKey && event.altKey && !event.ctrlKey;

      if (event.key === "Escape" && !typing) {
        event.preventDefault();
        // Unwind one layer at a time, innermost first.
        if (state.computerOpen) dispatch({ type: "toggleComputer", open: false });
        else if (state.inspectorOpen) dispatch({ type: "toggleInspector", open: false });
        else if (state.settingsOpen) dispatch({ type: "toggleSettings", open: false });
        else if (view.kind === "grid") toTiles();
        else onClose();
        return;
      }
      // Cmd-Opt-1/2/3 choose how many bots share the screen. Read `code`, not
      // `key`: with Option held macOS composes "1" into "¡".
      if (spacesChord) {
        const digit = /^Digit([123])$/.exec(event.code);
        if (digit) {
          event.preventDefault();
          showView({ kind: "tile", per: Number(digit[1]) as TileCount });
          return;
        }
      }
      if (event.metaKey && /^[1-9]$/.test(event.key)) {
        const target = subjects[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          focus(target.id);
          toTiles();
        }
        return;
      }
      // In the grid, bare arrows move the selection: nothing else has the
      // keyboard there, and it is what every other grid on the machine does.
      if (!event.metaKey && !event.altKey && !event.ctrlKey && view.kind === "grid" && !typing) {
        const bare: Record<string, NavIntent> = {
          ArrowUp: "up",
          ArrowDown: "down",
          ArrowLeft: "prev",
          ArrowRight: "next",
        };
        const intent = bare[event.key];
        if (intent) {
          event.preventDefault();
          move(intent);
        }
        return;
      }

      if (!spacesChord) return;
      // The vertical pair is zoom, in both modes — never zoom in one
      // direction and movement in the other. Sliding is the horizontal pair.
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          toGrid();
          break;
        case "ArrowDown":
          event.preventDefault();
          toTiles();
          break;
        case "ArrowLeft":
          event.preventDefault();
          move("prev");
          break;
        case "ArrowRight":
          event.preventDefault();
          move("next");
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, expanded, focus, move, onClose, showView, state.computerOpen, state.inspectorOpen, state.settingsOpen, subjects, toGrid, toTiles, view]);

  // --- trackpad -----------------------------------------------------------
  // macOS reserves genuine three-finger Spaces swipes for itself; Electron
  // never sees them. Two-finger horizontal scroll is what arrives here, and a
  // pinch arrives as a wheel event with ctrlKey set.
  // Trackpad drives the canvas directly: two-finger scroll pans in both axes,
  // pinch (which macOS delivers as a wheel event with ctrlKey) zooms about the
  // pointer. Both start from wherever the preset currently puts the stage, so
  // there is never a jump on the first gesture.
  const onWheel = useCallback(
    (event: ReactWheelEvent) => {
      if (expanded) return;
      const current = freeView ?? transformForLayout(layout, index, viewport);
      const base: View = { scale: current.scale, x: current.x, y: current.y };
      if (event.ctrlKey) {
        // deltaY is the pinch magnitude; the exponent keeps it smooth and
        // symmetric between pinching in and out.
        setFreeView(zoomAt(base, { x: event.clientX, y: event.clientY }, Math.exp(-event.deltaY / 120)));
        return;
      }
      const panned = panBy(base, event.deltaX, event.deltaY);
      setFreeView(panned);
      // Panning is navigation: when the fingers stop, adopt whichever card the
      // canvas has landed on and settle onto it, so the composer pill always
      // names the bot you are looking at.
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        const landed = nearestCardIndex(layout, { ...panned, scrollable: false }, viewport);
        if (landed >= 0 && subjects[landed]) focus(subjects[landed].id);
        setFreeView(null);
      }, 160);
    },
    [expanded, focus, freeView, index, layout, subjects, viewport],
  );

  // Any deliberate move — a key, a click, a toast — snaps back to the preset.
  useEffect(() => {
    setFreeView(null);
  }, [index, view]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  // --- transition bookkeeping --------------------------------------------
  useEffect(() => {
    setTransitioning(true);
    sample();
    const done = setTimeout(() => setTransitioning(false), 420);
    return () => clearTimeout(done);
  }, [index, view, sample]);

  // --- background activity toasts ----------------------------------------
  const seen = useRef<Record<string, string | null>>({});
  useEffect(() => {
    const now = Date.now();
    const observed = subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      settled: lastSettled(subject.messages),
    }));
    // In grid view the card itself is visible; a toast about it is redundant.
    const events = view.kind === "grid" ? [] : settledSince(seen.current, observed, focused?.id ?? null, now);
    const next: Record<string, string | null> = {};
    for (const subject of observed) next[subject.id] = subject.settled?.id ?? null;
    seen.current = next;
    if (events.length > 0) setToasts((current) => mergeToasts(current, events));
  }, [focused?.id, view, subjects]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => setToasts((current) => expireToasts(current, Date.now())), 500);
    return () => clearInterval(timer);
  }, [toasts.length]);

  // --- artifact zoom-out --------------------------------------------------
  const expandedBot = expanded ? state.bots.find((bot) => bot.id === expanded.botId) : undefined;
  const expandRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const origin = expandOrigin.current;
    const element = expandRef.current;
    if (!expandedBot || !origin || !element) return;
    expandOrigin.current = null;
    void flipFrom(element, origin);
  }, [expandedBot]);

  const expandFocused = useCallback(() => {
    if (!focused || isGroup(focused)) return;
    expandOrigin.current = cardRefs.current.get(focused.id)?.getBoundingClientRect() ?? null;
    setExpanded({ kind: "browser", botId: focused.id });
  }, [focused]);

  const canExpand =
    Boolean(focused) &&
    !isGroup(focused as Bot | Group) &&
    builtInBrowserEnabled(state.config) &&
    (focused as Bot).browser !== false;

  const preset = transformForLayout(layout, index, viewport);
  const focusedBot = focused && !isGroup(focused) ? focused : undefined;
  const transform = freeView
    ? { ...preset, scale: freeView.scale, x: freeView.x, y: freeView.y }
    : preset;

  if (count === 0) {
    return (
      <CanvasFrame onClose={onClose}>
        <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-secondary">
          <div className="text-[14px]">No bots yet</div>
          <button
            type="button"
            onClick={() => dispatch({ type: "newBot" })}
            className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink"
          >
            New bot
          </button>
        </div>
      </CanvasFrame>
    );
  }

  return (
    <CanvasFrame onClose={onClose} onWheel={onWheel}>
      <div
        className={cn(
          "absolute inset-0",
          view.kind === "grid" && transform.scrollable ? "overflow-y-auto" : "overflow-hidden",
        )}
      >
        {/* A transform never changes layout size, so a scaled-down stage would
            still give the scroll container its full natural height. This spacer
            carries the *scaled* height instead, which is what scrolls. */}
        {transform.scrollable ? (
          <div
            aria-hidden
            style={{ height: layout.stage.height * transform.scale + 96 }}
          />
        ) : null}
        <SpacesStage
          layout={layout}
          transform={transform}
          transitioning={transitioning}
          animated={freeView === null}
        >
          {subjects.map((subject, cardIndex) => {
            const isFocused = cardIndex === index;
            const parked = degraded && Math.abs(cardIndex - index) > DEGRADED_LIVE_RADIUS;
            return (
              <div
                key={subject.id}
                ref={(node) => {
                  cardRefs.current.set(subject.id, node);
                }}
                // Every card is live, so a click can land in one that is not
                // focused. Focus it first: otherwise the composer pill and the
                // side panels would act on a different bot than the one under
                // the pointer. Capture phase, so it lands before the control.
                onMouseDownCapture={() => {
                  if (!isFocused) focus(subject.id);
                }}
                className="h-full w-full"
              >
                <SpaceCard
                  subject={subject}
                  focused={isFocused}
                  parked={parked}
                  onFocus={() => {
                    focus(subject.id);
                    if (view.kind === "grid") toTiles();
                  }}
                  onExpand={isFocused && canExpand ? expandFocused : undefined}
                >
                  {isGroup(subject) ? (
                    <GroupView group={subject} active={isFocused && view.kind === "tile"} composer={false} />
                  ) : (
                    <ChatView bot={subject} active={isFocused && view.kind === "tile"} composer={false} />
                  )}
                </SpaceCard>
              </div>
            );
          })}
    </SpacesStage>
      </div>

      {view.kind === "tile" && <SpacesToasts toasts={toasts} onPick={focus} />}

      {focused && !expandedBot && (
        <SpacesComposer subject={focused} subjects={subjects} onPick={(id) => { focus(id); if (view.kind === "grid") toTiles(); }} />
      )}

      <div className="pointer-events-auto absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-hairline/40 bg-panel/90 p-1 shadow-xl backdrop-blur">
        {TILE_COUNTS.map((per) => {
          const Icon = per === 1 ? Square : per === 2 ? Columns2 : Columns3;
          const on = view.kind === "tile" && view.per === per;
          return (
            <button
              key={per}
              type="button"
              aria-pressed={on}
              aria-label={per === 1 ? "One bot, full screen" : `${per} bots side by side`}
              title={`${per === 1 ? "Full screen" : `${per} across`}  ⌘⌥${per}`}
              onClick={() => showView({ kind: "tile", per })}
              className={cn(
                "grid size-7 place-items-center rounded-full transition-colors",
                on ? "bg-accent text-accent-ink" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              <Icon size={14} />
            </button>
          );
        })}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-hairline/50" />
        <button
          type="button"
          aria-pressed={view.kind === "grid"}
          aria-label="Show every bot at once"
          title="All bots  ⌘⌥↑"
          onClick={toGrid}
          className={cn(
            "grid size-7 place-items-center rounded-full transition-colors",
            view.kind === "grid" ? "bg-accent text-accent-ink" : "text-ink-secondary hover:bg-raised hover:text-ink",
          )}
        >
          <Grid2x2 size={14} />
        </button>
      </div>

      {degraded && (
        <div className="pointer-events-none absolute bottom-6 left-6 z-20 max-w-xs rounded-lg border border-hairline/40 bg-panel/90 px-3 py-2 text-[11px] text-ink-secondary backdrop-blur">
          Distant cards are paused to keep the canvas smooth on this machine.
        </div>
      )}

      {expandedBot && expanded && (
        <div ref={expandRef} className="absolute inset-0 z-40 bg-app">
          {expanded.kind === "browser" ? (
            <BrowserWorkspace bot={expandedBot} onClose={() => setExpanded(null)} />
          ) : (
            <LocalVmWorkspace
              primaryBotId={expandedBot.id}
              overlayOpen={false}
              onClose={() => setExpanded(null)}
              onOpenComputer={() => {
                setExpanded(null);
                dispatch({ type: "toggleComputer", open: true });
              }}
            />
          )}
        </div>
      )}

      {/* The chat's own side panels dock to the right of the transcript in the
          normal shell, as in-flow asides. Inside the canvas they would render
          underneath it, so the buttons looked dead. Mount them here, over the
          canvas, targeting whichever card is focused. */}
      {focusedBot && !expanded && (
        <>
          {state.computerOpen && (
            <div className="absolute inset-y-0 right-0 z-30 flex max-w-[90vw] shadow-2xl">
              <ComputerPanel
                key={focusedBot.id}
                bot={focusedBot}
                onOpenVmWorkspace={(botId) => {
                  dispatch({ type: "toggleComputer", open: false });
                  setExpanded({ kind: "vm", botId });
                }}
                onExpandBrowser={(botId) => {
                  dispatch({ type: "toggleComputer", open: false });
                  expandOrigin.current = cardRefs.current.get(botId)?.getBoundingClientRect() ?? null;
                  setExpanded({ kind: "browser", botId });
                }}
              />
            </div>
          )}
          {state.inspectorOpen && (
            <div className="absolute inset-y-0 right-0 z-30 flex max-w-[90vw] shadow-2xl">
              <InspectorPanel key={focusedBot.id} bot={focusedBot} />
            </div>
          )}
          {state.settingsOpen && (
            <div className="absolute inset-y-0 right-0 z-30 flex max-w-[90vw] shadow-2xl">
              <SettingsPanel key={focusedBot.id} bot={focusedBot} />
            </div>
          )}
        </>
      )}
    </CanvasFrame>
  );
}

function CanvasFrame({
  children,
  onClose,
  onWheel,
}: {
  children: ReactNode;
  onClose: () => void;
  onWheel?: (event: ReactWheelEvent) => void;
}) {
  return (
    <div
      onWheel={onWheel}
      className="fixed inset-0 z-40 overflow-hidden bg-app"
      style={{
        backgroundImage:
          "radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--color-accent) 12%, transparent) 0%, transparent 60%)",
      }}
    >
      {children}
      <button
        type="button"
        aria-label="Leave Spaces"
        onClick={onClose}
        className="absolute right-6 bottom-6 z-30 grid size-9 place-items-center rounded-full border border-hairline/40 bg-panel/90 text-ink-secondary shadow-xl backdrop-blur hover:text-ink"
      >
        <X size={16} />
      </button>
    </div>
  );
}
