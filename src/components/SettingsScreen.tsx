import { UsageSettings } from "./UsageSettings";
import { UsageRings } from "./UsageRings";
// Dedicated full-screen Settings page with categorized sections:
// Profile & Account, Connections & API Keys, Models & Providers, System.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Cpu,
  Folder,
  Info,
  Key,
  Keyboard,
  Loader2,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  User,
  XCircle,
} from "lucide-react";
import { api, ApiError, useStore, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { InitialsAvatar } from "./Avatar";
import { ApiKeyRow } from "./ApiKeys";
import { tourEvent } from "@/lib/workspaceOnboarding";
import { version as appVersion } from "../../package.json";
import { analyticsEnabled, setUsageAnalyticsEnabled, usageAnalyticsEnabled } from "@/lib/analytics";

export type SettingsTab = "profile" | "connections" | "models" | "system";

function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

function ProfileSection() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    setSaving(true);
    void api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((config) => {
        dispatch({ type: "configStatus", config });
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 2500);
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const inputClass =
    "w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none transition-colors";

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-center gap-4 border-b border-hairline/40 pb-5">
          <InitialsAvatar initials={profileInitials({ name, email })} size={56} />
          <div>
            <h2 className="text-[16px] font-semibold text-ink">
              {name.trim() || email.trim() || "Your Profile"}
            </h2>
            <p className="text-[13px] text-ink-secondary">
              Shown in the sidebar and attributed to your user actions.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">Display Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={save}
              placeholder="e.g. Alex Doe"
              className={inputClass}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={save}
              placeholder="alex@example.com"
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-hairline/40 pt-4 text-[12px] text-ink-secondary">
          <span>Changes save automatically.</span>
          <div className="flex items-center gap-1.5 text-accent font-medium">
            {saving ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Saving…
              </>
            ) : savedTick ? (
              <span className="flex items-center gap-1 text-success">
                <Check size={13} /> Saved
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="mt-0.5 text-accent shrink-0" />
          <div>
            <h3 className="text-[14px] font-medium text-ink">Local Storage & AI Processing</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              Gerer Build Studio stores your profiles, conversations, and project folders on the computer running Studio. When you message a bot, the connected AI app receives your messages and relevant content needed for the requested work under that service&apos;s policy. Usage analytics is off until you enable it in System settings.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionsSection() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="border-b border-hairline/40 pb-4">
          <h2 className="text-[16px] font-semibold text-ink">API Keys & Integrations</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            Shared across all Buddies and workspaces. Stored locally in write-only storage; saving instantly hot-reloads provider drivers.
          </p>
        </div>

        <div className="mt-6 space-y-6">
          <div className="rounded-xl border border-hairline/40 bg-panel/60 p-4">
            <ApiKeyRow
              section="xai"
              label="xAI API Key"
              placeholder="xai-…  Direct Grok model authentication"
            />
            <p className="mt-2 text-[12px] text-ink-secondary">
              Configures credentials for xAI Grok provider models and ACP drivers without requiring local CLI login.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <Key size={20} className="mt-0.5 text-accent shrink-0" />
          <div>
            <h3 className="text-[14px] font-medium text-ink">Write-Only Security Guarantee</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              All credentials entered here are persisted with restrictive filesystem permissions in <code className="rounded bg-raised px-1.5 py-0.5 text-[12px]">~/.gbs/config.json</code>. The API never echoes secret keys back to the client.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelsSection() {
  const { state, dispatch } = useStore();
  const instances = state.instances ?? [];
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState("");
  const [refreshingModels, setRefreshingModels] = useState(false);
  const refreshModels = () => {
    setRefreshingModels(true);
    api("/api/instances?refresh=1")
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch(() => {})
      .finally(() => setRefreshingModels(false));
  };

  const setAutoApprove = (instanceId: string, autoApprove: boolean) => {
    if (pendingId) return;
    setPendingId(instanceId);
    setErrorId(null);
    setPermissionError("");
    api(`/api/instances/${instanceId}`, { method: "PATCH", body: JSON.stringify({ autoApprove }) })
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch((error) => {
        setErrorId(instanceId);
        setPermissionError(error instanceof ApiError && typeof error.body?.error === "string" ? error.body.error : "Couldn't save — try again.");
      })
      .finally(() => setPendingId(null));
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="border-b border-hairline/40 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 basis-[280px]">
              <h2 className="text-[16px] font-semibold text-ink">Active Model Providers & CLIs</h2>
              <p className="mt-1 text-[13px] text-ink-secondary">
                Live drivers detected by the local harness server on your machine.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
              <button onClick={refreshModels} disabled={refreshingModels} className="flex items-center gap-1 rounded-full bg-raised px-3 py-1 text-[12px] text-ink disabled:opacity-50">
                <RefreshCw size={12} className={refreshingModels ? "animate-spin" : ""} /> Refresh models
              </button>
              <span className="rounded-full bg-raised px-3 py-1 text-[12px] font-medium text-ink">
                {instances.filter((i) => i.snapshot.state === "available").length} / {instances.length} available
              </span>
            </div>
          </div>
        </div>

        {instances.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-ink-secondary">
            <Cpu size={32} className="mx-auto text-ink-secondary/60" />
            <p className="mt-3 font-medium text-ink">No providers registered yet</p>
            <p className="mt-1">Make sure the harness server is running (<code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>).</p>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            {instances.map((inst: InstanceInfo) => {
              const available = inst.snapshot.state === "available";
              return (
                <div
                  key={inst.instanceId}
                  className="rounded-xl border border-hairline/50 bg-panel/60 p-4 transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg",
                        available ? "bg-success/10 text-success" : "bg-raised text-ink-secondary"
                      )}>
                        <Sparkles size={18} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-[14px] font-semibold text-ink">{inst.displayName}</h3>
                          <span className="text-[11px] text-ink-secondary">({inst.driverKind})</span>
                        </div>
                        {inst.snapshot.version && (
                          <div className="text-[11px] text-ink-secondary">
                            CLI version: <span className="font-mono">{inst.snapshot.version}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
                        available
                          ? "bg-success/15 text-success"
                          : "bg-warning/15 text-warning"
                      )}
                    >
                      {available ? (
                        <>
                          <CheckCircle2 size={12} /> Available
                        </>
                      ) : (
                        <>
                          <XCircle size={12} /> Unavailable
                        </>
                      )}
                    </span>
                  </div>

                  {inst.autoApprove !== null && (
                    <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-hairline/40 pt-3.5">
                      <div>
                        <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                          <ShieldCheck size={13} className="text-ink-secondary" />
                          {inst.autoApprove ? "Full auto" : "Ask before actions"}
                        </div>
                        <div className="mt-0.5 text-[12px] text-ink-secondary">
                          {inst.autoApprove
                            ? "Edits, commands, and tools run without asking."
                            : "You'll be asked to approve edits, commands, and tools."}
                        </div>
                        {errorId === inst.instanceId && (
                          <div className="mt-1 text-[11px] text-danger">{permissionError}</div>
                        )}
                      </div>
                      <button
                        role="switch"
                        aria-checked={inst.autoApprove}
                        disabled={pendingId === inst.instanceId}
                        onClick={() => setAutoApprove(inst.instanceId, !inst.autoApprove)}
                        className={cn(
                          "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:opacity-60",
                          inst.autoApprove ? "bg-accent" : "bg-raised",
                        )}
                      >
                        {pendingId === inst.instanceId ? (
                          <Loader2 size={14} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />
                        ) : (
                          <span
                            className={cn(
                              "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                              inst.autoApprove ? "left-[21px]" : "left-[3px]",
                            )}
                          />
                        )}
                      </button>
                    </div>
                  )}

                  {!available && inst.snapshot.reason && (
                    <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
                      {inst.snapshot.reason}
                    </div>
                  )}

                  {inst.models.status !== "ready" && (
                    <div className="mt-3 text-[12px] text-warning">
                      {inst.models.status === "stale" ? "Showing last known models; refresh failed." :
                        inst.models.status === "unverified" ? "This provider does not expose a verified model list." :
                          inst.models.error ?? "Model list unavailable."}
                    </div>
                  )}

                  {inst.models.options.length > 0 && (
                    <div className="mt-3.5 border-t border-hairline/40 pt-3">
                      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">
                        Available Models
                      </div>
                      {inst.models.refreshedAt && (
                        <div className="mt-1 text-[11px] text-ink-secondary">
                          Refreshed {new Date(inst.models.refreshedAt).toLocaleTimeString()} from {inst.models.source}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {inst.models.options.map((m) => (
                          <span
                            key={m.id}
                            className={cn(
                              "rounded-md px-2 py-1 text-[11px] font-mono",
                              m.id === inst.models.default
                                ? "bg-accent/15 text-accent border border-accent/30 font-medium"
                                : "bg-raised text-ink-secondary"
                            )}
                            title={m.id === inst.models.default ? "Default model" : undefined}
                          >
                            {m.label || m.id}
                            {m.id === inst.models.default && " (default)"}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <UsageSettings />
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <h3 className="text-[14px] font-medium text-ink">Provider CLI Setup Reference</h3>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Gerer Build Studio connects directly to your authorized local developer CLIs:
        </p>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
          <div className="rounded-xl bg-panel p-3.5 border border-hairline/40">
            <div className="font-semibold text-ink">Claude Code</div>
            <div className="mt-1 font-mono text-ink-secondary">npm i -g @anthropic-ai/claude-code</div>
            <div className="mt-1 text-ink-secondary">Run <code className="font-mono text-ink">claude</code> to authenticate.</div>
          </div>
          <div className="rounded-xl bg-panel p-3.5 border border-hairline/40">
            <div className="font-semibold text-ink">Codex CLI</div>
            <div className="mt-1 font-mono text-ink-secondary">npm i -g @openai/codex</div>
            <div className="mt-1 text-ink-secondary">Run <code className="font-mono text-ink">codex auth</code> to authenticate.</div>
          </div>
          <div className="rounded-xl bg-panel p-3.5 border border-hairline/40">
            <div className="font-semibold text-ink">xAI Grok</div>
            <div className="mt-1 text-ink-secondary">Configure your API Key in Connections tab or run grok CLI login.</div>
          </div>
          <div className="rounded-xl bg-panel p-3.5 border border-hairline/40">
            <div className="font-semibold text-ink">Antigravity / ACP</div>
            <div className="mt-1 text-ink-secondary">Standard agent control protocol drivers communicate over local stdio / JSON-RPC.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SystemSection() {
  const { state, dispatch } = useStore();
  const [usageAnalytics, setUsageAnalytics] = useState(usageAnalyticsEnabled);
  const autoApprovePermissions = state.config?.autoApprovePermissions ?? true;
  const autoApproveDelaySeconds = state.config?.autoApproveDelaySeconds ?? 10;
  const [approvalDelay, setApprovalDelay] = useState(String(autoApproveDelaySeconds));
  const [savingApproval, setSavingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState("");

  useEffect(() => setApprovalDelay(String(autoApproveDelaySeconds)), [autoApproveDelaySeconds]);

  const saveApproval = async (patch: { autoApprovePermissions?: boolean; autoApproveDelaySeconds?: number }) => {
    setSavingApproval(true);
    setApprovalError("");
    const previous = state.config;
    if (previous) dispatch({ type: "configStatus", config: { ...previous, ...patch } });
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
      dispatch({ type: "configStatus", config });
    } catch (error) {
      if (previous) dispatch({ type: "configStatus", config: previous });
      setApprovalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingApproval(false);
    }
  };

  const saveApprovalDelay = () => {
    const next = Number(approvalDelay);
    if (!Number.isInteger(next) || next < 1 || next > 120) {
      setApprovalError("Choose a delay from 1 to 120 seconds.");
      setApprovalDelay(String(autoApproveDelaySeconds));
      return;
    }
    if (next !== autoApproveDelaySeconds) void saveApproval({ autoApproveDelaySeconds: next });
  };

  const autoHandoffs = state.config?.autoHandoffs ?? true;
  const [togglingAutoHandoffs, setTogglingAutoHandoffs] = useState(false);

  const toggleAutoHandoffs = async () => {
    setTogglingAutoHandoffs(true);
    try {
      const next = !autoHandoffs;
      const status = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ autoHandoffs: next }),
      });
      dispatch({ type: "configStatus", config: status });
    } catch {
      // revert on error
    } finally {
      setTogglingAutoHandoffs(false);
    }
  };

  const platform = window.gbs?.platform ?? (typeof navigator !== "undefined" ? navigator.platform : "Unknown");

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Auto-approve permission cards</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              Allow pending actions after no activity in the app, including file changes and commands. Questions always wait for your answer.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Auto-approve permission cards"
            aria-checked={autoApprovePermissions}
            disabled={savingApproval}
            onClick={() => void saveApproval({ autoApprovePermissions: !autoApprovePermissions })}
            className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", autoApprovePermissions ? "bg-accent" : "bg-raised")}
          >
            <span className={cn("absolute top-1 size-4 rounded-full bg-white transition-transform", autoApprovePermissions ? "translate-x-5" : "translate-x-1")} />
          </button>
        </div>
        <label className="mt-4 flex items-center gap-2 text-[13px] text-ink-secondary">
          Approve after
          <input
            type="number"
            min={1}
            max={120}
            value={approvalDelay}
            disabled={savingApproval}
            onChange={(event) => setApprovalDelay(event.target.value)}
            onBlur={saveApprovalDelay}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            className="w-20 rounded-lg border border-hairline/60 bg-inset px-2 py-1 text-ink focus:border-accent focus:outline-none"
          />
          seconds of inactivity
        </label>
        {approvalError && <p role="alert" className="mt-2 text-[12px] text-danger">{approvalError}</p>}
      </div>

      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Usage Analytics</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              {analyticsEnabled
                ? "Share usage events to help improve Gerer Build Studio. Off by default; you can change this anytime."
                : "Unavailable in this build because no analytics project is configured."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Usage Analytics"
            aria-checked={usageAnalytics}
            disabled={!analyticsEnabled}
            onClick={() => {
              const next = !usageAnalytics;
              if (setUsageAnalyticsEnabled(next)) setUsageAnalytics(next);
            }}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              usageAnalytics ? "bg-accent" : "bg-raised"
            )}
          >
            <span className={cn(
              "absolute top-1 size-4 rounded-full bg-white transition-transform",
              usageAnalytics ? "translate-x-5" : "translate-x-1"
            )} />
          </button>
        </div>
      </div>

      {/* Auto Handoffs Card */}
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Automatic Agent Handoffs</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              Automatically dispatch messages to mentioned Buddies across all multi-agent rooms. Enabled by default for all rooms.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoHandoffs}
            disabled={togglingAutoHandoffs}
            onClick={toggleAutoHandoffs}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
              autoHandoffs ? "bg-accent" : "bg-raised"
            )}
          >
            <span
              className={cn(
                "absolute top-1 size-4 rounded-full bg-white transition-transform",
                autoHandoffs ? "translate-x-5" : "translate-x-1"
              )}
            />
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <h2 className="text-[16px] font-semibold text-ink">About this build</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">Application updates are paused during the internal alpha.</p>
        <button type="button" className="mt-3 rounded-lg bg-raised px-3 py-2 text-sm font-medium text-ink hover:bg-raised-hover" onClick={() => window.dispatchEvent(new Event(tourEvent))}>Restart Studio tour</button>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[13px]">
          <div className="rounded-xl bg-panel p-3 border border-hairline/40">
            <div className="text-[11px] text-ink-secondary">App Version</div>
            <div className="mt-1 font-semibold text-ink">{appVersion}</div>
          </div>
          <div className="rounded-xl bg-panel p-3 border border-hairline/40">
            <div className="text-[11px] text-ink-secondary">Platform</div>
            <div className="mt-1 font-semibold text-ink">{platform}</div>
          </div>
          <div className="rounded-xl bg-panel p-3 border border-hairline/40">
            <div className="text-[11px] text-ink-secondary">Environment</div>
            <div className="mt-1 font-semibold text-ink">{window.gbs ? "Electron Desktop" : "Web Browser"}</div>
          </div>
          <div className="rounded-xl bg-panel p-3 border border-hairline/40">
            <div className="text-[11px] text-ink-secondary">Runtime</div>
            <div className="mt-1 font-semibold text-ink">React 19 / Vite 7</div>
          </div>
        </div>
      </div>

      {/* System diagnostics card */}
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <h2 className="text-[16px] font-semibold text-ink">System Diagnostics & Storage</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Local services and data stores driving your Buddies and tasks.
        </p>

        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-hairline/40 bg-panel/60 p-3.5">
            <div className="flex items-center gap-3">
              <Server size={18} className="text-accent" />
              <div>
                <div className="text-[13px] font-medium text-ink">Local Harness Server</div>
                <div className="text-[11px] text-ink-secondary">Loopback IPC transport on 127.0.0.1:8899</div>
              </div>
            </div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
                state.connected ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
              )}
            >
              <span className={cn("size-1.5 rounded-full", state.connected ? "bg-success" : "bg-danger")} />
              {state.connected ? "Connected" : "Disconnected"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-hairline/40 bg-panel/60 p-3.5">
            <div className="flex items-center gap-3">
              <Folder size={18} className="text-accent" />
              <div>
                <div className="text-[13px] font-medium text-ink">Local Data Directory</div>
                <div className="text-[11px] text-ink-secondary">~/.gbs (Threads, logs, configurations)</div>
              </div>
            </div>
            <span className="font-mono text-[11px] text-ink-secondary">~/.gbs</span>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="rounded-xl border border-hairline/40 bg-panel/60 p-3 text-center">
              <div className="text-[11px] text-ink-secondary">Configured Buddies</div>
              <div className="mt-1 text-[18px] font-semibold text-ink">{state.bots.length}</div>
            </div>
            <div className="rounded-xl border border-hairline/40 bg-panel/60 p-3 text-center">
              <div className="text-[11px] text-ink-secondary">Rooms / Groups</div>
              <div className="mt-1 text-[18px] font-semibold text-ink">{state.groups.length}</div>
            </div>
            <div className="rounded-xl border border-hairline/40 bg-panel/60 p-3 text-center">
              <div className="text-[11px] text-ink-secondary">Tracked Tasks</div>
              <div className="mt-1 text-[18px] font-semibold text-ink">{state.tasks.length}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Keyboard Shortcuts Reference */}
      <div className="rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <Keyboard size={18} className="text-accent" />
          <h2 className="text-[16px] font-semibold text-ink">Keyboard Shortcuts</h2>
        </div>
        <p className="mt-1 text-[13px] text-ink-secondary">Quick navigation keys across the application.</p>

        <div className="mt-4 divide-y divide-hairline/40 rounded-xl border border-hairline/40 bg-panel overflow-hidden text-[13px]">
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-ink">Create new Buddy</span>
            <kbd className="rounded bg-raised px-2 py-0.5 font-mono text-[12px] text-ink">⌘N</kbd>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-ink">Jump to Buddy 1 – 9</span>
            <kbd className="rounded bg-raised px-2 py-0.5 font-mono text-[12px] text-ink">⌘1 – ⌘9</kbd>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-ink">Previous / Next Buddy</span>
            <kbd className="rounded bg-raised px-2 py-0.5 font-mono text-[12px] text-ink">⌘⇧[ / ⌘⇧]</kbd>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-ink">Close view / Back to chat</span>
            <kbd className="rounded bg-raised px-2 py-0.5 font-mono text-[12px] text-ink">Esc</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof User; blurb: string }> = [
  { id: "profile", label: "Profile", icon: User, blurb: "Account details & avatar" },
  { id: "connections", label: "Connections", icon: Key, blurb: "API keys & credentials" },
  { id: "models", label: "Models & Providers", icon: Cpu, blurb: "Live drivers & CLIs" },
  { id: "system", label: "System", icon: Info, blurb: "Preferences & diagnostics" },
];

export function SettingsScreen() {
  const { state, dispatch } = useStore();
  const initialTab = (state.appSettingsTab as SettingsTab) || "profile";
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab === ("sync" as unknown as SettingsTab) ? "profile" : initialTab);
  // Tracks the last store-driven tab request we applied, so a subsequent
  // local tab click (which doesn't touch state.appSettingsTab) isn't
  // stomped back to it on every render.
  const appliedAppSettingsTab = useRef(state.appSettingsTab);

  useEffect(() => {
    if (state.appSettingsTab && state.appSettingsTab !== appliedAppSettingsTab.current) {
      appliedAppSettingsTab.current = state.appSettingsTab;
      setActiveTab(state.appSettingsTab === ("sync" as unknown as SettingsTab) ? "profile" : (state.appSettingsTab as SettingsTab));
    }
  }, [state.appSettingsTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dispatch({ type: "toggleAppSettings", open: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header bar */}
      <header
        className="flex h-[64px] shrink-0 items-center justify-between border-b border-hairline/40 px-6"
        style={{ WebkitAppRegion: "drag", paddingRight: window.gbs?.platform === "win32" ? 148 : undefined } as CSSProperties}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
            className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title="Back to conversation (Esc)"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2.5">
            <Settings size={20} className="text-accent" />
            <div>
              <h1 className="text-[16px] font-semibold text-ink">Settings</h1>
              <p className="text-[12px] text-ink-secondary">Manage your preferences, connections, and system.</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <UsageRings />
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
            className="rounded-lg bg-raised px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover transition-colors"
          >
            Done
          </button>
        </div>
      </header>

      {/* Main container with tab navigation and content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Categorized Tab Bar */}
          <nav
            aria-label="Settings Categories"
            className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-2xl border border-hairline/40 bg-panel p-1.5"
          >
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex flex-col items-center sm:items-start gap-1 rounded-xl px-3 py-2.5 text-left transition-all",
                    active
                      ? "bg-card text-ink shadow-sm border border-hairline/60 font-medium"
                      : "text-ink-secondary hover:bg-raised/50 hover:text-ink"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon size={16} className={active ? "text-accent" : "text-ink-secondary"} />
                    <span className="text-[13px]">{tab.label}</span>
                  </div>
                  <span className="hidden sm:block text-[11px] text-ink-secondary truncate w-full">
                    {tab.blurb}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Tab Content Panels */}
          <div>
            {activeTab === "profile" && <ProfileSection />}
            {activeTab === "connections" && <ConnectionsSection />}
            {activeTab === "models" && <ModelsSection />}
            {activeTab === "system" && <SystemSection />}
          </div>
        </div>
      </div>
    </main>
  );
}
