import { useEffect, useState } from "react";
import { ChevronDown, Cloud, Laptop } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** "· always on" after the server's name while the window shows an OMB Cloud
 * home (config.cloudHome), so people know which computer they are on. */
function AlwaysOn() {
  return <span className="font-normal text-ink-secondary"> · {t("cloudSetup.alwaysOn")}</span>;
}

/** The dropdown is native: a remote workspace cannot choose a destination
 * itself or read the other workspaces saved on this computer. Outside the
 * desktop app there is nothing to switch; a Cloud home still says what it is,
 * and whose it is when this browser signed in from the Cloud page (`owner`). */
export function DesktopWorkspaceSwitcher({ compact = false, cloudHome = false, owner = null }: { compact?: boolean; cloudHome?: boolean; owner?: string | null }) {
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
    return <div data-cloud-home-indicator className={cn("py-1.5", compact ? "px-2" : "px-3")}>
      <div title={label} className={cn("flex items-center gap-2 py-2 text-[13px] font-medium text-ink", compact ? "justify-center px-1" : "px-2")}>
        <Cloud size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        {compact ? <span className="sr-only">{label}</span> : <span className="min-w-0 flex-1 truncate">{t("cloudSetup.myCloud")}<AlwaysOn />
          {whose && <span className="block truncate text-[11.5px] font-normal text-ink-secondary">{whose}</span>}</span>}
      </div>
    </div>;
  }
  // Main names the saved server; until it answers, a Cloud home is still My Cloud.
  const name = current?.name ?? (cloudHome ? t("cloudSetup.myCloud") : "Servers");
  const Icon = current?.local === false || (cloudHome && !current) ? Cloud : Laptop;
  const shown = cloudHome ? `${name} · ${t("cloudSetup.alwaysOn")}` : name;
  return <div className={cn("py-1.5", compact ? "px-2" : "px-3")}>
    <button type="button" aria-label={`Switch server: ${shown}`} aria-haspopup="menu" aria-expanded={open} data-cloud-home-indicator={cloudHome || undefined}
      title={current?.origin ? `${shown} · ${current.origin}` : shown}
      onClick={() => {
        if (open) return;
        setError(""); setOpen(true);
        void bridge.menu().catch(() => setError("Could not open the server list. Try the Server menu.")).finally(() => setOpen(false));
      }}
      className={cn("flex w-full items-center gap-2 rounded-lg py-2 text-left text-[13px] font-medium text-ink hover:bg-control focus-visible:outline focus-visible:outline-accent", compact ? "justify-center px-1" : "px-2")}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Icon size={16} className="shrink-0 text-ink-secondary" />
      {!compact && <><span className="min-w-0 flex-1 truncate">{name}{cloudHome && <AlwaysOn />}</span><ChevronDown size={13} className="shrink-0 text-ink-secondary" /></>}
    </button>
    {error && <p role="alert" className="mt-1 text-[11px] text-danger">{error}</p>}
  </div>;
}
