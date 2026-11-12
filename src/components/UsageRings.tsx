import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { refreshTime, urgentUsage, usageLabel, usageView } from "@/lib/usage";
import { UsageRingGraphic } from "./UsageRingGraphic";
import { UsageTooltip } from "./UsageTooltip";
import { UsagePopover, type UsageItem } from "./UsagePopover";

function RingButton({ item, now, summaryCount, expanded, onOpen }: { item: UsageItem; now: number; summaryCount?: number; expanded: boolean; onOpen: () => void }) {
  const [tooltip, setTooltip] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const view = usageView(item.usage, now);
  const label = summaryCount !== undefined ? `AI usage summary: ${usageLabel(item.instance.displayName, item.usage, now)}, plus ${summaryCount} other AI apps` : usageLabel(item.instance.displayName, item.usage, now);
  const hide = () => { clearTimeout(timer.current); setTooltip(false); };
  const pill = view.tone === "exhausted" ? view.resetsAt ? `Out until ${refreshTime(view.resetsAt, now)}` : "Out of usage" : view.tone === "critical" ? `${Math.round(view.percent!)}% left` : summaryCount !== undefined ? view.tone === "low" ? `${Math.round(view.percent!)}%` : summaryCount > 0 ? `+${summaryCount}` : undefined : undefined;
  return <span className="relative">
    <button type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={expanded} aria-describedby={tooltip && !expanded ? id : undefined}
      onMouseEnter={() => { timer.current = setTimeout(() => setTooltip(true), 120); }} onMouseLeave={hide} onFocus={() => setTooltip(true)} onBlur={hide} onClick={() => { hide(); onOpen(); }}
      className={`relative flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-1 text-[11px] hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${view.tone === "exhausted" || view.tone === "critical" ? "border border-danger/30 bg-danger/10 pr-2 text-danger" : "text-ink"}`}>
      <UsageRingGraphic driverKind={item.instance.driverKind} {...view} />{pill && <span>{pill}</span>}
    </button>
    {tooltip && !expanded && <UsageTooltip id={id} text={label.replaceAll("percent", "%")} />}
  </span>;
}

export function UsageRings() {
  const { state } = useStore();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const close = (restoreFocus = false) => { setOpen(null); if (restoreFocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const blur = () => setOpen(null);
    document.addEventListener("mousedown", outside); window.addEventListener("blur", blur);
    return () => { document.removeEventListener("mousedown", outside); window.removeEventListener("blur", blur); };
  }, [open]);
  const preferences = state.config?.usageDisplay;
  const items: UsageItem[] = state.instances.flatMap(instance => {
    if (preferences?.hiddenInstances.includes(instance.instanceId)) return [];
    const bots = state.bots.filter(bot => !bot.hidden && [bot.modelSelection.instanceId, bot.backupModelSelection?.instanceId].includes(instance.instanceId));
    return bots.length ? [{ instance, bots, usage: state.usage.find(usage => usage.instanceId === instance.instanceId) }] : [];
  });
  const urgent = urgentUsage(items, now);
  if (preferences?.show === false || !urgent) return null;
  const show = (id: string) => { trigger.current = document.activeElement as HTMLElement; setNow(Date.now()); setOpen(open === id ? null : id); };
  const selected = open === "all" ? items : items.filter(item => item.instance.instanceId === open);
  return <div ref={root} className="relative flex shrink-0 items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
    <div className="hidden items-center gap-1 rounded-full border border-hairline/40 bg-panel/70 px-1 py-0.5 min-[900px]:flex" aria-label="AI usage left">
      {items.map(item => <RingButton key={item.instance.instanceId} item={item} now={now} expanded={open === item.instance.instanceId} onOpen={() => show(item.instance.instanceId)} />)}
    </div>
    <div className="flex rounded-full border border-hairline/40 bg-panel/70 px-1 py-0.5 min-[900px]:hidden"><RingButton item={urgent} now={now} summaryCount={items.length - 1} expanded={open === "all"} onOpen={() => show("all")} /></div>
    <span className="h-4 w-px bg-hairline/50" aria-hidden="true" />
    {open && selected.length > 0 && <UsagePopover items={selected} now={now} onClose={close} />}
  </div>;
}
