import { useMemo, useState } from "react";
import { Check, Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { providerConnectionPresets, type ProviderPresetId } from "../../server/providers/catalog.ts";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
}

function secretEnvFor(id: string): string {
  return `OPENMAUSBOT_API_${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_KEY`;
}

function isApiInstance(instance: InstanceInfo): boolean {
  return instance.driverKind === "openai-compat";
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
  const { state, refreshInstances, refreshModels } = useStore();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderPresetId>("openai");
  const [name, setName] = useState("OpenAI Personal");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preset = useMemo(() => providerConnectionPresets().find((item) => item.id === provider)!, [provider]);
  const apiInstances = state.instances.filter(isApiInstance);
  const accountInstances = state.instances.filter((instance) => !isApiInstance(instance) && accountProviders[instance.driverKind]);

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
    if (provider === "nvidia-nim" && !baseUrl.trim()) {
      setError("NVIDIA NIM needs the base URL of your deployment.");
      return;
    }

    const existing = new Set(state.instances.map((instance) => instance.instanceId));
    const baseId = `api-${slug(trimmedName)}`;
    let instanceId = baseId;
    for (let suffix = 2; existing.has(instanceId); suffix += 1) instanceId = `${baseId}-${suffix}`;

    const url = (baseUrl.trim() || preset.baseUrl).replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) {
      setError("Base URL must start with http:// or https://.");
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          instances: {
            [instanceId]: {
              driver: "openai-compat",
              displayName: trimmedName,
              environment: { [secretEnvFor(instanceId)]: trimmedKey },
              config: {
                url,
                apiKeyEnv: secretEnvFor(instanceId),
                ...(model.trim() ? { model: model.trim() } : {}),
              },
            },
          },
        }),
      });
      await refreshInstances();
      setStatus(`${trimmedName} added. Refresh its models to verify the connection.`);
      setOpen(false);
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async (instance: InstanceInfo) => {
    if (!window.confirm(`Remove the API connection “${instance.displayName}”?`)) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "DELETE" });
      await refreshInstances();
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
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink" placeholder={preset.baseUrl} />
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={resetForm} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50">Cancel</button>
            <button type="button" onClick={addConnection} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Save provider
            </button>
          </div>
        </div>
      )}

      {status && <div role="status" className="mt-3 flex items-center gap-1.5 text-[12px] text-success"><Check size={13} />{status}</div>}
      {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}

      <div className="mt-5 space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">API connections</h3>
        {apiInstances.length === 0 ? (
          <p className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[12px] text-ink-secondary">No API connections yet.</p>
        ) : apiInstances.map((instance) => {
          const models = instance.snapshot.models?.options ?? [];
          return (
            <div key={instance.instanceId} className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline/30 bg-panel px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{instance.displayName}</div>
                <div className="truncate text-[11px] text-ink-secondary">{instance.snapshot.state} · {models.slice(0, 3).map((m) => m.id).join(", ") || "model list not refreshed"}</div>
              </div>
              <button type="button" onClick={() => refreshModels(instance.instanceId)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"><RefreshCw size={12} /> Refresh models</button>
              <button type="button" onClick={() => removeConnection(instance)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-danger/80 hover:bg-danger/10 disabled:opacity-50"><Trash2 size={12} /> Remove</button>
            </div>
          );
        })}
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
