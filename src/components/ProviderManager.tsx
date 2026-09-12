import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { providerConnectionPresets, type ProviderPresetId, validateProviderBaseUrl } from "../../server/providers/catalog";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
}

export function isManagedApiInstance(instance: Pick<InstanceInfo, "instanceId" | "driverKind">): boolean {
  return instance.driverKind === "openai-compat" && instance.instanceId.startsWith("api-");
}

export function requiresExplicitBaseUrl(provider: ProviderPresetId): boolean {
  return providerConnectionPresets().find((item) => item.id === provider)?.requiresBaseUrl ?? false;
}

const accountProviders: Record<string, string> = {
  claudeAgent: "Anthropic / Claude",
  codex: "OpenAI / Codex",
  antigravityAgent: "Google / Antigravity",
  cursorAgent: "Cursor",
  opencodeGo: "OpenCode",
  qwenAgent: "Qwen",
  kimiAgent: "Moonshot AI",
  grok: "xAI / Grok",
  grokAgent: "xAI / Grok",
};

export function ProviderManager() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderPresetId>("openai");
  const [name, setName] = useState("OpenAI Personal");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshRequests = useRef(new Map<string, number>());
  const refreshSequence = useRef(0);

  const loadInstances = useCallback(async () => {
    const { instances: next } = await api("/api/instances") as { instances: InstanceInfo[] };
    setInstances(next);
  }, []);

  useEffect(() => {
    let alive = true;
    loadInstances()
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [loadInstances]);

  const refreshManagedModels = async (instanceId: string) => {
    const requestId = ++refreshSequence.current;
    refreshRequests.current.set(instanceId, requestId);
    setRefreshingId(instanceId);
    setError(null);
    try {
      const { instances: next } = await api(`/api/instances/${encodeURIComponent(instanceId)}/refresh-models`, { method: "POST" }) as { instances: InstanceInfo[] };
      if (refreshRequests.current.get(instanceId) === requestId) setInstances(next);
    } catch (e) {
      if (refreshRequests.current.get(instanceId) === requestId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (refreshRequests.current.get(instanceId) === requestId) {
        refreshRequests.current.delete(instanceId);
        setRefreshingId(null);
      }
    }
  };

  const preset = useMemo(() => providerConnectionPresets().find((item) => item.id === provider)!, [provider]);
  const apiInstances = instances.filter(isManagedApiInstance);
  const accountInstances = instances.filter((instance) => !isManagedApiInstance(instance) && accountProviders[instance.driverKind]);

  const resetForm = () => {
    setOpen(false);
    setApiKey("");
    setBaseUrl("");
    setModel("");
    setShowKey(false);
    setError(null);
    setStatus(null);
  };

  const addConnection = async () => {
    const trimmedName = name.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedName || !trimmedKey) {
      setError("Connection name and API key are required.");
      return;
    }
    if (requiresExplicitBaseUrl(provider) && !baseUrl.trim()) {
      setError(`${preset.displayName} needs a base URL for this connection.`);
      return;
    }

    const existing = new Set(instances.map((instance) => instance.instanceId));
    const baseId = `api-${slug(trimmedName)}`;
    let instanceId = baseId;
    for (let suffix = 2; existing.has(instanceId); suffix += 1) instanceId = `${baseId}-${suffix}`;

    const rawUrl = baseUrl.trim() || preset.baseUrl;
    let url: string;
    try {
      url = validateProviderBaseUrl(rawUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          providerConnections: {
            [instanceId]: {
              displayName: trimmedName,
              apiKey: trimmedKey,
              url,
              provider,
              ...(model.trim() ? { model: model.trim() } : {}),
            },
          },
        }),
      });
      await loadInstances();
      await refreshManagedModels(instanceId);
      setStatus(`${trimmedName} added. Refresh models when the endpoint is available.`);
      setOpen(false);
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async (instance: InstanceInfo) => {
    if (!isManagedApiInstance(instance)) return;
    if (!window.confirm(`Remove the API connection “${instance.displayName}”?`)) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ providerConnectionDeletes: [instance.instanceId] }),
      });
      await loadInstances();
      setStatus(`${instance.displayName} removed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-hairline/40 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">AI Providers</h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-secondary">
            Add multiple API keys and keep existing account-based logins such as Claude, Google, Cursor, and Codex in the same place.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setOpen((value) => !value); setError(null); }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12px] font-semibold text-ink hover:bg-raised-hover"
        >
          <Plus size={14} /> Add provider
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-3 rounded-xl border border-hairline/40 bg-panel p-3 sm:grid-cols-2">
          <label className="text-[12px] text-ink-secondary">
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderPresetId)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink">
              {providerConnectionPresets().map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-ink-secondary">
            Connection name
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink" placeholder="Personal OpenAI" />
          </label>
          <label className="text-[12px] text-ink-secondary">
            API key
            <span className="relative mt-1 block">
              <input type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-9 text-[13px] text-ink" placeholder="Paste once; it is never displayed after save" autoComplete="off" />
              <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-secondary" aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </span>
          </label>
          <label className="text-[12px] text-ink-secondary">
            Model (optional)
            <input value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink" placeholder="Auto-discover from /models" />
          </label>
          <label className="text-[12px] text-ink-secondary sm:col-span-2">
            Base URL {preset.requiresBaseUrl ? "(required)" : "(optional)"}
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink" placeholder={preset.requiresBaseUrl ? "https://.../v1" : preset.baseUrl} />
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={resetForm} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50">Cancel</button>
            <button type="button" onClick={addConnection} disabled={busy || loading} className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Save provider
            </button>
          </div>
        </div>
      )}

      {status && <div role="status" className="mt-3 flex items-center gap-1.5 text-success"><Check size={13} />{status}</div>}
      {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}

      <div className="mt-5 space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">API connections</h3>
        {loading ? (
          <p className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[12px] text-ink-secondary">Loading provider connections…</p>
        ) : apiInstances.length === 0 ? (
          <p className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[12px] text-ink-secondary">No API connections yet.</p>
        ) : apiInstances.map((instance) => (
          <div key={instance.instanceId} className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline/30 bg-panel px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">{instance.displayName}</div>
              <div className="truncate text-[11px] text-ink-secondary">{instance.snapshot.state} · {instance.models.options.length ? `${instance.models.options.length} models discovered` : "No models discovered"}</div>
            </div>
            <button type="button" onClick={() => refreshManagedModels(instance.instanceId)} disabled={busy || refreshingId === instance.instanceId} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"><RefreshCw size={12} className={cn(refreshingId === instance.instanceId && "animate-spin")} /> Refresh models</button>
            <button type="button" onClick={() => removeConnection(instance)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-danger/80 hover:bg-danger/10 disabled:opacity-50"><Trash2 size={12} /> Remove</button>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Account-based connections</h3>
        {accountInstances.length === 0 ? (
          <p className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[12px] text-ink-secondary">No account-based engine instances detected.</p>
        ) : accountInstances.map((instance) => (
          <div key={instance.instanceId} className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline/30 bg-panel px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-ink">{instance.displayName}</div>
              <div className={cn("truncate text-[11px]", instance.snapshot.authenticated ? "text-success" : "text-ink-secondary")}>{accountProviders[instance.driverKind]} · {instance.snapshot.account?.email ?? (instance.snapshot.authenticated ? "authenticated" : "needs setup")}</div>
            </div>
            <span className="rounded-full bg-control px-2 py-1 text-[10.5px] text-ink-secondary">Existing login</span>
          </div>
        ))}
      </div>
    </section>
  );
}
