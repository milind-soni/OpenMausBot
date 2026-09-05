// The bot's browser in the chat column: a picture-in-picture card over the
// transcript's bottom-right corner, sized to the page's own 16:10 so nothing
// is letterboxed. The page itself is the same native view the Computer panel
// shows; this component decides when the chat should host it (the bot
// opened a page, or asked for hands) and draws the fold-down pill when the
// person has collapsed it. Pure decisions live in lib/browser-dock.ts.
import { useEffect, useState } from "react";
import { ChevronUp, Globe, Hand } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { browserDockAvailable, browserDockLabel, nextBrowserDockState } from "@/lib/browser-dock";
import { useBrowserControl } from "@/hooks/use-browser-control";
import { BrowserPanel } from "./BrowserPanel";

export function BrowserDock({ bot, onExpand }: { bot: Bot; onExpand?: () => void }) {
  const { state, dispatch } = useStore();
  const bridge = window.ogb?.browser;
  const available = browserDockAvailable({
    featureEnabled: builtInBrowserEnabled(state.config),
    botBrowser: bot.browser,
    bridge: Boolean(bridge),
    composer: true,
    remoteClient: window.ogb?.remoteClient?.active === true,
  });
  const dock = state.browserDock[bot.id];
  const helpReason = state.computerControl[bot.id]?.helpReason ?? null;
  const [surface, setSurface] = useState<BrowserSurfaceState | null>(null);

  // Follow the bot's active view: the first real page opens the dock, a
  // closed view removes it. Events for other bots are not ours.
  useEffect(() => {
    if (!available || !bridge) return;
    let alive = true;
    const accept = (next: BrowserSurfaceState) => {
      if (!alive || next.botId !== bot.id) return;
      setSurface(next);
    };
    bridge.state(bot.id).then(accept).catch(() => {});
    const off = bridge.onState(accept);
    return () => {
      alive = false;
      off();
    };
  }, [available, bridge, bot.id]);

  useEffect(() => {
    if (!available || !surface) return;
    const next = nextBrowserDockState({ current: dock, surfaceOpen: surface.open, url: surface.url, helpReason });
    if ((next ?? null) !== (dock ?? null)) dispatch({ type: "browserDock", botId: bot.id, state: next ?? null });
  }, [available, surface, helpReason, dock, bot.id, dispatch]);

  if (!available || !dock) return null;
  if (dock === "collapsed") return <CollapsedBar bot={bot} label={browserDockLabel(surface)} />;
  return <OpenDock bot={bot} onExpand={onExpand} />;
}

function OpenDock({ bot, onExpand }: { bot: Bot; onExpand?: () => void }) {
  const { dispatch } = useStore();
  const { control, controlPending, controlAction, error } = useBrowserControl(bot.id);
  return (
    <div
      data-browser-dock="open"
      className="pointer-events-auto mb-2 w-[clamp(320px,44%,600px)] max-w-full rounded-2xl border border-hairline/40 bg-panel p-2.5 shadow-xl shadow-black/40"
    >
      <BrowserPanel
        bot={bot}
        control={control}
        controlPending={controlPending}
        onControl={controlAction}
        onDismissHelp={() => void controlAction("dismiss-help")}
        size="docked"
        onExpand={onExpand}
        onCollapse={() => dispatch({ type: "browserDock", botId: bot.id, state: "collapsed" })}
      />
      {error && (
        <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function CollapsedBar({ bot, label }: { bot: Bot; label: string }) {
  const { state, dispatch } = useStore();
  const held = state.computerControl[bot.id]?.held === true;
  return (
    <div
      data-browser-dock="collapsed"
      className="pointer-events-auto mb-2 flex max-w-[420px] items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[12.5px] text-ink-secondary shadow-md shadow-black/30"
    >
      <Globe size={13} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <span className="text-ink">{bot.name}'s browser</span>
        {label ? ` · ${label}` : ""}
      </span>
      {held && (
        <span className="flex shrink-0 items-center gap-1 text-accent-text">
          <Hand size={12} aria-hidden="true" /> you have control
        </span>
      )}
      <button
        type="button"
        onClick={() => dispatch({ type: "browserDock", botId: bot.id, state: "open" })}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] text-ink outline-none hover:bg-control focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Show the browser"
      >
        Show <ChevronUp size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
