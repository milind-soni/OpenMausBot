import { useState } from "react";
import { Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { keySaved } from "@/lib/product-events";
import { addedServers } from "@/lib/openai-compat-endpoints";
import { ApiKeyRow, OpenAiCompatSettings } from "./ApiKeys";

export function modelIds(text: string): string[] {
  return [...new Set(text.split(/[,，、\s]+/).map((id) => id.trim()).filter(Boolean))];
}

const INPUT = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none";
const ICON_BUTTON = "shrink-0 rounded-md px-2 py-1 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-50";

export function OtherOpenAiCompatServers() {
  const { state } = useStore();
  const added = addedServers(state.instances);
  return (
    <details data-api-keys-other className="rounded-lg border border-hairline/40 bg-inset px-3 py-2" open={Boolean(state.config?.openaiCompat?.configured) || added.length > 0}>
      <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("keys.other.title")}</summary>
      <div className="mt-3 flex flex-col gap-4">
        <ApiKeyRow section="openaiCompat" testProvider="openaiCompat" />
        <OpenAiCompatSettings />
        <AddedServers servers={added} />
      </div>
    </details>
  );
}

function AddedServers({ servers }: { servers: Array<InstanceInfo & { url?: string }> }) {
  const { dispatch, refreshInstances } = useStore();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState<"add" | "other" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(name.trim() && url.trim() && key.trim());

  const run = (kind: "add" | "other", request: () => Promise<{ instances?: unknown }>, onDone?: () => void) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    void request()
      .then(async ({ instances }) => {
        if (Array.isArray(instances)) dispatch({ type: "instances", instances: instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
        onDone?.();
      })
      .catch((e: Error) => setError(e.message || t("apiInstances.failed")))
      .finally(() => setBusy(null));
  };

  const add = () => ready && run(
    "add",
    () => api("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({ displayName: name.trim(), url: url.trim(), key: key.trim(), ...(modelIds(models).length ? { models: modelIds(models) } : {}) }),
    }).then(
      (added) => { keySaved("custom_endpoint", "settings", "unverified"); return added; },
      (cause: unknown) => { keySaved("custom_endpoint", "settings", "error"); throw cause; },
    ),
    () => { setName(""); setUrl(""); setKey(""); setModels(""); },
  );

  return (
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">{t("apiInstances.title")}</div>
      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("apiInstances.subtitle")}</p>
      {servers.length === 0 && <p className="text-[11.5px] text-ink-secondary">{t("apiInstances.empty")}</p>}
      {servers.map((server) => (
        <div key={server.instanceId} className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-[12px] text-ink">{server.displayName}</div>
            {server.url && <div className="truncate font-mono text-[11px] text-ink-secondary">{server.url}</div>}
          </div>
          <button
            type="button"
            onClick={() => run("other", () => api(`/api/instances/${encodeURIComponent(server.instanceId)}/refresh-models`, { method: "POST" }))}
            disabled={busy !== null}
            aria-label={t("apiInstances.refreshModels", { name: server.displayName })}
            title={t("apiInstances.refreshModels", { name: server.displayName })}
            className={ICON_BUTTON}
          >
            <RotateCw size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => run("other", () => api(`/api/instances/${encodeURIComponent(server.instanceId)}`, { method: "DELETE" }))}
            disabled={busy !== null}
            aria-label={t("apiInstances.remove", { name: server.displayName })}
            title={t("apiInstances.remove", { name: server.displayName })}
            className={`${ICON_BUTTON} hover:bg-danger/10 hover:text-danger`}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="mt-2 flex flex-col gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("apiInstances.name")} aria-label={t("apiInstances.name")}
          spellCheck={false} disabled={busy !== null} className={INPUT} />
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1" aria-label={t("apiInstances.url")}
          spellCheck={false} disabled={busy !== null} className={`${INPUT} font-mono`} />
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("apiInstances.key")} aria-label={t("apiInstances.key")}
          autoComplete="off" disabled={busy !== null} className={`${INPUT} font-mono`} />
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder={t("apiInstances.models")} aria-label={t("apiInstances.models")}
          spellCheck={false} disabled={busy !== null} className={`${INPUT} font-mono`} />
        <p className="text-[11px] leading-relaxed text-ink-secondary">{t("apiInstances.modelsHint")}</p>
        <button
          type="button"
          onClick={add}
          disabled={busy !== null || !ready}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink hover:bg-inset disabled:opacity-50"
        >
          {busy === "add" ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
          {busy === "add" ? t("apiInstances.adding") : t("apiInstances.add")}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
