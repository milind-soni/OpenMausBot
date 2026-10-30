import { useEffect, useState, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export const PRIMARY = "ui-button ui-button-primary min-h-9 px-4 text-[14px]";
export const SECONDARY = "ui-button min-h-9 px-4 text-[14px]";
export const QUIET = "rounded-md px-2 py-1.5 text-[13px] font-medium text-accent-text transition-colors hover:bg-raised/60 disabled:opacity-50 motion-reduce:transition-none";
export const CARD = "flex min-w-0 flex-col gap-2 rounded-2xl border p-4 text-left";
export const CARD_IDLE = "border-hairline/50 bg-card/50";
export const CARD_PICKED = "border-accent/70 bg-accent/[0.07] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_16%,transparent)]";

export function StepHeading({ title, sub, aside, headingRef }: { title: ReactNode; sub: ReactNode; aside?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return <header className="flex flex-col gap-1.5">
    <h2 ref={headingRef} id="cloud-welcome-step" tabIndex={-1} className="text-[21px] font-semibold tracking-[-0.02em] text-ink outline-none [text-wrap:balance]">
      {title}{aside && <span className="ml-2 align-[2px] text-[13px] font-medium tracking-normal text-ink-tertiary">{aside}</span>}
    </h2>
    <p className="text-[14px] leading-relaxed text-ink-secondary [text-wrap:pretty]">{sub}</p>
  </header>;
}

export function CardIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <span aria-hidden="true" className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-accent/15 text-accent-text">
    <Icon size={18} />
  </span>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="ui-chip border border-hairline/50 bg-panel text-ink-secondary tabular-nums">{children}</span>;
}

export function Footer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/** The name this app keeps for the server open in the window; My Cloud wherever the app has none. */
export function useCloudName(): string {
  const bridge = window.ogb?.workspaces;
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((current) => {
      if (alive && current && current.local === false && current.name.trim()) setName(current.name.trim());
    }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  return name ?? t("cloudSetup.myCloud");
}
