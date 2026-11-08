"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { ExecutionPolicy, ExecutionSnapshot } from "@/lib/execution-types";
import { SettingSwitch } from "./settings-controls";
import type { ExecutionAction } from "./use-execution";

type Props = { data: ExecutionSnapshot; scope: "workspace" | "project" | "task"; busy: boolean; act: ExecutionAction; onStart?: (policy: ExecutionPolicy) => Promise<void> };
type Selection = ExecutionPolicy["fallback"][number];

export function ExecutionPolicyEditor({ data, scope, busy, act, onStart }: Props) {
  const [draft, setDraft] = useState<ExecutionPolicy | null>(null);
  const [saved, setSaved] = useState("");
  const policy = draft ?? data.effectivePolicy;
  const editable = scope === "task" ? data.permissions.write : data.permissions.admin;
  const patch = (value: Partial<ExecutionPolicy>) => { setDraft({ ...policy, ...value }); setSaved(""); };
  const setEntry = (index: number, entry: Selection) => patch({ fallback: policy.fallback.map((value, at) => at === index ? entry : value) });
  const move = (index: number, direction: number) => {
    const fallback = [...policy.fallback];
    [fallback[index], fallback[index + direction]] = [fallback[index + direction], fallback[index]];
    patch({ fallback });
  };
  const savedScope = scope === "task" ? data.taskPolicy : scope === "project" ? data.projectPolicy : data.workspacePolicy;
  const inherited = scope !== "workspace" && !Object.keys(savedScope ?? {}).length;
  return <form className="execution-policy settings-form" onSubmit={async event => {
    event.preventDefault();
    try { await act("savePolicy", { scope, policy }); setDraft(null); setSaved("Policy saved"); } catch { /* The parent displays the request error. */ }
  }}>
    <p className="execution-help">Priority: task overrides → project → workspace. {inherited ? "This scope currently inherits its policy." : `Saved ${scope} policy applies here.`} Saving pins these settings at this scope. Running jobs keep their existing configuration.</p>
    <fieldset disabled={!editable || busy}>
      <div className="execution-grid">
        <label>Machine<select value={policy.machine} onChange={event => patch({ machine: event.target.value })}>
          <option value="auto">Automatic · NixOS first</option>
          {!data.hosts.some(host => host.id === policy.machine) && policy.machine !== "auto" && <option value={policy.machine}>Unavailable machine ({policy.machine})</option>}
          {data.hosts.map(host => <option key={host.id} value={host.id}>{host.name} · {host.kind} · {host.status}{host.platform === "darwin" ? " · explicit Mac request" : ""}</option>)}
        </select></label>
        <label>Platform<select value={policy.platform} onChange={event => patch({ platform: event.target.value as ExecutionPolicy["platform"] })}><option value="portable">Portable / Linux</option><option value="apple">Apple / Xcode required</option></select></label>
        <label>Automation environment<select value={policy.environment} onChange={event => patch({ environment: event.target.value })}>
          <option value="">No injected secrets</option>
          {policy.environment && !data.environments.some(environment => environment.name === policy.environment) && <option value={policy.environment}>Unavailable: {policy.environment}</option>}
          {data.environments.map(environment => <option key={environment.id} value={environment.name}>{environment.name}{environment.automationEnabled ? "" : " · disabled"}</option>)}
        </select></label>
        <label>Cloud provider for new runs<select value={policy.cloudProvider} onChange={event => patch({ cloudProvider: event.target.value as ExecutionPolicy["cloudProvider"] })}><option value="boxd">Boxd</option><option value="boat">Boat</option></select></label>
      </div>
      <p className="execution-help">Mac is Apple-only unless explicitly selected. A pinned machine stays pinned. Cloud is eligible only when every eligible local machine is independently confirmed offline—not busy, paused, unreachable with unknown presence, or missing a CLI. Apple jobs never use Linux cloud.</p>
      <SettingSwitch label="Allow offline-only cloud execution" checked={policy.cloudEnabled} onChange={cloudEnabled => patch({ cloudEnabled })} />
      <p className="execution-help">Enabling cloud and its provider authorizes compute provisioning on that existing account and may incur provider charges. Origin never upgrades the account or automatically switches from Boxd to paid Boat when credits run out.</p>
      <h4>Accounts, harnesses & ranked fallback</h4>
      <p className="execution-help">First choice runs first. Every entry specifies an exact reported account, harness, model and effort. Native CLI credentials remain on the machine; sign in there to connect an account. T3 is manual-only and cannot execute unattended runs.</p>
      <ol className="execution-fallback">
        {policy.fallback.map((entry, index) => {
          const account = data.accounts.find(item => item.id === entry.accountId);
          const models = (account?.models ?? []).filter(model => Object.values(account?.bindings ?? {}).some(profiles => profiles.some(profile => profile.harnesses.includes(entry.harness) && profile.models?.some(available => available.id === model.id))));
          const efforts = models.find(model => model.id === entry.model)?.efforts ?? [];
          return <li className="execution-card" key={index}>
            <div className="execution-card-head"><strong>{index + 1}. {index ? "Fallback" : "First choice"}</strong><div className="execution-actions">
              <button className="icon-button" type="button" disabled={index === 0} aria-label={`Move choice ${index + 1} up`} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
              <button className="icon-button" type="button" disabled={index === policy.fallback.length - 1} aria-label={`Move choice ${index + 1} down`} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
              <button className="icon-button" type="button" aria-label={`Remove choice ${index + 1}`} onClick={() => patch({ fallback: policy.fallback.filter((_, at) => at !== index) })}><Trash2 size={14} /></button>
            </div></div>
            <div className="execution-grid">
              <label>Account<select required value={entry.accountId} onChange={event => setEntry(index, { accountId: event.target.value, harness: "" as Selection["harness"], model: "" })}>
                <option value="">Choose reported account</option>
                {entry.accountId && !account && <option value={entry.accountId}>Unavailable account ({entry.accountId})</option>}
                {data.accounts.map(item => <option key={item.id} value={item.id}>{item.label} · {item.provider} · {item.authKind}{!item.authenticated ? " · sign-in required" : ""}</option>)}
              </select></label>
              <label>Harness<select required value={entry.harness} onChange={event => setEntry(index, { ...entry, harness: event.target.value as Selection["harness"], model: "", effort: undefined })}>
                <option value="">Choose harness</option>
                {!account?.harnesses.includes(entry.harness) && entry.harness && <option value={entry.harness} disabled>{entry.harness} · unavailable</option>}
                {account?.harnesses.map(harness => <option key={harness} value={harness} disabled={harness === "t3"}>{harness}{harness === "t3" ? " · manual only" : ""}</option>)}
              </select></label>
              <label>Model<select required value={entry.model} onChange={event => setEntry(index, { ...entry, model: event.target.value, effort: undefined })}>
                <option value="">{models.length ? "Choose reported model" : "No models reported"}</option>
                {entry.model && !models.some(model => model.id === entry.model) && <option value={entry.model}>{entry.model} · no longer reported</option>}
                {models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
              </select></label>
              <label>Reasoning effort<select value={entry.effort ?? ""} onChange={event => setEntry(index, { ...entry, effort: event.target.value || undefined })}>
                <option value="">Harness default</option>
                {entry.effort && !efforts.includes(entry.effort) && <option value={entry.effort}>{entry.effort} · no longer reported</option>}
                {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
              </select></label>
            </div>
            {(!account || !account.authenticated) && <p className="notice">This account is unavailable or needs sign-in on the runner. Origin will not silently substitute another account.</p>}
            {account && policy.machine !== "auto" && !account.hostIds.includes(policy.machine) && <p className="notice">This account is not reported on the selected machine. Sign in there or explicitly choose a different machine/account; Origin will not substitute one.</p>}
            {entry.harness === "t3" && <p className="notice">T3 has no supported unattended adapter. Use its interactive UI in a manual worktree instead.</p>}
          </li>;
        })}
      </ol>
      <button type="button" className="ghost-button compact" onClick={() => patch({ fallback: [...policy.fallback, { accountId: "", harness: "" as Selection["harness"], model: "" }] })}><Plus size={14} />Add ranked choice</button>
      {!data.accounts.length && <p className="execution-help">No coding accounts reported yet. Enroll a machine, install a supported CLI and sign in on that machine. No models or usage are assumed.</p>}
      <div className="execution-grid">
        <label>Fallback trigger<select value={policy.fallbackMode} onChange={event => patch({ fallbackMode: event.target.value as ExecutionPolicy["fallbackMode"] })}><option value="disabled">Disabled</option><option value="quota">Confirmed quota exhaustion</option><option value="quota-and-outage">Quota or provider outage</option></select></label>
        <label>Quota reserve (%)<input type="number" min={0} max={100} required value={policy.reservePercent} onChange={event => patch({ reservePercent: Number(event.target.value) })} /></label>
      </div>
      <SettingSwitch label="Allow paid model API fallback (off by default)" checked={policy.allowPaidApi} onChange={allowPaidApi => patch({ allowPaidApi })} />
      <SettingSwitch label="Allow cross-harness checkpoint handoff" checked={policy.allowCrossHarness} onChange={allowCrossHarness => patch({ allowCrossHarness })} />
      <p className="execution-help">Unknown or stale quota is not exhaustion. A previous process must stop before handoff. API cost estimates are not subscription limits or a universal hard spending cap.</p>
      <h4>Verification & merge</h4>
      <label>Verification commands · one per line<textarea rows={3} value={policy.verificationCommands.join("\n")} onChange={event => patch({ verificationCommands: event.target.value.split("\n") })} placeholder="Use this repository’s real test and check commands" /></label>
      <label>Smoke command<input value={policy.smokeCommand} onChange={event => patch({ smokeCommand: event.target.value })} placeholder="Required for a verified completion" /></label>
      <div className="execution-grid">
        <label>Base branch<input required value={policy.baseBranch} onChange={event => patch({ baseBranch: event.target.value })} /></label>
        <label>Run timeout (seconds)<input type="number" required min={60} value={policy.timeoutSeconds} onChange={event => patch({ timeoutSeconds: Number(event.target.value) })} /></label>
      </div>
      <SettingSwitch label="Merge only after verification and required GitHub checks" checked={policy.autoMerge} onChange={autoMerge => patch({ autoMerge })} />
      <p className="execution-help">Branch protection and required reviews still apply. A merged PR is not proof of deployment.</p>
      <div className="execution-actions">
        <button className="primary-button compact" type="submit">Save {scope} policy</button>
        {scope !== "workspace" && <button type="button" className="ghost-button compact" onClick={async () => { try { await act("savePolicy", { scope, policy: {} }); setDraft(null); setSaved("Inherited policy restored"); } catch { /* Parent displays errors. */ } }}>Restore inheritance</button>}
        {draft && <button type="button" className="ghost-button compact" onClick={() => setDraft(null)}>Discard edits</button>}
        {onStart && <button type="button" className="primary-button compact" disabled={!policy.fallback.length || policy.fallback.some(entry => !entry.accountId || !entry.harness || !entry.model || entry.harness === "t3")} onClick={event => { if (event.currentTarget.form?.reportValidity()) void onStart(policy).catch(() => {}); }}>Develop with these overrides</button>}
      </div>
    </fieldset>
    {saved && <p className="notice success" role="status">{saved}</p>}
  </form>;
}
