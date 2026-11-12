import { useState } from "react";
import { api, useStore } from "@/state/store";
import type { UsagePreferences } from "../../server/usage-types";
import { ProviderMark } from "./ProviderIcons";

export function UsageSettings() {
  const { state, dispatch } = useStore();
  const prefs = state.config?.usageDisplay ?? { show: true, hiddenInstances: [] };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = async (usageDisplay: UsagePreferences) => {
    setPending(true); setError("");
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ usageDisplay }) });
      dispatch({ type: "configStatus", config });
    } catch { setError("Couldn’t save your display choice. Try again."); }
    finally { setPending(false); }
  };
  const toggle = (label: string, checked: boolean, action: () => void) => <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={pending || !state.config} onClick={action}
    className={`relative h-6 w-11 shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${checked ? "bg-accent" : "bg-raised"}`}>
    <span className={`absolute left-1 top-1 size-4 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : ""}`} />
  </button>;
  return <section className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm" aria-label="Usage display settings">
    <div className="flex items-center justify-between gap-4"><div><h3 className="text-[16px] font-semibold text-ink">Show usage in the top bar</h3><p className="mt-1 text-[13px] text-ink-secondary">Display small rings showing how much usage is left on each AI app.</p></div>{toggle("Show usage in the top bar", prefs.show, () => void save({ ...prefs, show: !prefs.show }))}</div>
    {prefs.show && <div className="mt-4 divide-y divide-hairline/40 rounded-xl border border-hairline/40 bg-panel/60 px-4">{state.instances.map(instance => {
      const shown = !prefs.hiddenInstances.includes(instance.instanceId);
      return <div key={instance.instanceId} className="flex items-center justify-between gap-3 py-2.5"><span className="flex items-center gap-2 text-[13px] text-ink"><ProviderMark driverKind={instance.driverKind} size={16} />{instance.displayName}</span>{toggle(`Show ${instance.displayName} usage in the top bar`, shown, () => void save({ ...prefs, hiddenInstances: shown ? [...prefs.hiddenInstances, instance.instanceId] : prefs.hiddenInstances.filter(id => id !== instance.instanceId) }))}</div>;
    })}</div>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
  </section>;
}
