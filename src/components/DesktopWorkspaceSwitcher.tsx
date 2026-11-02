import { useEffect, useState } from "react";
import { ChevronDown, Cloud, Laptop } from "lucide-react";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import type { Action } from "@/state/store";
import type { CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { cloudColor } from "@/lib/cloud-look";
import { t } from "@/lib/i18n";
import { railShown, usePlaces } from "@/lib/places";
import { CloudTile } from "./cloud-buy/parts";
import { SIMPLE_RAIL_BUTTON } from "./SidebarSimpleTop";

export function openServerMenu(bridge: { menu: (options?: { from?: "howto" }) => Promise<void> }, { howTo = false, onClosed }: { howTo?: boolean; onClosed?: () => void } = {}): Promise<void> {
  return bridge.menu(howTo ? { from: "howto" } : undefined).finally(() => { if (howTo) onClosed?.(); });
}

export function endCloudHowTo(dispatch: (action: Action) => void): void {
  track("cloud_howto", { result: "closed" });
  dispatch({ type: "cloudHowTo", open: false });
}

function PowerLine({ text }: { text: string }) {
  return <span className="font-normal text-ink-secondary"> · {text}</span>;
}

/** Whether a plan sleeps when idle, from main's verified plan: an active plan whose Cloud the Admin never sleeps does not;
 * null while that isn't known. */
export function planSleeps(plan: CloudPlanSnapshot | null): boolean | null {
  if (plan?.sleeps === true) return true;
  return plan?.status === "paid" ? false : null;
}

/** On My Cloud's page in the app, whether its plan sleeps when idle (planSleeps; null while unknown, and always in a
 * browser); on this computer's page, whether opening My Cloud waits for it to wake. */
export function useCloudPower(cloudHome: boolean): { sleeps: boolean | null; waking: boolean } {
  const plan = cloudHome && !window.ogb?.remoteClient?.active ? window.ogb?.cloudPlan : undefined;
  const account = cloudHome || window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [sleeps, setSleeps] = useState<boolean | null>(null);
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    if (!plan) return;
    let alive = true;
    void plan.state().then((state) => { if (alive) setSleeps(planSleeps(state)); }).catch(() => {});
    return () => { alive = false; };
  }, [plan]);
  useEffect(() => account?.onState((state) => setWaking(state.waking === true)), [account]);
  return { sleeps: plan ? sleeps : null, waking };
}

export type WorkspacePlace = ReturnType<typeof useWorkspacePlace>;

/**
 * Security: the dropdown is native; a remote workspace cannot choose a destination or read the other workspaces saved
 * here.
 */
export function useWorkspacePlace({ cloudHome = false, howTo = false, onMenuClosed }: { cloudHome?: boolean; howTo?: boolean; onMenuClosed?: () => void }) {
  const bridge = window.ogb?.workspaces;
  const [current, setCurrent] = useState<{ local: boolean; name: string; origin?: string; color?: string; home?: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const read = () => void bridge?.state().then((state) => { if (alive) setCurrent(state); }).catch(() => {});
    read();
    // Main's word that a place changed (its colour, say): the switcher's dot follows.
    const off = bridge?.onChanged?.(read);
    return () => { alive = false; off?.(); };
  }, [bridge]);
  const power = useCloudPower(cloudHome || current?.home === true);
  const onLine = power.sleeps === null ? "" : t(power.sleeps ? "cloudSetup.sleepsWhenIdle" : "cloudSetup.alwaysOn");
  const waking = power.waking ? t("cloudHome.waking") : "";
  const openMenu = () => {
    if (!bridge || open) return;
    setError(""); setOpen(true);
    void openServerMenu(bridge, { howTo, onClosed: onMenuClosed }).catch(() => setError(t("sidebar.switchServerError")))
      .finally(() => setOpen(false));
  };
  return { bridge, current, cloudHome, open, error, onLine, waking, openMenu, switchable: Boolean(bridge) && current?.home !== true };
}

/** `place`: what this Cloud is called here, a team's name on a team's Cloud; My Cloud otherwise. */
type SwitcherProps = {
  compact?: boolean; inline?: boolean; pill?: boolean; rail?: boolean; cloudHome?: boolean; owner?: string | null; howTo?: boolean; place?: string; onMenuClosed?: () => void;
};

/** The place on screen and the native Server menu; where a rail of places stands beside the page, the rail switches
 * instead: the window's own rail at every width, one drawn on the page on a wide window. */
export function DesktopWorkspaceSwitcher(props: SwitcherProps) {
  const places = usePlaces();
  const switcher = <Switcher {...props} />;
  return railShown(places) ? <div data-switcher-beside-rail className={places.beside ? "hidden" : "contents md:hidden"}>{switcher}</div> : switcher;
}

function Switcher({ compact = false, inline = false, pill = false, rail = false, cloudHome = false, owner = null, howTo = false, place, onMenuClosed }: SwitcherProps) {
  const cloudName = place || t("cloudSetup.myCloud");
  const { bridge, current, open, error, onLine, waking, openMenu } = useWorkspacePlace({ cloudHome, howTo, onMenuClosed });
  const withPower = (name: string) => (onLine ? `${name} · ${onLine}` : name);
  // This window's home is My Cloud: it opens nothing else, so there is nothing to switch.
  if (!bridge || current?.home === true) {
    if (!cloudHome && !current?.home) return null;
    const whose = owner ? t("sidebar.cloudOwner", { email: owner }) : "";
    const label = `${withPower(cloudName)}${whose ? ` · ${whose}` : ""}`;
    if (rail) return <div data-cloud-home-indicator data-workspace-switcher="rail" role="img" aria-label={label} title={label} className="flex size-9 items-center justify-center text-ink-secondary">
      <Cloud size={18} aria-hidden="true" />
    </div>;
    if (inline) return <div data-cloud-home-indicator data-workspace-switcher="inline" title={label}
      className={pill ? "flex h-8 min-w-0 items-center gap-1 rounded-full bg-raised/50 px-3 text-[13px] font-medium text-ink" : "flex min-w-0 items-center gap-1.5 px-1.5 text-[13px] font-medium text-ink"}>
      <Cloud size={pill ? 15 : 14} aria-hidden="true" className={pill ? "hidden shrink-0 text-ink-secondary @max-[124px]/sidebar-top:block" : "shrink-0 text-ink-secondary"} />
      <span className={pill ? "min-w-0 truncate @max-[124px]/sidebar-top:hidden" : "min-w-0 truncate"}>{cloudName}</span>
      {(onLine || whose) && <span className="sr-only">{onLine ? ` · ${onLine}` : ""}{whose ? ` · ${whose}` : ""}</span>}
    </div>;
    return <div data-cloud-home-indicator className={cn("py-1.5", compact ? "px-2" : "px-3")}>
      <div title={label} className={cn("flex items-center gap-2 py-2 text-[13px] font-medium text-ink", compact ? "justify-center px-1" : "px-2")}>
        <Cloud size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        {compact ? <span className="sr-only">{label}</span> : <span className="min-w-0 flex-1 truncate">{cloudName}{onLine && <PowerLine text={onLine} />}
          {whose && <span className="block truncate text-[12px] font-normal text-ink-secondary">{whose}</span>}</span>}
      </div>
    </div>;
  }
  const name = current?.name ?? (cloudHome ? cloudName : t("sidebar.servers"));
  const Icon = current?.local === false || (cloudHome && !current) ? Cloud : Laptop;
  const shown = cloudHome ? withPower(name) : name;
  const title = current?.origin ? `${shown} · ${current.origin}` : shown;
  const label = t("sidebar.switchServer", { name: shown });
  if (rail) return <div data-workspace-switcher="rail" className="relative">
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-cloud-home-indicator={cloudHome || undefined}
      data-tour="server-switcher" title={title} onClick={openMenu} className={cn(SIMPLE_RAIL_BUTTON, "aria-expanded:bg-raised")}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {cloudColor(current?.color) ? <CloudTile color={current?.color} size={18} /> : <Icon size={18} aria-hidden="true" />}
    </button>
    {error && <p role="alert" className="absolute bottom-0 left-full z-40 ml-2 w-56 rounded-md bg-menu px-2 py-1 text-[11px] text-danger shadow-lg">{error}</p>}
    {waking && !error && <p role="status" data-cloud-waking className="absolute bottom-0 left-full z-40 ml-2 w-56 rounded-md bg-menu px-2 py-1 text-[11px] text-ink-secondary shadow-lg">{waking}</p>}
  </div>;
  if (inline) return <div data-workspace-switcher="inline" className="flex min-w-0">
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-cloud-home-indicator={cloudHome || undefined}
      data-tour="server-switcher" title={title} onClick={openMenu}
      className={pill
        ? "flex h-8 min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-full bg-raised/50 pl-2.5 pr-1.5 text-left text-[13px] font-medium text-ink hover:bg-raised aria-expanded:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        : "flex h-7 min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left text-[13px] font-medium text-ink hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {cloudColor(current?.color) ? <CloudTile color={current?.color} size={16} /> : <Icon size={pill ? 15 : 14} aria-hidden="true" data-switcher-icon className={pill ? "hidden shrink-0 text-ink-secondary @max-[124px]/sidebar-top:block" : "shrink-0 text-ink-secondary"} />}
      <span className={pill ? "min-w-0 truncate @max-[124px]/sidebar-top:hidden" : "min-w-0 truncate @max-[96px]/sidebar-top:hidden"}>{name}</span>
      <ChevronDown size={pill ? 12 : 11} aria-hidden="true" className={pill ? "shrink-0 text-ink-tertiary" : "shrink-0 text-ink-secondary"} />
    </button>
    {error && <p role="alert" className="absolute right-2 top-full z-40 mt-1 w-56 max-w-[calc(100%-1rem)] rounded-md bg-menu px-2 py-1 text-[11px] text-danger shadow-lg">{error}</p>}
    {waking && !error && <p role="status" data-cloud-waking className="absolute right-2 top-full z-40 mt-1 w-56 max-w-[calc(100%-1rem)] rounded-md bg-menu px-2 py-1 text-[11px] text-ink-secondary shadow-lg">{waking}</p>}
  </div>;
  return <div className={cn("py-1.5", compact ? "px-2" : "px-3")}>
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-cloud-home-indicator={cloudHome || undefined}
      data-tour="server-switcher" title={title}
      onClick={openMenu}
      className={cn("flex w-full items-center gap-2 rounded-lg py-2 text-left text-[13px] font-medium text-ink hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", compact ? "justify-center px-1" : "px-2")}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {cloudColor(current?.color) ? <CloudTile color={current?.color} size={20} /> : <Icon size={16} className="shrink-0 text-ink-secondary" />}
      {!compact && <><span className="min-w-0 flex-1 truncate">{name}{cloudHome && onLine && <PowerLine text={onLine} />}</span><ChevronDown size={13} className="shrink-0 text-ink-secondary" /></>}
    </button>
    {error && <p role="alert" className="mt-1 text-[11px] text-danger">{error}</p>}
    {waking && !error && <p role="status" data-cloud-waking className="mt-1 text-[11px] text-ink-secondary">{waking}</p>}
  </div>;
}
