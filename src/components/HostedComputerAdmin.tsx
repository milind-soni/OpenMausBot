import { useState } from "react";
import { api } from "@/lib/api-client";
import { Card } from "./SettingsPrimitives";
import { hostedComputersStatus, type HostedComputersStatus, type HostedProvider } from "../../shared/hosted-computers";

const inputClass = "mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-sm text-ink";
export function HostedComputerAdmin({ initial }: { initial?: HostedComputersStatus }) {
  const [status, setStatus] = useState(() => initial ?? hostedComputersStatus());
  const [provider, setProvider] = useState<HostedProvider>(status.defaultProvider);
  const [orgoKey, setOrgoKey] = useState("");
  const [daytonaKey, setDaytonaKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState(status.orgo.workspaceId);
  const [snapshot, setSnapshot] = useState(status.daytona.snapshot);
  const [orgoEnabled, setOrgoEnabled] = useState(status.orgo.enabled);
  const [daytonaEnabled, setDaytonaEnabled] = useState(status.daytona.enabled);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNotice(""); setError("");
    try {
      const result = await api<{ hostedComputers: HostedComputersStatus }>("/api/config", { method: "PUT", body: JSON.stringify({ hostedComputers: {
        defaultProvider: provider,
        orgo: { enabled: orgoEnabled, workspaceId: workspaceId.trim(), ...(orgoKey.trim() ? { apiKey: orgoKey.trim() } : {}) },
        daytona: { enabled: daytonaEnabled, snapshot: snapshot.trim(), ...(daytonaKey.trim() ? { apiKey: daytonaKey.trim() } : {}) },
      } }) });
      setStatus(result.hostedComputers); setOrgoKey(""); setDaytonaKey("");
      setNotice("Settings saved. Existing agents keep their computers. Restart idle member workspaces to apply the new configuration.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Provider settings could not be saved."); }
    finally { setBusy(false); }
  }
  return <Card title="Additional cloud computers" subtitle="NATION manages provider accounts. Members use their assigned computer without entering keys.">
    <form onSubmit={save} className="space-y-5">
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-hairline/40 p-4">
        <legend className="px-1 font-medium">Orgo · persistent desktops</legend>
        <p className="text-xs text-ink-secondary">For websites and desktop apps. {status.orgo.configured ? "Credentials saved." : "Setup required."}</p>
        <label className="block text-sm" htmlFor="orgo-key">Orgo API key<input id="orgo-key" type="password" autoComplete="new-password" value={orgoKey} onChange={e => setOrgoKey(e.target.value)} placeholder={status.orgo.configured ? "Leave blank to keep the saved key" : "Enter API key"} className={inputClass} /></label>
        <label className="block text-sm" htmlFor="orgo-workspace">Orgo workspace ID<input id="orgo-workspace" value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} className={inputClass} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={orgoEnabled} onChange={e => setOrgoEnabled(e.target.checked)} />Enable Orgo</label>
      </fieldset>
      <fieldset disabled={busy} className="space-y-3 rounded-xl border border-hairline/40 p-4">
        <legend className="px-1 font-medium">Daytona · development computers</legend>
        <p className="text-xs text-ink-secondary">For repositories, code execution, builds, tests and desktop work. {status.daytona.configured ? "Credentials saved." : "Setup required."}</p>
        <label className="block text-sm" htmlFor="daytona-key">Daytona API key<input id="daytona-key" type="password" autoComplete="new-password" value={daytonaKey} onChange={e => setDaytonaKey(e.target.value)} placeholder={status.daytona.configured ? "Leave blank to keep the saved key" : "Enter API key"} className={inputClass} /></label>
        <label className="block text-sm" htmlFor="daytona-snapshot">Desktop-enabled snapshot<input id="daytona-snapshot" value={snapshot} onChange={e => setSnapshot(e.target.value)} placeholder="Snapshot name from your Daytona account" className={inputClass} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={daytonaEnabled} onChange={e => setDaytonaEnabled(e.target.checked)} />Enable Daytona</label>
      </fieldset>
      <label className="block text-sm" htmlFor="computer-default-provider">Default for new agents
        <select id="computer-default-provider" disabled={busy} value={provider} onChange={e => setProvider(e.target.value as HostedProvider)} className={inputClass}>
          <option value="box">ASCII Box</option><option value="orgo" disabled={!orgoEnabled}>Orgo</option><option value="daytona" disabled={!daytonaEnabled}>Daytona</option>
        </select>
      </label>
      <p className="text-xs text-ink-secondary">Saving checks enabled providers without creating a computer. Starting a computer uses your provider plan. Files stay when computers sleep; machine usage is not yet charged to member credits.</p>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-success">{notice}</p> : null}
      <button type="submit" disabled={busy} className="ui-button disabled:opacity-50">{busy ? "Checking providers…" : "Check and save providers"}</button>
    </form>
  </Card>;
}
