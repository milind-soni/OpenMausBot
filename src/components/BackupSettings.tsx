import { useEffect, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
export function BackupSettings({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const root = useRef<HTMLElement>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const working = bot.busy || state.groups.some(g => g.busyBotId === bot.id);
  useEffect(() => { if (state.settingsFocus === "backup") { root.current?.scrollIntoView({ block: "center" }); root.current?.querySelector("select")?.focus(); } }, [state.settingsFocus, bot.id]);
  const save = async (patch: Record<string, unknown>) => {
    setPending(true); setError("");
    try { const { bot: saved } = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(patch) }); dispatch({ type: "botPatched", bot: saved }); }
    catch { setError("Couldn’t save this choice. Wait for the bot to finish and try again."); }
    finally { setPending(false); }
  };
  const selection = bot.backupModelSelection ? JSON.stringify([bot.backupModelSelection.instanceId, bot.backupModelSelection.model]) : "";
  return <section ref={root} id="backup-model-settings" className="space-y-3 rounded-xl bg-card p-4">
    <label className="block text-[15px] font-medium text-ink">Backup model<select disabled={pending || working} value={selection} onChange={e => { const value = e.target.value ? JSON.parse(e.target.value) as [string, string] : null; const instance = state.instances.find(i => i.instanceId === value?.[0]); void save({ backupModelSelection: value ? { instanceId: value[0], model: value[1], label: instance?.models.options.find(m => m.id === value[1])?.label } : null, onUsageLimit: value ? "backup" : "wait" }); }} className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset p-2 text-[13px] text-ink disabled:opacity-50"><option value="">No backup set</option>{state.instances.filter(i => i.instanceId !== bot.modelSelection.instanceId).map(i => <optgroup key={i.instanceId} label={i.displayName}>{i.models.options.map(m => <option key={m.id} value={JSON.stringify([i.instanceId, m.id])} disabled={i.snapshot.state !== "available"}>{m.label}</option>)}</optgroup>)}</select></label>
    <p className="text-[12px] text-ink-secondary">An alternate AI model to use if your main model runs out of usage. Choose a different AI app so the two are less likely to run out together.</p>
    <fieldset disabled={pending || working} className="space-y-2"><legend className="mb-2 text-[14px] font-medium text-ink">When usage runs out</legend>{[["backup", "Switch to backup model", "Continue the failed task on your backup. If it is unavailable, wait and try again."], ["wait", "Wait and continue", "Save the request and try again when usage may be available."], ["stop", "Stop and tell me", "Pause work so you can decide what to do."]].map(([value, title, help]) => <label key={value} className="flex items-start gap-2 text-[13px] text-ink"><input type="radio" name={`usage-${bot.id}`} checked={(bot.onUsageLimit ?? "stop") === value} disabled={value === "backup" && !bot.backupModelSelection} onChange={() => void save({ onUsageLimit: value })} /><span>{title}<span className="block text-[11px] text-ink-secondary">{help}</span></span></label>)}</fieldset>
    {working && <p className="text-[12px] text-ink-secondary">Wait for this bot to finish before changing its AI model.</p>}{error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </section>;
}
