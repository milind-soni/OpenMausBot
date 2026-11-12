import { ProjectMentionTextarea } from "./ProjectMentionTextarea";
import { useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { localInstant, nextScheduleRun } from "../../server/schedule-time";
import type { Schedule, ScheduleRepeat, ScheduleTarget } from "../../server/schedule-types";

function dateFields(at: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function ScheduleSheet({ target, schedule, prompt: initialPrompt = "", onClose, onSaved }: { target?: ScheduleTarget; schedule?: Schedule; prompt?: string; onClose: () => void; onSaved?: () => void }) {
  const { state } = useStore();
  const zone = schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timezone, setTimezone] = useState(zone);
  const initial = schedule?.target ?? target ?? { botId: state.bots.find(b => !b.hidden)?.id ?? "" };
  const [targetValue, setTargetValue] = useState(initial.botId ? `bot:${initial.botId}` : `room:${initial.groupId}`);
  const [prompt, setPrompt] = useState(schedule?.prompt ?? initialPrompt);
  const [kind, setKind] = useState<ScheduleRepeat["kind"]>(schedule?.repeat.kind ?? "once");
  const fields = dateFields(schedule?.repeat.kind === "once" ? Date.parse(schedule.repeat.at) : Date.now() + 3600_000, zone);
  const [date, setDate] = useState(fields.date);
  const [time, setTime] = useState(schedule && "time" in schedule.repeat ? schedule.repeat.time : fields.time);
  const [days, setDays] = useState(schedule?.repeat.kind === "weekly" ? schedule.repeat.days : [1]);
  const [hours, setHours] = useState(schedule?.repeat.kind === "every" ? schedule.repeat.hours : 4);
  const [grace, setGrace] = useState(schedule?.graceMinutes ?? 120);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLElement>("select")?.focus();
    return () => trigger?.focus();
  }, []);
  const repeat = (): ScheduleRepeat => kind === "once" ? { kind, at: localInstant(date, time, timezone) } : kind === "every" ? { kind, hours } : kind === "weekly" ? { kind, time, days } : { kind, time };
  let preview = "Choose when this should run.";
  try { const next = nextScheduleRun(repeat(), timezone, Date.now()); preview = next ? `Next run: ${new Date(next).toLocaleString(undefined, { timeZone: timezone })} (${timezone}).` : "Choose a future run time."; } catch { /* fields are still being edited */ }
  const save = async () => {
    setPending(true); setError("");
    try {
      const [type, id] = targetValue.split(":");
      await api(schedule ? `/api/schedules/${schedule.id}` : "/api/schedules", { method: schedule ? "PATCH" : "POST", body: JSON.stringify({ target: type === "bot" ? { botId: id } : { groupId: id }, prompt, repeat: repeat(), timezone, graceMinutes: grace, enabled: schedule?.enabled ?? true }) });
      onSaved?.(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this schedule."); }
    finally { setPending(false); }
  };
  const field = "w-full rounded-xl border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none";
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !pending) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="schedule-sheet-title" className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-hairline/50 bg-card p-5 shadow-2xl" onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); if (!pending) onClose(); }
      if (e.key === "Tab") { const fields = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select') ?? [])]; const first = fields[0], last = fields.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }}>
      <h2 id="schedule-sheet-title" className="mb-4 text-[17px] font-semibold text-ink">{schedule ? "Edit schedule" : "New schedule"}</h2>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="block text-[13px] text-ink">Who should work on this?<select className={field} value={targetValue} onChange={e => setTargetValue(e.target.value)}><optgroup label="Bots">{state.bots.filter(b => !b.hidden).map(b => <option key={b.id} value={`bot:${b.id}`}>{b.name}</option>)}</optgroup><optgroup label="Rooms">{state.groups.map(g => <option key={g.id} value={`room:${g.id}`}>{g.name}</option>)}</optgroup></select></label>
        <label className="block text-[13px] text-ink">What should they do?<ProjectMentionTextarea required maxLength={30000} rows={4} className={field} value={prompt} onValueChange={setPrompt} placeholder="Write the message the bot should receive — use # for projects and @ for bots" /></label>
        <p className="text-[12px] text-ink-secondary">For rooms, mention the bots that should reply.</p>
        <label className="block text-[13px] text-ink">When should it run?<select className={field} value={kind} onChange={e => setKind(e.target.value as ScheduleRepeat["kind"])}>{[["once", "One time"], ["daily", "Every day"], ["weekdays", "Monday to Friday (Weekdays)"], ["weekly", "Every week"], ["every", "Every few hours"]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        {kind === "once" && <><button type="button" className="rounded-lg bg-raised px-3 py-1 text-[12px] text-ink" onClick={() => { const fields = dateFields(Date.now() + 3600_000, timezone); setDate(fields.date); setTime(fields.time); }}>In 1 hour</button><label className="block text-[13px] text-ink">Date<input required type="date" className={field} value={date} onChange={e => setDate(e.target.value)} /></label></>}
        {kind === "weekly" && <fieldset className="flex flex-wrap gap-2"><legend className="text-[13px] text-ink">On these days</legend>{[1, 2, 3, 4, 5, 6, 0].map(d => <label key={d} className="text-[12px] text-ink"><input type="checkbox" checked={days.includes(d)} onChange={() => setDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d])} />{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}</label>)}</fieldset>}
        {kind === "every" ? <label className="block text-[13px] text-ink">Run every (hours)<input type="number" required min={1} max={168} className={field} value={hours} onChange={e => setHours(Number(e.target.value))} /></label> : <label className="block text-[13px] text-ink">Time<input required type="time" className={field} value={time} onChange={e => setTime(e.target.value)} /></label>}
        <label className="block text-[13px] text-ink">Timezone<input required className={field} value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
        <details className="text-[12px] text-ink-secondary"><summary>Catch-up window</summary><label>Start missed work within (minutes)<input type="number" min={0} max={1440} className={field} value={grace} onChange={e => setGrace(Number(e.target.value))} /></label></details>
        <p className="rounded-xl bg-panel p-3 text-[12px] text-ink-secondary">{preview}</p>
        <p className="text-[12px] text-ink-secondary">Schedules run while Gerer Build Studio is open. If the app is closed or your computer is asleep, a missed task starts once when you return within its catch-up window.</p>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" disabled={pending} onClick={onClose} className="rounded-xl bg-raised px-4 py-2 text-[13px] text-ink">Cancel</button><button type="submit" disabled={pending || !prompt.trim()} className="rounded-xl bg-accent px-4 py-2 text-[13px] text-white disabled:opacity-40">{pending ? "Saving…" : schedule ? "Save changes" : "Schedule run"}</button></div>
      </form>
    </div>
  </div>;
}
