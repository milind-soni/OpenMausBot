import { ProviderMark } from "./ProviderIcons";
import { RING_CIRCUMFERENCE, ringOffset, type UsageTone } from "@/lib/usage";

export const usageColor = (tone: UsageTone) => `var(--color-${tone === "unknown" ? "ink-secondary" : tone === "ok" ? "success" : tone === "low" ? "warning" : "danger"})`;
export function UsageRingGraphic({ driverKind, percent, tone }: { driverKind: string; percent: number | null; tone: UsageTone }) {
  const unknown = tone === "unknown";
  return <span className="relative inline-flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
    <svg width="20" height="20" viewBox="0 0 20 20" className="absolute inset-0">
      <circle cx="10" cy="10" r="8" fill="none" stroke={unknown ? usageColor(tone) : "var(--color-raised)"} strokeOpacity={unknown ? .55 : 1} strokeWidth="2" strokeDasharray={unknown ? "2.5 2.5" : undefined} />
      {!unknown && <circle cx="10" cy="10" r="8" fill="none" stroke={usageColor(tone)} strokeWidth="2" strokeLinecap="round" strokeOpacity={tone === "exhausted" ? .35 : 1}
        strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={tone === "exhausted" ? 0 : ringOffset(percent)} className="origin-center -rotate-90 transition-[stroke-dashoffset,stroke] duration-300 motion-reduce:transition-none" />}
    </svg>
    <ProviderMark driverKind={driverKind} size={10} />
    {tone === "low" && <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-warning" />}
    {(tone === "critical" || tone === "exhausted") && <span className="absolute -bottom-1 -right-1 flex size-2.5 items-center justify-center rounded-full bg-danger text-[8px] font-bold text-white">!</span>}
    {unknown && <span className="absolute -bottom-1 -right-1 rounded-full bg-panel text-[8px] text-ink-secondary">?</span>}
  </span>;
}
