import { Puzzle } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { loadAppCards } from "./bot-settings/useBotApps";
import { preloadConnectedApps, type ToolkitCard } from "./PluginsPanel";
import { ELEVATED_CONTROL, ELEVATED_HOVER } from "./elevated";
import { SIMPLE_TOP_BUTTON } from "./SidebarSimpleTop";

export type AppFace = Pick<ToolkitCard, "slug" | "label" | "logo" | "domain">;

export const POPULAR_APPS: readonly AppFace[] = [
  { slug: "gmail", label: "Gmail", logo: null, domain: "gmail.com" },
  { slug: "slack", label: "Slack", logo: null, domain: "slack.com" },
  { slug: "notion", label: "Notion", logo: null, domain: "notion.so" },
];

export const APP_FACES = 3;

export function appFaces(connected: readonly string[], cards: ReadonlyMap<string, AppFace>): AppFace[] {
  const own = connected.map((slug) => cards.get(slug)).filter((card): card is AppFace => Boolean(card));
  return [...own, ...POPULAR_APPS.filter((app) => !own.some((card) => card.slug === app.slug))].slice(0, APP_FACES);
}

interface SidebarApps {
  faces: AppFace[];
  connected: boolean;
}

function useSidebarApps(): SidebarApps {
  const { state } = useStore();
  const [apps, setApps] = useState<SidebarApps>(() => ({ faces: appFaces([], new Map()), connected: false }));
  useEffect(() => {
    if (state.pluginsOpen) return;
    let alive = true;
    void preloadConnectedApps()
      .then(async (inventory) => {
        const connected = Object.entries(inventory.services).filter(([, status]) => status.connected).map(([slug]) => slug).sort();
        const cards = connected.length > 0 ? await loadAppCards() : new Map<string, AppFace>();
        if (alive) setApps({ faces: appFaces(connected, cards), connected: connected.length > 0 });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [state.pluginsOpen]);
  return apps;
}

function AppFaceIcon({ face, className }: { face: AppFace; className?: string }) {
  const sources = [face.logo, face.domain ? `https://www.google.com/s2/favicons?domain=${face.domain}&sz=64` : null].filter((src): src is string => Boolean(src));
  const [failed, setFailed] = useState(0);
  const src = sources[failed];
  return (
    <span data-app-face={face.slug} className={cn("flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-px ring-[1.5px] ring-composer", className)}>
      {src
        ? <img src={src} alt="" draggable={false} className="size-4 object-contain" onError={() => setFailed((count) => count + 1)} />
        : <span className="text-[10px] font-semibold leading-none text-neutral-700">{face.label.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** The outer logos fan out while the pill is hovered. */
const FAN = ["motion-safe:group-hover/apps:-translate-x-[3px] motion-safe:group-hover/apps:-rotate-[8deg]", "", "motion-safe:group-hover/apps:translate-x-[3px] motion-safe:group-hover/apps:rotate-[8deg]"];

/** `circle` is the collapsed rail's round button. */
export function SidebarConnectApps({ circle = false }: { circle?: boolean }) {
  const { state, dispatch } = useStore();
  const { faces, connected } = useSidebarApps();
  const label = connected ? t("sidebar.nav.apps") : t("sidebar.connectApps");
  return (
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      aria-pressed={state.pluginsOpen}
      aria-label={circle ? label : undefined}
      title={circle ? label : undefined}
      onClick={() => dispatch({ type: "togglePlugins", open: true })}
      className={circle ? SIMPLE_TOP_BUTTON : cn("group/apps flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full pl-4 pr-3 text-[14px] font-medium leading-5 text-ink", ELEVATED_CONTROL, ELEVATED_HOVER)}
    >
      {circle ? <Puzzle size={18} strokeWidth={1.5} aria-hidden="true" /> : <>
        <span className="min-w-0 truncate">{label}</span>
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {faces.map((face, index) => <AppFaceIcon key={face.slug} face={face}
            className={cn(index > 0 && "-ms-1.5", faces.length > 1 && FAN[index === 0 ? 0 : index === faces.length - 1 ? 2 : 1], "motion-safe:transition-transform motion-safe:duration-150")} />)}
        </span>
      </>}
    </button>
  );
}
