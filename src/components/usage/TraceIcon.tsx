import { useEffect, useState } from "react";
import {
  Blocks, Brain, CalendarClock, Database, FileText, Globe, Image, LayoutDashboard, ListChecks, Monitor, Newspaper, Plug,
  Search, Smartphone, Sparkles, SquareTerminal, Users, Wrench, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import type { TraceToolIcon } from "../../../shared/usage-trace";
import { BotAvatar } from "../Avatar";
import { loadAppCards } from "../bot-settings/useBotApps";
import { ServiceIcon, type ToolkitCard } from "../PluginsPanel";

const ICONS: Record<Exclude<TraceToolIcon, "app">, LucideIcon> = {
  search: Search, web: Globe, browser: Globe, computer: Monitor, phone: Smartphone, files: FileText, terminal: SquareTerminal,
  memory: Brain, routine: CalendarClock, page: Newspaper, widget: LayoutDashboard, bots: Users, plan: ListChecks, image: Image,
  data: Database, mcp: Plug, tool: Wrench,
};

const BOX = "flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline/50 bg-raised";

let cards: ReadonlyMap<string, ToolkitCard> | null = null;

/** The connected-app catalog's cards, fetched once for every trace on the page. */
export function useAppCards(): ReadonlyMap<string, ToolkitCard> {
  const [loaded, setLoaded] = useState(cards ?? new Map<string, ToolkitCard>());
  useEffect(() => {
    if (cards) return;
    let current = true;
    void loadAppCards().then((result) => {
      cards = result;
      if (current) setLoaded(result);
    });
    return () => { current = false; };
  }, []);
  return loaded;
}

export function appName(app: string | undefined, catalog: ReadonlyMap<string, ToolkitCard>): string | undefined {
  if (!app) return undefined;
  return catalog.get(app)?.label ?? app.charAt(0).toUpperCase() + app.slice(1);
}

export function ToolIcon({ icon, app, catalog, error = false }: { icon: TraceToolIcon; app?: string; catalog: ReadonlyMap<string, ToolkitCard>; error?: boolean }) {
  if (icon === "app" && app) {
    const card = catalog.get(app);
    return (
      <span className={BOX}>
        <ServiceIcon key={`${card?.logo}:${card?.domain}`} card={{ logo: card?.logo ?? null, domain: card?.domain ?? null, label: card?.label ?? app }} className="size-4 rounded-[4px]" />
      </span>
    );
  }
  const Icon = icon === "app" ? Blocks : ICONS[icon];
  return (
    <span className={BOX} aria-hidden>
      <Icon size={13} className={error ? "text-danger" : icon === "browser" || icon === "web" ? "text-accent" : "trace-tool-ink"} />
    </span>
  );
}

export function StepIcon() {
  return (
    <span className={cn(BOX, "trace-step-box")} aria-hidden>
      <Sparkles size={13} className="trace-step-ink" />
    </span>
  );
}

export function TurnAvatar({ bot, name }: { bot: Bot | undefined; name: string }) {
  if (bot) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center">
        <BotAvatar bot={bot} size={24} state="idle" animated={false} />
      </span>
    );
  }
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-secondary" aria-hidden>
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
