/** Signal bars for issue priority: one, two or three filled bars. */
export function PriorityIcon({ priority }: { priority?: string }) {
  const level = priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;
  return <svg className={`priority-icon ${priority || ""}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{[0, 1, 2].map(bar => <rect key={bar} x={1 + bar * 4} y={8 - bar * 3} width="2.5" height={3 + bar * 3} rx="0.75" fill="currentColor" opacity={bar < level ? 1 : 0.28} />)}</svg>;
}

/** Workflow lane tone from a column title; drives lane and status colors. */
export function laneTone(title: string) {
  const normalized = title.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "draft" || normalized === "backlog") return "draft";
  if (normalized === "idea") return "idea";
  if (normalized === "todo") return "todo";
  if (normalized === "done") return "done";
  if (normalized === "inprogress" || normalized === "doing") return "progress";
  if (normalized === "inreview" || normalized === "review") return "review";
  return "custom";
}

/** How far along the workflow a lane tone is, drawn as the filled part of the status ring. */
const PROGRESS: Record<string, number> = { progress: 0.5, review: 0.75 };

/** Status ring tinted with the lane color: dashed for drafts, filling up as work progresses, a check when done. */
export function StatusIcon({ title }: { title: string }) {
  const tone = laneTone(title);
  const progress = PROGRESS[tone];
  return <svg className={`status-icon ${tone}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    {tone === "done"
      ? <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M4.4 7.2 6.2 9l3.4-3.6" fill="none" stroke="var(--surface-1, #0e0f11)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>
      : <>
        <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={tone === "draft" ? "2.2 2" : undefined} />
        {progress ? <path d={arc(progress)} fill="currentColor" /> : null}
      </>}
  </svg>;
}

/** Pie slice from 12 o'clock, clockwise, inside the ring. */
function arc(fraction: number) {
  const radius = 2.75;
  const angle = fraction * Math.PI * 2;
  const x = 7 + radius * Math.sin(angle);
  const y = 7 - radius * Math.cos(angle);
  return `M7 7 L7 ${7 - radius} A${radius} ${radius} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

/** Estimate: a small triangle, as in Linear; dashed when the issue has none. */
export function EstimateIcon({ empty = false }: { empty?: boolean }) {
  return <svg className="estimate-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.75 10.6 10H1.4Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeDasharray={empty ? "1.6 1.4" : undefined} />
  </svg>;
}
