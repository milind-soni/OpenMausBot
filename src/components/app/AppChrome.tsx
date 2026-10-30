import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, CircleAlert, Info, Loader2, RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { AppNetwork } from "../../../shared/app";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_QUIET_BUTTON } from "../AskCard";

export const APP_SURFACE = "w-full overflow-hidden rounded-2xl bg-composer ring-1 ring-composer-ring";
const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40";

export function formatAppBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AppHeader({
  title,
  origin,
  infoId,
  infoOpen,
  onInfo,
  onReload,
  reloading = false,
  bordered,
}: {
  title: string;
  origin: string;
  infoId: string;
  infoOpen: boolean;
  onInfo(): void;
  onReload?: () => void;
  reloading?: boolean;
  bordered: boolean;
}) {
  return (
    <div data-app-header className={cn("flex items-start gap-3", bordered ? "px-4 pb-3 pt-3.5" : "pb-2")}>
      <div className="min-w-0 flex-1">
        <div title={title} className="truncate text-[15px] font-semibold leading-6 text-ink"><bdi dir="auto">{title}</bdi></div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-snug text-ink-secondary">
          <AppWindow aria-hidden="true" size={13} className="shrink-0 text-ink-tertiary" />
          <span dir="auto" className="min-w-0 truncate">{origin}</span>
        </div>
      </div>
      <div className="-me-1.5 mt-0.5 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={t("app.info")}
          title={t("app.info")}
          aria-expanded={infoOpen}
          aria-controls={infoId}
          onClick={onInfo}
          className={cn(ICON_BUTTON, infoOpen && "bg-ink/[0.07] text-ink")}
        >
          <Info size={15} />
        </button>
        {onReload && (
          <button type="button" aria-label={t("app.reload")} title={t("app.reload")} onClick={onReload} disabled={reloading} className={ICON_BUTTON}>
            <RotateCw size={14} className={cn(reloading && "animate-spin motion-reduce:animate-none")} />
          </button>
        )}
      </div>
    </div>
  );
}

function OriginList({ origins }: { origins: readonly string[] }) {
  if (!origins.length) return <span className="text-ink-tertiary">{t("app.info.nothing")}</span>;
  return <span className="[overflow-wrap:anywhere]">{origins.join(", ")}</span>;
}

export function AppInfo({ id, network, bytes, bordered }: { id: string; network: AppNetwork; bytes: number; bordered: boolean }) {
  const rows: Array<[string, ReactNode]> = [
    [t("app.info.loads"), <OriginList key="r" origins={network.resources} />],
    [t("app.info.connects"), <OriginList key="c" origins={network.connect} />],
  ];
  if (network.refused?.length) rows.push([t("app.info.refused"), <span key="x" className="[overflow-wrap:anywhere]">{network.refused.join(", ")}</span>]);
  if (bytes > 0) rows.push([t("app.info.size"), formatAppBytes(bytes)]);
  rows.push([t("app.info.off"), t("app.info.offList")]);
  return (
    <div id={id} data-app-info className={cn("rounded-2xl bg-inset px-3.5 py-3 text-[13px] leading-[18px]", bordered ? "mx-4 mb-3" : "mb-2")}>
      <p className="mb-2 text-ink-secondary">{t("app.info.sandbox")}</p>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="whitespace-nowrap text-ink-tertiary">{label}</dt>
            <dd className="min-w-0 text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AppStrip({ text, action, bordered, tone = "warning" }: {
  text: string;
  action?: { label: string; onClick(): void };
  bordered: boolean;
  tone?: "warning" | "quiet";
}) {
  return (
    <div role="status" data-app-strip className={cn("flex items-center gap-2 border-t border-ink/[0.12] py-2.5 text-[13px] leading-[18px] text-ink-secondary", bordered ? "mx-4" : "mt-2")}>
      <CircleAlert aria-hidden="true" size={14} className={cn("shrink-0", tone === "warning" ? "text-warning" : "text-ink-tertiary")} />
      <span dir="auto" className="min-w-0 flex-1 break-words">{text}</span>
      {action && <button type="button" onClick={action.onClick} className={ASK_QUIET_BUTTON}>{action.label}</button>}
    </div>
  );
}

/** Keeps the frame's height while no frame runs, so the transcript does not jump. */
export function AppPlaceholder({ height, loading, open, label, children }: {
  height: number;
  loading?: boolean;
  open?: () => void;
  label?: string;
  children?: ReactNode;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, [loading]);
  return (
    <div data-app-placeholder className="flex w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ height }}>
      {children}
      {loading && slow && (
        <span role="status" className="flex items-center gap-1.5 text-[13px] text-ink-tertiary">
          <Loader2 aria-hidden="true" size={14} className="animate-spin motion-reduce:animate-none" />
          {t("app.loading")}
        </span>
      )}
      {!loading && open && <AppOpenButton label={label ?? t("app.open")} onClick={open} />}
    </div>
  );
}

export function AppOpenButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
      <AppWindow aria-hidden="true" size={14} />
      {label}
    </button>
  );
}
