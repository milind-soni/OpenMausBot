import { useEffect, useState } from "react";
import { ChevronDown, Cloud, Laptop } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The native server menu; resolves when it closes. While the Show me how tip
 * is up (`howTo`) it opens as reached from the tip, and `onClosed` ends the
 * tip when it closes, whatever was chosen. */
export function openServerMenu(bridge: { menu: (options?: { from?: "howto" }) => Promise<void> }, { howTo = false, onClosed }: { howTo?: boolean; onClosed?: () => void } = {}): Promise<void> {
  return bridge.menu(howTo ? { from: "howto" } : undefined).finally(() => { if (howTo) onClosed?.(); });
}

/** "· always on" after the server's name while the window shows an OMB Cloud
 * home (config.cloudHome), so people know which computer they are on. */
function AlwaysOn() {
  return <span className="font-normal text-ink-secondary"> · {t("cloudSetup.alwaysOn")}</span>;
}

/** `inline` is the small pill that shares the sidebar's top row with the
 * traffic lights and the header buttons: icon, short name, tiny chevron,
 * truncating to whatever width the row leaves it (and clipping, never
 * spilling onto the buttons, in the narrowest rows). Inside a `sidebar-top`
 * container narrower than 96px it drops the name for icon + chevron, because
 * that is too little for icon, a truncated name, and the chevron. Wider than
 * that, including the default macOS Advanced row (about 121px), the name
 * stays and truncates. The title and aria-label keep the full name. It
 * brings no row padding of its own; the row
 * places it at the right beside the buttons and, being `relative`, anchors
 * its error note to the row's right end so the note stays inside the sidebar.
 *
 * The dropdown is native: a remote workspace cannot choose a destination
 * itself or read the other workspaces saved on this computer. Outside the
 * desktop app there is nothing to switch; a Cloud home still says what it is,
 * and whose it is when this browser signed in from the Cloud page (`owner`).
 * Both buttons are the Show me how tip's anchor ("server-switcher"); while
 * the tip is up (`howTo`), the menu opens as reached from it, and
 * `onMenuClosed` ends the tip when it closes. */
export function DesktopWorkspaceSwitcher({ compact = false, inline = false, cloudHome = false, owner = null, howTo = false, onMenuClosed }: {
  compact?: boolean; inline?: boolean; cloudHome?: boolean; owner?: string | null; howTo?: boolean; onMenuClosed?: () => void;
}) {
  const bridge = window.ogb?.workspaces;
  const [current, setCurrent] = useState<{ local: boolean; name: string; origin?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((state) => { if (alive) setCurrent(state); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge) {
    if (!cloudHome) return null;
    const whose = owner ? t("sidebar.cloudOwner", { email: owner }) : "";
    const label = `${t("cloudSetup.myCloud")} · ${t("cloudSetup.alwaysOn")}${whose ? ` · ${whose}` : ""}`;
    if (inline) return <div data-cloud-home-indicator data-workspace-switcher="inline" title={label}
      className="flex min-w-0 items-center gap-1.5 px-1.5 text-[12.5px] font-medium text-ink">
      <Cloud size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 truncate">{t("cloudSetup.myCloud")}</span>
      <span className="sr-only"> · {t("cloudSetup.alwaysOn")}{whose ? ` · ${whose}` : ""}</span>
    </div>;
    return <div data-cloud-home-indicator className={cn("py-1.5", compact ? "px-2" : "px-3")}>
      <div title={label} className={cn("flex items-center gap-2 py-2 text-[13px] font-medium text-ink", compact ? "justify-center px-1" : "px-2")}>
        <Cloud size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        {compact ? <span className="sr-only">{label}</span> : <span className="min-w-0 flex-1 truncate">{t("cloudSetup.myCloud")}<AlwaysOn />
          {whose && <span className="block truncate text-[11.5px] font-normal text-ink-secondary">{whose}</span>}</span>}
      </div>
    </div>;
  }
  // Main names the saved server; until it answers, a Cloud home is still My Cloud.
  const name = current?.name ?? (cloudHome ? t("cloudSetup.myCloud") : t("sidebar.servers"));
  const Icon = current?.local === false || (cloudHome && !current) ? Cloud : Laptop;
  const shown = cloudHome ? `${name} · ${t("cloudSetup.alwaysOn")}` : name;
  const title = current?.origin ? `${shown} · ${current.origin}` : shown;
  const label = t("sidebar.switchServer", { name: shown });
  const openMenu = () => {
    if (open) return;
    setError(""); setOpen(true);
    void openServerMenu(bridge, { howTo, onClosed: onMenuClosed }).catch(() => setError(t("sidebar.switchServerError")))
      .finally(() => setOpen(false));
  };
  if (inline) return <div data-workspace-switcher="inline" className="flex min-w-0">
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-cloud-home-indicator={cloudHome || undefined}
      data-tour="server-switcher" title={title} onClick={openMenu}
      className="flex h-7 min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left text-[12.5px] font-medium text-ink hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Icon size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      {/* Hide the name only when this slot cannot hold icon, a truncated
          name, and the chevron. Default macOS Advanced (~121px) still shows it. */}
      <span className="min-w-0 truncate @max-[96px]/sidebar-top:hidden">{name}</span>
      <ChevronDown size={11} aria-hidden="true" className="shrink-0 text-ink-secondary" />
    </button>
    {error && <p role="alert" className="absolute right-2 top-full z-40 mt-1 w-56 max-w-[calc(100%-1rem)] rounded-md bg-menu px-2 py-1 text-[11px] text-danger shadow-lg">{error}</p>}
  </div>;
  return <div className={cn("py-1.5", compact ? "px-2" : "px-3")}>
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-cloud-home-indicator={cloudHome || undefined}
      data-tour="server-switcher" title={title}
      onClick={openMenu}
      className={cn("flex w-full items-center gap-2 rounded-lg py-2 text-left text-[13px] font-medium text-ink hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", compact ? "justify-center px-1" : "px-2")}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Icon size={16} className="shrink-0 text-ink-secondary" />
      {!compact && <><span className="min-w-0 flex-1 truncate">{name}{cloudHome && <AlwaysOn />}</span><ChevronDown size={13} className="shrink-0 text-ink-secondary" /></>}
    </button>
    {error && <p role="alert" className="mt-1 text-[11px] text-danger">{error}</p>}
  </div>;
}
