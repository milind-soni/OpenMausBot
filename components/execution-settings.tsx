"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { Loader2, RefreshCw, Plus, Trash2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { ExecutionCloudProviderStatus, ExecutionEnrollment, ExecutionSnapshot } from "@/lib/execution-types";
import { useWorkspace } from "./workspace-context";
import { ConfirmButton, SettingSwitch } from "./settings-controls";
import { ExecutionPolicyEditor } from "./execution-policy-editor";
import { ExecutionRuns } from "./execution-runs";
import { executionTime, useExecution, type ExecutionAction, type ExecutionScope } from "./use-execution";

export function ExecutionSettings({ sessionToken, projectId, section = "accounts" }: { sessionToken: string; projectId?: string; section?: "accounts" | "machines" | "policy" }) {
  const workspace = useWorkspace();
  const scope = { teamId: workspace._id, projectId, sessionToken };
  const { data, error, busy, act, refresh } = useExecution(scope);
  return <div className="execution-panel">
    <div className="execution-card-head"><p className="execution-help">{projectId ? "Project automation and explicit secret access" : "Real coding accounts and supervised runners"}</p><button type="button" className="icon-button" aria-label="Refresh execution status" onClick={refresh}><RefreshCw size={14} /></button></div>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {!data ? <p className="execution-help" role="status">{error ? "Execution data is unavailable. Refresh to retry." : <><Loader2 size={14} className="spin" /> Loading execution settings…</>}</p> : <>
      {projectId ? <>
        <ExecutionPolicyEditor data={data} scope="project" busy={busy} act={act} />
        <AutomationEnvironments data={data} busy={busy} act={act} />
        <ExecutionRuns data={data} scope={scope} busy={busy} act={act} />
      </> : section === "accounts" ? <>
        <ExecutionAccounts data={data} busy={busy} act={act} />
        <ExecutionRuns data={data} scope={scope} busy={busy} act={act} />
      </> : section === "machines" ? <>
        <ExecutionMachines data={data} scope={scope} busy={busy} act={act} />
        <ExecutionUpdates data={data} busy={busy} act={act} />
      </> : <>
        <ExecutionPolicyEditor data={data} scope="workspace" busy={busy} act={act} />
        <section className="settings-group"><h4>Write-only cloud credentials</h4><p className="execution-help">Boxd and Boat are offline-only execution providers, not unconditional fallback. Keys are sealed server-side and never returned to this form. Provider choice affects new runs only.</p>
          {(["boxd", "boat"] as const).map(provider => <CloudProviderForm key={provider} provider={provider} status={data.cloudProviders.find(item => item.provider === provider)} disabled={!data.permissions.admin || busy} act={act} />)}
        </section>
      </>}
    </>}
  </div>;
}

function ExecutionAccounts({ data, busy, act }: { data: ExecutionSnapshot; busy: boolean; act: ExecutionAction }) {
  return <section className="settings-group"><div className="execution-card-head"><h4>Accounts & plan usage</h4><button type="button" className="ghost-button compact" disabled={busy || !data.permissions.write} onClick={() => { void act("refreshUsage").catch(() => {}); }}>Refresh usage</button></div>
    <p className="execution-help">Connect an account by signing in with its coding CLI on an enrolled machine. Credentials stay there. Only your authorized account metadata is shown; subscription windows are separate from task tokens and API estimates.</p>
    <p className="execution-help">Unknown billing never authorizes a run. Native subscription sign-in does not disable provider-side paid extras; disable those at the provider to avoid overage charges.</p>
    {!data.accounts.length && <p className="settings-empty">No accounts reported. Enroll a machine under Machines, then sign in locally with a supported CLI.</p>}
    {data.accounts.map(account => <article className="execution-card" key={account.id}>
      <div className="execution-card-head"><strong>{account.label}</strong><span className="execution-badge">{account.authenticated ? "Identity verified" : "Not ready: verify native login and identity"}</span></div>
      <p className="execution-help">{account.provider} · {account.authKind === "unknown" ? "Mixed or unverified billing" : account.authKind}{account.plan ? ` · ${account.plan}` : " · Plan not reported"}</p>
      <p className="execution-help">Machines: {account.hostIds.map(id => data.hosts.find(host => host.id === id)?.name ?? id).join(", ") || "Not reported"}</p>
      <p className="execution-help">Harnesses: {account.harnesses.join(", ") || "None reported"} · Models: {account.models?.map(model => model.id).join(", ") || "None reported"}</p>
      <details><summary>Native profiles & billing</summary>{Object.entries(account.bindings ?? {}).flatMap(([hostId, profiles]) => profiles.map(profile => <p className="execution-help" key={`${hostId}:${profile.accountId}`}>{data.hosts.find(host => host.id === hostId)?.name ?? hostId} · {profile.harnesses.join(", ")} · {profile.accountId} · {profile.authKind} · {profile.authenticated ? "Identity verified" : "Login or identity not verified"}</p>))}</details>
      <div className="execution-card-head"><span>Quota: {account.quota.status}</span><small>Observed {executionTime(account.quota.observedAt)}</small></div>
      {account.quota.error && <p className="notice danger">{account.quota.error}</p>}
      {!account.quota.windows.length && <p className="execution-help">No quota windows available. Unknown usage is not zero or confirmed exhaustion.</p>}
      {account.quota.windows.map(window => <div className="execution-quota" key={window.id}>
        <div className="execution-card-head"><strong>{window.label}{window.durationMinutes ? ` · ${window.durationMinutes} min` : ""}</strong><span>{window.usedPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% used</span></div>
        <progress max={100} value={Math.min(100, Math.max(0, window.usedPercent))} aria-label={`${window.label} quota used`} />
        <small>Reset: {window.resetsAt ? executionTime(window.resetsAt) : "Not reported"} · {account.quota.status === "available" ? "Reported usage" : "Not fresh confirmed usage"}</small>
      </div>)}
    </article>)}
    <p className="execution-help">T3 is a manual interactive frontend here, not an unattended coding adapter. No synthetic model catalog, quota or billing data is displayed.</p>
  </section>;
}

function ExecutionMachines({ data, scope, busy, act }: { data: ExecutionSnapshot; scope: ExecutionScope; busy: boolean; act: ExecutionAction }) {
  const workspace = useWorkspace();
  const projects = useQuery(api.projects.listForUser, { sessionToken: scope.sessionToken, teamId: workspace._id });
  const [name, setName] = useState("");
  const [tailnetName, setTailnetName] = useState("");
  const [kind, setKind] = useState<"nixos" | "mac">("nixos");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [enrollment, setEnrollment] = useState<ExecutionEnrollment | null>(null);
  return <section className="settings-group"><h4>Machines</h4>
    <p className="execution-help">NixOS is preferred for portable jobs. Mac runs only Apple workloads or explicit machine requests. Busy, paused or uncertain presence does not authorize cloud execution.</p>
    <p className="execution-help">Herdr and Rex independently view the same Origin task without replacing or duplicating its selected coding CLI. Enable locally with <code>origin-runner herdr enable</code> and <code>origin-runner rex enable</code>; add <code>--cloud</code> to either to connect active Boxd/Boat tasks using your native provider login. Rex requires the pinned preview and an explicitly started private Unix-socket server. Rex cloud aliases are CLI-only; add the private socket separately in the Mac GUI. Expired transports close automatically. Hermes controls authorized Origin runs only, never personal terminals or native server APIs.</p>
    {!data.hosts.length && <p className="settings-empty">No machines enrolled.</p>}
    {data.hosts.map(host => <article className="execution-card" key={host.id}>
      <div className="execution-card-head"><strong>{host.name}</strong><span className="execution-badge">{host.status}</span></div>
      <p className="execution-help">{host.kind} · {host.platform} · runner {host.version || "unknown"} · {host.activeRunIds.length}/{host.capacity} active</p>
      <p className="execution-help">Heartbeat: {executionTime(host.lastSeenAt)} · Independent presence: {host.online === null ? "Unknown" : host.online ? "Online" : "Offline"}{host.presenceObservedAt ? ` (${executionTime(host.presenceObservedAt)})` : ""}</p>
      <p className="execution-help">CLIs: {host.capabilities.join(", ") || "None reported"}. Accounts: {host.accountIds.map(id => data.accounts.find(account => account.id === id)?.label ?? "Other authorized account").join(", ") || "No authenticated account reported"}.</p>
      <p className="execution-help">Project scope: {host.projectIds.map(id => projects?.find(project => project._id === id)?.name ?? id).join(", ") || "No projects"}{host.platform === "darwin" ? " · Apple-only unless explicitly selected" : ""}</p>
      {host.herdr && <p className="execution-help">Herdr: {host.herdr.enabled ? host.herdr.status ?? "Not reported" : "Disabled"}{host.herdr.version ? ` · core ${host.herdr.version}` : ""} · Cloud connections {host.herdr.cloudConnections ? "enabled" : "disabled"} · Reported {executionTime(host.herdr.updatedAt)}{host.herdr.message ? ` · ${host.herdr.message}` : ""}</p>}
      {host.rex && <p className="execution-help">Rex: {host.rex.enabled ? host.rex.status ?? "Not reported" : "Disabled"}{host.rex.version ? ` · preview ${host.rex.version}` : ""} · Cloud connections {host.rex.cloudConnections ? "enabled" : "disabled"} · Reported {executionTime(host.rex.updatedAt)}{host.rex.message ? ` · ${host.rex.message}` : ""}</p>}
      {data.permissions.admin && !host.revoked && <div className="execution-actions">
        <button type="button" className="ghost-button compact" disabled={busy} onClick={() => { void act(host.paused ? "resumeHost" : "pauseHost", { hostId: host.id }).catch(() => {}); }}>{host.paused ? "Resume new work" : "Pause new work"}</button>
        <ConfirmButton label={`Revoke ${host.name}`} text="Revoke" confirmLabel="Confirm revoke" className="ghost-button compact danger" disabled={busy} onConfirm={() => { void act("revokeHost", { hostId: host.id }).catch(() => {}); }} />
      </div>}
    </article>)}
    {data.permissions.admin && <form className="settings-form execution-card" onSubmit={async event => {
      event.preventDefault(); setEnrollment(null);
      try { const result = await act("enrollHost", { name, kind, projectIds, ...(tailnetName.trim() ? { tailnetName: tailnetName.trim() } : {}) }) as ExecutionEnrollment; setEnrollment(result); setName(""); setTailnetName(""); } catch { /* Parent displays errors. */ }
    }}><h4>Enroll a machine</h4><fieldset disabled={busy}>
      <div className="execution-grid"><label>Machine name<input required value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label><label>Machine kind<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="nixos">NixOS</option><option value="mac">Mac</option></select></label></div>
      <label>Tailnet machine name (independent presence)<input value={tailnetName} maxLength={253} onChange={event => setTailnetName(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Machine name from your tailnet" /></label>
      <p className="execution-help">Use the exact tailnet name, not just the display name. Without independent offline confirmation, portable work queues instead of silently launching cloud compute.</p>
      <fieldset className="execution-checkbox-list"><legend>Approved projects · select explicitly</legend>{projects?.map(project => <label key={project._id}><input type="checkbox" checked={projectIds.includes(project._id)} onChange={event => setProjectIds(event.target.checked ? [...projectIds, project._id] : projectIds.filter(id => id !== project._id))} />{project.name}</label>)}</fieldset>
      <button className="primary-button compact" disabled={!projectIds.length}>Generate one-time enrollment</button>
    </fieldset></form>}
    {enrollment && <div className="execution-card settings-form"><h4>One-time enrollment</h4>
      <p className="notice">Run the command on the intended machine before {executionTime(enrollment.expiresAt)}. Paste the separate token only when the terminal asks for it; input is hidden. Never put the token in a command, chat, log or source file.</p>
      <label>Enrollment command<textarea aria-label="One-time enrollment command" readOnly rows={3} value={enrollment.command} onFocus={event => event.currentTarget.select()} autoComplete="off" spellCheck={false} /></label>
      <label>One-time token · shown only now<textarea aria-label="One-time enrollment token" readOnly rows={2} value={enrollment.enrollmentToken} onFocus={event => event.currentTarget.select()} autoComplete="off" spellCheck={false} /></label>
      <button type="button" className="ghost-button compact" onClick={() => setEnrollment(null)}>Dismiss secret</button>
    </div>}
  </section>;
}

function CloudProviderForm({ provider, status, disabled, act }: { provider: "boxd" | "boat"; status?: ExecutionCloudProviderStatus; disabled: boolean; act: ExecutionAction }) {
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  return <form className="settings-form execution-card" onSubmit={async event => {
    event.preventDefault(); setSaved(false);
    try { await act("saveCloudProvider", { provider, enabled: enabled ?? status?.enabled ?? false, ...(key ? { apiKey: key } : {}) }); setKey(""); setEnabled(null); setSaved(true); } catch { /* Parent displays errors. */ }
  }}><h4>{provider === "boxd" ? "Boxd" : "Boat"}</h4><p className="execution-help">Credential: {status?.keyConfigured ? "Configured (write-only)" : "Not configured"}</p>
    <fieldset disabled={disabled}><label>{status?.keyConfigured ? "Replace API key (leave blank to keep)" : "API key"}<input type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} /></label>
      {provider === "boxd" && <><p className="execution-help">Boxd organization: {status?.boxdBilling?.orgId ?? "Save the credential to verify its organization"}. Replacing the key clears billing evidence.</p>
        <p className="execution-help">Automatic top-up is managed in <a href="https://app.boxd.sh/" target="_blank" rel="noreferrer">Boxd Billing</a> and may charge your payment method. Origin does not inspect or change it. Fresh controller-native credit evidence is required before cloud work can start.</p></>}
      <SettingSwitch label="Enable provider" checked={enabled ?? status?.enabled ?? false} onChange={setEnabled} /><button className="ghost-button compact">Save provider</button></fieldset>
    {status && <p className="execution-help">Provider balance: {status.usage.status === "available" && status.usage.balance !== undefined ? `${status.usage.balance} ${status.usage.unit ?? ""}` : "Unknown / not provided"}{status.usage.observedAt ? ` · Observed ${executionTime(status.usage.observedAt)}` : ""}{status.usage.error ? ` · ${status.usage.error}` : ""}</p>}
    {saved && <p className="notice success" role="status">Provider saved. Secret cleared from the form.</p>}
  </form>;
}

function AutomationEnvironments({ data, busy, act }: { data: ExecutionSnapshot; busy: boolean; act: ExecutionAction }) {
  const [name, setName] = useState("");
  const [variables, setVariables] = useState([{ key: "", value: "" }]);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const duplicate = new Set(variables.map(variable => variable.key)).size !== variables.length;
  return <section className="settings-group"><h4>Automation environments & secrets</h4>
    <p className="execution-help">Separate from your personal passphrase vault. Only secrets explicitly entered here and enabled for automation can be delivered to an approved runner for this project. Values are write-only; existing values are never fetched.</p>
    {data.environments.map(environment => <article className="execution-card" key={environment.id}><div className="execution-card-head"><strong>{environment.name}</strong><span className="execution-badge">{environment.automationEnabled ? "Automation enabled" : "Disabled"}</span></div><p className="execution-help">Keys: {environment.keys.join(", ") || "None"}</p><p className="execution-help">Machine scope: {environment.hostIds.map(id => data.hosts.find(host => host.id === id)?.name ?? id).join(", ") || "No machines"}</p>
      {data.permissions.admin && <ConfirmButton className="ghost-button compact danger" label={`Delete environment ${environment.name}`} text="Delete environment" confirmLabel="Confirm delete" disabled={busy} onConfirm={() => { void act("deleteEnvironment", { environmentId: environment.id }).catch(() => {}); }} />}
    </article>)}
    {data.permissions.admin && <form className="settings-form execution-card" onSubmit={async event => {
      event.preventDefault(); setSaved(false);
      try { await act("saveEnvironment", { name, variables: Object.fromEntries(variables.filter(variable => variable.key).map(variable => [variable.key, variable.value])), hostIds, automationEnabled: enabled }); setVariables([{ key: "", value: "" }]); setName(""); setHostIds([]); setEnabled(false); setSaved(true); } catch { /* Parent displays errors. */ }
    }}><fieldset disabled={busy}><h4>Create or replace an environment</h4><label>Environment name<input required value={name} maxLength={100} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
      <p className="execution-help">Saving an existing name replaces its complete secret set and machine scope. Re-enter all keys you want to retain. Empty values are explicit values, not a request to keep an old secret.</p>
      {variables.map((variable, index) => <div className="execution-secret-row" key={index}><label>Variable name<input required={Boolean(variable.value)} pattern="[A-Za-z_][A-Za-z0-9_]*" value={variable.key} onChange={event => setVariables(variables.map((item, at) => at === index ? { ...item, key: event.target.value } : item))} autoComplete="off" spellCheck={false} /></label><label>Secret value<input type="password" value={variable.value} onChange={event => setVariables(variables.map((item, at) => at === index ? { ...item, value: event.target.value } : item))} autoComplete="new-password" spellCheck={false} /></label><button className="icon-button" type="button" aria-label={`Remove variable ${index + 1}`} onClick={() => setVariables(variables.filter((_, at) => at !== index))}><Trash2 size={14} /></button></div>)}
      <button type="button" className="ghost-button compact" onClick={() => setVariables([...variables, { key: "", value: "" }])}><Plus size={14} />Add variable</button>
      {duplicate && <p className="notice danger">Each variable name must be unique.</p>}
      <fieldset className="execution-checkbox-list"><legend>Approved machines · explicit scope</legend>{data.hosts.filter(host => !host.revoked).map(host => <label key={host.id}><input type="checkbox" checked={hostIds.includes(host.id)} onChange={event => setHostIds(event.target.checked ? [...hostIds, host.id] : hostIds.filter(id => id !== host.id))} />{host.name}</label>)}</fieldset>
      <SettingSwitch label="Explicitly allow these secrets in automation" checked={enabled} onChange={setEnabled} />
      <button className="primary-button compact" disabled={duplicate || (enabled && !hostIds.length)}>Save write-only environment</button>
    </fieldset></form>}
    {saved && <p className="notice success" role="status">Environment saved. Secret values cleared from the form.</p>}
  </section>;
}

function ExecutionUpdates({ data, busy, act }: { data: ExecutionSnapshot; busy: boolean; act: ExecutionAction }) {
  return <section className="settings-group"><div className="execution-card-head"><h4>Supervised updates</h4><button type="button" className="ghost-button compact" disabled={busy || !data.permissions.admin} onClick={() => { void act("checkUpdates").catch(() => {}); }}>Check stable releases</button></div><p className="execution-help">Updates require an idle compatible machine and a pinned stable release. Active jobs are not interrupted; no OS reboot or broad NixOS rebuild is requested.</p>
    {!data.updates.length && <p className="settings-empty">No update check reported.</p>}
    {data.updates.map((update, index) => <article className="execution-card" key={`${update.hostId ?? "controller"}:${update.component}:${index}`}><strong>{update.component} · {data.hosts.find(host => host.id === update.hostId)?.name ?? "Controller"}</strong><p className="execution-help">{update.currentVersion ?? "Version unknown"} → {update.availableVersion ?? "No available version reported"} · {update.status} · Checked {executionTime(update.checkedAt)}</p>{update.message && <p className="notice">{update.message}</p>}
      {data.permissions.admin && update.status === "available" && <ConfirmButton className="ghost-button compact" icon={<RefreshCw size={14} />} label={`Apply ${update.component} update`} text="Apply while idle" confirmLabel="Confirm update" disabled={busy || Boolean(data.hosts.find(host => host.id === update.hostId)?.activeRunIds.length)} onConfirm={() => { void act("applyUpdates", { hostId: update.hostId }).catch(() => {}); }} />}
    </article>)}
  </section>;
}
