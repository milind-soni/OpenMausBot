// The buying sheet's small pieces, drawn only with the skin's tokens so every skin gets its own version.
import type { ReactNode } from "react";
import { Check, ChevronLeft, Cloud } from "lucide-react";
import { cn } from "@/lib/cn";
import { cloudColorFill } from "@/lib/cloud-look";
import { t } from "@/lib/i18n";

/** The app's primary action, full width, for the one next step of a screen. */
export const PRIMARY_WIDE = "ui-button ui-button-primary min-h-11 w-full rounded-xl px-4 text-[15px] font-semibold";
export const LINK = "rounded-md text-[13px] font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";
export const FIELD = "w-full rounded-lg border border-hairline bg-app px-3 py-2.5 text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-tertiary focus:border-accent focus:ring-[3px] focus:ring-accent/25 disabled:opacity-60 motion-reduce:transition-none";

export function Heading({ title, sub }: { title: string; sub?: ReactNode }) {
  return <div className="pe-8">
    <h2 id="cloud-add-title" tabIndex={-1} className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink outline-none [text-wrap:balance]">{title}</h2>
    {sub && <p className="mt-1.5 text-[14px] leading-relaxed text-ink-secondary">{sub}</p>}
  </div>;
}

export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick}
    className="-ms-1 mb-2 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
    <ChevronLeft size={15} aria-hidden="true" />{label}
  </button>;
}

/** A step of a short checklist: done (a tick), now (turning, still in reduced motion), or next (an empty ring). */
export function StepMark({ state, size = 22 }: { state: "done" | "now" | "next"; size?: number }) {
  if (state === "done") return <span aria-hidden="true" style={{ width: size, height: size }}
    className="grid shrink-0 place-items-center rounded-full bg-success text-[var(--color-success-ink)]"><Check size={Math.round(size * 0.62)} strokeWidth={2.6} /></span>;
  return <span aria-hidden="true" style={{ width: size, height: size }}
    className={cn("block shrink-0 rounded-full border-2", state === "now" ? "animate-spin border-accent/25 border-t-accent motion-reduce:animate-none" : "border-hairline")} />;
}

export function Checklist({ items, label }: { label?: string; items: Array<{ key: string; state: "done" | "now" | "next"; title: string; detail?: string | null }> }) {
  return <ol aria-label={label} className="flex flex-col gap-1">
    {items.map(item => <li key={item.key} aria-current={item.state === "now" ? "step" : undefined}
      className={cn("grid grid-cols-[22px_minmax(0,1fr)] items-start gap-3 rounded-xl px-3 py-2.5", item.state === "now" && "bg-accent/10")}>
      <StepMark state={item.state} />
      <span className="min-w-0">
        <span className={cn("block text-[14px] font-semibold", item.state === "next" ? "text-ink-secondary" : "text-ink")}>{item.title}</span>
        {item.detail && <span className="block break-words text-[13px] text-ink-secondary">{item.detail}</span>}
      </span>
    </li>)}
  </ol>;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-raised">
    <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${percent}%` }} />
  </div>;
}

/** A saved server's colour as the switcher draws it: a rounded tile with the Cloud mark. */
export function CloudTile({ color, size = 22 }: { color: unknown; size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size, background: cloudColorFill(color) }}
    className="grid shrink-0 place-items-center rounded-[7px] text-white"><Cloud size={Math.round(size * 0.62)} strokeWidth={2.2} /></span>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-success/12 px-2.5 py-1 text-[12px] font-semibold text-success">
    <Check size={13} strokeWidth={2.6} aria-hidden="true" />{children}
  </span>;
}

/** On the staging Admin (OMB_CLOUD_STAGING=1) the sheet and Settings say so, so nobody takes it for the real one. */
export function StagingMark({ className }: { className?: string }) {
  return <span data-cloud-staging title={t("cloudBuy.stagingHint")}
    className={cn("inline-flex items-center rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-warning", className)}>
    {t("cloudBuy.staging")}<span className="sr-only">: {t("cloudBuy.stagingHint")}</span>
  </span>;
}
