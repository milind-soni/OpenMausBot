import { useEffect, useRef, useState } from "react";
import type { UpdateEverythingState } from "@/types/ogb";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { Card } from "./SettingsPrimitives";

export function UpdateEverything() {
  const bridge = window.ogb?.updateEverything;
  const [state, setState] = useState<UpdateEverythingState>({ phase: "idle", rows: [] });
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const [working, setWorking] = useState(false);
  const accept = (next: UpdateEverythingState) => setState(old => (next.revision ?? 0) >= (old.revision ?? 0) ? next : old);
  useEffect(() => {
    if (!bridge) return;
    mounted.current = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try { const next = await bridge.state(); if (mounted.current) accept(next); }
      catch { /* Keep the last progress while the app restarts. */ }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [bridge]);
  if (!bridge) return null;
  const busy = working || state.phase === "checking" || state.phase === "running";
  const act = async (run: boolean) => {
    if (pending.current) return;
    pending.current = true; setWorking(true); setError(""); setConfirm(false);
    try {
      const next = run && state.planId ? await bridge.run(state.planId) : await bridge.check();
      if (mounted.current) accept(next);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : t("updatesAll.failed")); }
    finally { pending.current = false; if (mounted.current) setWorking(false); }
  };
  return <Card title={t("updatesAll.title")} subtitle={t("updatesAll.description")}>
    <div className="space-y-3 text-sm">
      <p className="text-ink-secondary">{t("updatesAll.safety")}</p>
      <ul className="space-y-2" aria-live="polite">
        {state.rows.map(row => <li key={row.id} className="rounded-xl bg-control p-3 break-words">
          <strong>{row.name}</strong><span className="ms-2 text-ink-secondary">{row.status}</span>
          {row.app && <div>{t("updatesAll.appVersion", { version: row.app })}</div>}
          {row.providers.length > 0 && <div>{row.providers.join(", ")}</div>}
          {row.note && <p className="text-ink-secondary">{row.note}</p>}
        </li>)}
      </ul>
      {(error || state.error) && <p role="alert" className="text-danger">{error || state.error}</p>}
      {state.phase === "complete" && <p role="status">{t("updatesAll.complete")}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="ui-button" disabled={busy} onClick={() => void act(false)}>{busy ? t("updatesAll.working") : t("updatesAll.check")}</button>
        {state.phase === "ready" && state.rows.some(row => row.status === "ready") &&
          <button className="ui-button" disabled={busy} onClick={() => setConfirm(true)}>{t("updatesAll.title")}</button>}
      </div>
    </div>
    <ConfirmDialog open={confirm} title={t("updatesAll.title")} body={t("updatesAll.confirm")} confirmLabel={t("updatesAll.title")} tone="neutral" onCancel={() => setConfirm(false)} onConfirm={() => void act(true)} />
  </Card>;
}
