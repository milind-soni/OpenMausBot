import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, Timer, X } from "lucide-react";
import { api, type Group } from "@/state/store";
import { normalizeMeetingLimits } from "../../shared/meeting-limits";

const rows = [
  { key: "replies", label: "Replies", wrap: "wrapUpAfter", hard: "hardStop", defaults: [16, 22], step: "1",
    help: "Counts public bot replies. Dynamic mode also uses private participation checks, which decide who speaks next; those are not public replies." },
  { key: "tokens", label: "Tokens", wrap: "wrapUpAt", hard: "hardStop", defaults: [70000, 100000], step: "1",
    help: "Counts all input and output, including cached input and private checks. Stops when provider usage arrives; a running request can exceed the allowance." },
  { key: "time", label: "Time (minutes)", wrap: "wrapUpSeconds", hard: "seconds", defaults: [210, 300], step: "0.1",
    help: "Starts when the discussion begins. The remaining time is supplied before each turn. At the deadline, the app interrupts the current turn." },
  { key: "cost", label: "Budget (USD)", wrap: "wrapUpUsd", hard: "hardStopUsd", defaults: [0.35, 0.5], step: "0.01",
    help: "Estimates all reported token usage at OpenRouter model rates, including cache discounts. An in-flight request can cross the cap before usage arrives." },
] as const;

function Help({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState<false | "hover" | "pinned">(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const place = () => {
    const rect = button.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)), top: Math.min(rect.bottom + 4, window.innerHeight - 170) });
  };
  return <span className="relative inline-flex" onMouseEnter={() => { place(); setOpen(value => value || "hover"); }} onMouseLeave={() => setOpen(value => value === "hover" ? false : value)}>
    <button ref={button} type="button" aria-label={`About ${label}`} aria-expanded={Boolean(open)} aria-controls={id}
      onClick={() => { place(); setOpen(value => value === "pinned" ? false : "pinned"); }} onBlur={() => setOpen(false)}
      className="rounded p-1 text-ink-secondary hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"><CircleHelp size={14} /></button>
    {open && createPortal(<span id={id} role="tooltip" style={position} className="fixed z-[60] w-64 rounded-lg border border-hairline bg-panel p-3 text-xs font-normal leading-relaxed text-ink shadow-xl">{text}</span>, document.body)}
  </span>;
}

export function MeetingLimitsButton({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label="Meeting limits" title="Meeting limits" onClick={() => setOpen(true)}
      className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink"><Timer size={17} /></button>
    {open && <MeetingLimitsDialog key={group.id} group={group} onClose={() => setOpen(false)} />}
  </>;
}

export function MeetingLimitsDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const initial = normalizeMeetingLimits(group.meetingLimits);
  const [enabled, setEnabled] = useState(() => new Set(Object.keys(initial)));
  const [values, setValues] = useState<Record<string, [string, string]>>(() => Object.fromEntries(rows.map(row => {
    const saved = initial[row.key] as unknown as Record<string, number> | undefined;
    const scale = row.key === "time" ? 60 : 1;
    return [row.key, [(saved?.[row.wrap] ?? row.defaults[0]) / scale, (saved?.[row.hard] ?? row.defaults[1]) / scale].map(String) as [string, string]];
  })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const title = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    return () => previous?.focus();
  }, []);
  const save = async () => {
    setError("");
    try {
      const raw = Object.fromEntries(rows.filter(row => enabled.has(row.key)).map(row => {
        const scale = row.key === "time" ? 60 : 1;
        const pair = values[row.key].map(value => value.trim() ? Number(value) * scale : NaN);
        return [row.key, { [row.wrap]: pair[0], [row.hard]: pair[1] }];
      }));
      const meetingLimits = normalizeMeetingLimits(raw);
      setSaving(true);
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ meetingLimits }) });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}
      className="flex h-[560px] max-h-[calc(100dvh-32px)] w-full max-w-lg flex-col rounded-2xl border border-hairline bg-panel p-6 shadow-2xl outline-none"
      onKeyDown={event => {
        if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const buttons = [...root.current!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="mb-7 flex items-center gap-2"><h2 id={title} className="text-lg font-semibold">Meeting limits</h2>
        <Help label="meeting limits" text="The first reached limit stops the meeting. A new user message starts a fresh allowance. Wrap-up reminders leave time to finish open work; the conversation may end earlier." />
        <button type="button" aria-label="Close meeting limits" disabled={saving} onClick={onClose} className="ml-auto rounded-md p-2 text-ink-secondary hover:bg-raised"><X size={18} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-2 grid grid-cols-[1.5fr_1fr_1fr] gap-3 text-xs text-ink-secondary"><span /><span>Wrap up after</span><span>Hard stop</span></div>
        {rows.map(row => <div key={row.key} className="grid grid-cols-[1.5fr_1fr_1fr] items-center gap-3 py-3">
          <span className="flex items-center gap-1"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled.has(row.key)} disabled={saving}
            onChange={event => setEnabled(current => { const next = new Set(current); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; })} />{row.label}</label><Help label={row.label} text={row.help} /></span>
          {([0, 1] as const).map(index => <input key={index} type="number" step={row.step} min="0" aria-label={`${row.label} ${index ? "hard stop" : "wrap up after"}`}
            value={values[row.key][index]} disabled={saving || !enabled.has(row.key)}
            onChange={event => setValues(current => ({ ...current, [row.key]: index ? [current[row.key][0], event.target.value] : [event.target.value, current[row.key][1]] }))}
            className="min-w-0 rounded-lg bg-raised p-2 text-sm tabular-nums disabled:opacity-35" />)}
        </div>)}
        <p role="alert" className="mt-3 text-sm text-danger">{error}</p>
      </div>
      <div className="mt-5 flex justify-end"><button type="button" disabled={saving || group.working} onClick={() => void save()}
        className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving…" : "Save"}</button></div>
    </div>
  </div>, document.body);
}
