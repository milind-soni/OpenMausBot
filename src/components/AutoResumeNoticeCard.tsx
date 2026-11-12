import { useState } from "react";
import { api, useStore } from "@/state/store";
export function AutoResumeNoticeCard({ threadId }: { threadId: string }) {
  const { state } = useStore();
  const [status, setStatus] = useState("");
  const [error, setError] = useState(""), [pending, setPending] = useState(false);
  const schedules = state.schedules.schedules.filter(s => s.origin === "auto-resume" && s.resume?.threadId === threadId && (s.enabled || state.schedules.deliveries.some(j => j.scheduleId === s.id)));
  const act = async (id: string, run: boolean) => { setPending(true); try { await api(`/api/schedules/${id}${run ? "/run-now" : ""}`, { method: run ? "POST" : "DELETE" }); setStatus(run ? "The retry will start when the bot is free." : "Automatic resume cancelled."); } catch { setError("Couldn’t update this retry. Try again."); } finally { setPending(false); } };
  return <>{schedules.map(s => <div key={s.id} role="status" className="mx-4 my-2 max-w-[520px] rounded-xl border border-warning/30 bg-warning/10 p-4 text-[13px] text-ink"><p className="font-medium">Usage ran out. {state.schedules.paused ? "Automatic retries are paused." : s.enabled ? `I’ll check back at ${new Date(s.nextRunAt!).toLocaleString()}.` : "The retry is queued behind the active task."}</p><p className="mt-1 text-[12px] text-ink-secondary">Your request is saved. A new attempt will check whether work can continue.</p><div className="mt-3 flex gap-2"><button disabled={pending} onClick={() => void act(s.id, false)} className="rounded-lg bg-panel px-3 py-1.5">Cancel</button><button disabled={pending} onClick={() => void act(s.id, true)} className="rounded-lg bg-accent px-3 py-1.5 text-white">Resume now</button></div></div>)}{status && <p role="status" className="mx-4 text-[12px] text-ink-secondary">{status}</p>}{error && <p role="alert" className="text-danger">{error}</p>}</>;
}
