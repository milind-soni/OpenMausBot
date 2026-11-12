import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import guide from "../../docs/guide/usage-and-limits.md?raw";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import type { EngineUsage } from "../../server/usage-types";
import { freshPercent, usageView, refreshTime } from "@/lib/usage";
import { ProviderMark } from "./ProviderIcons";
import { MausAvatar } from "./Avatar";
import { usageColor } from "./UsageRingGraphic";

export interface UsageItem { instance: InstanceInfo; usage?: EngineUsage; bots: Bot[] }
export function UsagePopover({ items, now, onClose }: { items: UsageItem[]; now: number; onClose: (restoreFocus?: boolean) => void }) {
  const { state, dispatch } = useStore();
  const panel = useRef<HTMLDivElement>(null);
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => { panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  const openSettings = () => {
    const bots = items.flatMap(item => item.bots);
    const bot = bots.find(bot => bot.id === state.selectedId) ?? bots[0];
    onClose();
    if (bot) {
      dispatch({ type: "select", id: bot.id });
      dispatch({ type: "toggleSettings", open: true, focusBackup: true });
    }
  };
  return <div ref={panel} role="dialog" aria-label={items.length === 1 ? `${items[0].instance.displayName} usage details` : "AI usage details"}
    className="absolute right-0 top-full z-50 mt-2 max-h-[75vh] w-[320px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-hairline/50 bg-card p-4 text-left shadow-2xl"
    onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(true); }
      if (event.key === "Tab") {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary') ?? [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <div className="mb-2 flex items-center justify-between"><span className="text-[14px] font-semibold text-ink">Usage left</span><button type="button" onClick={() => onClose(true)} className="rounded-lg px-2 py-1 text-[12px] text-ink-secondary focus-visible:ring-2 focus-visible:ring-accent">Close</button></div>
    {items.map(({ instance, usage, bots }, index) => {
      const view = usageView(usage, now);
      const status = view.tone === "unknown" ? "Not reported" : view.tone === "exhausted" ? view.resetsAt ? `Out until ${refreshTime(view.resetsAt, now)}` : "Out of usage" : `${view.tone === "critical" ? "Almost out · " : view.tone === "low" ? "Low · " : ""}${Math.round(view.percent!)}% left`;
      const details = <>
        <div className="py-3 text-[11px] text-ink-secondary">{usage?.updatedAt ? `Updated ${Math.max(0, Math.floor((now - Date.parse(usage.updatedAt)) / 60_000)) === 0 ? "just now" : `${Math.max(0, Math.floor((now - Date.parse(usage.updatedAt)) / 60_000))} min ago`}` : "No reading yet"}</div>
        {usage?.windows.length ? <div className="space-y-3 border-b border-hairline/40 pb-3">{usage.windows.map(w => {
          const percent = freshPercent(usage, w, now);
          return <div key={w.id}>
            <div className="flex justify-between gap-2 text-[12px] text-ink"><span>{w.label}</span><span>{percent === null ? "Not reported" : `${Math.round(percent)}% left`}</span></div>
            {percent !== null && <div role="progressbar" aria-label={`${instance.displayName} ${w.label} usage left`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full" style={{ width: `${percent}%`, background: usageColor(percent === 0 ? "exhausted" : percent < 15 ? "critical" : percent <= 40 ? "low" : "ok") }} /></div>}
            {w.resetsAt && Date.parse(w.resetsAt) > now && <p className="mt-1 text-[11px] text-ink-secondary">Refreshes at {refreshTime(w.resetsAt, now)}</p>}
          </div>;
        })}</div> : <p className="rounded-xl border border-hairline/40 bg-panel/70 p-3 text-[12px] text-ink-secondary">{view.tone === "exhausted" ? "This AI app reported that its usage ran out. A refresh time was not reported." : "This AI app hasn’t reported how much usage is left. You can check your account in that app."}</p>}
        <div className="border-b border-hairline/40 py-3"><p className="text-[11px] text-ink-secondary">Bots using {instance.displayName}</p><div className="mt-1.5 flex flex-wrap gap-2">{bots.map(bot => <span key={bot.id} className="flex items-center gap-1 text-[12px] text-ink"><MausAvatar size={16} color={bot.color} />{bot.name}{bot.backupModelSelection && <span className="text-success">(Backup set)</span>}</span>)}</div></div>
      </>;
      const header = <span className="flex w-full items-center justify-between gap-2 py-2 text-[13px] text-ink"><span className="flex items-center gap-2"><ProviderMark driverKind={instance.driverKind} size={18} />{instance.displayName}</span><span className="text-[11px]" style={{ color: usageColor(view.tone) }}>{status}</span></span>;
      return items.length > 1 ? <details key={instance.instanceId} open={index === 0}><summary className="cursor-pointer list-none rounded-lg focus-visible:ring-2 focus-visible:ring-accent">{header}</summary>{details}</details> : <section key={instance.instanceId}>{header}{details}</section>;
    })}
    <div className="space-y-1 pt-3">
      <button type="button" onClick={openSettings} className="w-full rounded-xl bg-raised px-3 py-2 text-left text-[13px] text-ink hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-accent">Set a backup model…</button>
      <button type="button" aria-expanded={showGuide} onClick={() => setShowGuide(!showGuide)} className="w-full rounded-xl px-3 py-2 text-left text-[12px] text-ink-secondary hover:bg-raised/50 focus-visible:ring-2 focus-visible:ring-accent">What do these mean?</button>
      {showGuide && <div className="space-y-2 rounded-xl bg-panel p-3 text-[12px] leading-relaxed text-ink-secondary"><ReactMarkdown>{guide}</ReactMarkdown></div>}
    </div>
  </div>;
}
