import { useState } from "react";
import { Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { keySaved } from "@/lib/product-events";
import { addedServers } from "@/lib/openai-compat-endpoints";
import { cn } from "@/lib/cn";
import { KEY_FIELD } from "./keys/KeyRow";
import { Select } from "./Select";

export function modelIds(text: string): string[] {
  return [...new Set(text.split(/[,，、\s]+/).map((id) => id.trim()).filter(Boolean))];
}

const INPUT = cn(KEY_FIELD, "font-sans");
/** A slow computer can take minutes before a local model's first words, so the wait is the person's call. */
export const REPLY_WAIT_CHOICES = [5, 10, 20, 30, 60] as const;
const ICON_BUTTON = "ui-icon-button shrink-0 hover:text-ink";

export function OtherOpenAiCompatServers() {
  const { state } = useStore();
  return <AddedServers servers={addedServers(state.instances)} />;
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
    <div data-api-keys-other>
      <div className="mb-0.5 text-[13px] leading-[18px] text-ink">{t("apiInstances.title")}</div>
      <p className="mb-2 text-[12px] leading-4 text-ink-secondary">{t("apiInstances.subtitle")}</p>
      {servers.length === 0 && <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.empty")}</p>}
      {servers.map((server) => (
        <div key={server.instanceId} className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] text-ink">{server.displayName}</div>
            {server.url && <div className="truncate font-mono text-[11px] text-ink-secondary">{server.url}</div>}
          </div>
          <Select
            size="sm"
            className="shrink-0"
            value={server.replyWaitMinutes ?? ""}
            onChange={(event) => {
              const minutes = event.target.value ? Number(event.target.value) : null;
              run("other", () => api(`/api/instances/${encodeURIComponent(server.instanceId)}`, { method: "PATCH", body: JSON.stringify({ replyWaitMinutes: minutes }) }));
            }}
            disabled={busy !== null}
            aria-label={t("apiInstances.replyWaitFor", { name: server.displayName })}
            title={t("apiInstances.replyWaitHint")}
          >
            <option value="">{t("apiInstances.replyWaitDefault")}</option>
            {[...new Set([...REPLY_WAIT_CHOICES, ...(server.replyWaitMinutes ? [server.replyWaitMinutes] : [])])].sort((a, b) => a - b).map((minutes) => (
              <option key={minutes} value={minutes}>{t("apiInstances.replyWaitMinutes", { minutes: String(minutes) })}</option>
            ))}
          </Select>
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
          spellCheck={false} disabled={busy !== null} className={cn(INPUT, "font-mono")} />
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("apiInstances.key")} aria-label={t("apiInstances.key")}
          autoComplete="off" disabled={busy !== null} className={cn(INPUT, "font-mono")} />
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder={t("apiInstances.models")} aria-label={t("apiInstances.models")}
          spellCheck={false} disabled={busy !== null} className={cn(INPUT, "font-mono")} />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.modelsHint")}</p>
        <button
          type="button"
          onClick={add}
          disabled={busy !== null || !ready}
          className="ui-button self-start"
        >
          {busy === "add" ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
          {busy === "add" ? t("apiInstances.adding") : t("apiInstances.add")}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export const LM_STUDIO_PLACEHOLDER_KEY = "lm-studio";

export function lmStudioBaseUrl(port: string): string | null {
  const text = port.trim();
  if (!/^[1-9]\d{0,4}$/.test(text)) return null;
  const value = Number(text);
  if (value > 65535) return null;
  return `http://127.0.0.1:${value}/v1`;
}

export function LmStudioServer({ heading = true }: { heading?: boolean } = {}) {
  const { state, dispatch, refreshInstances } = useStore();
  const added = addedServers(state.instances);
  const [port, setPort] = useState("1234");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = lmStudioBaseUrl(port);
  const present = Boolean(url && added.some((server) => server.url === url));

  const add = () => {
    if (busy || !url || present) return;
    setBusy(true);
    setError(null);
    void api("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({
        displayName: "LM Studio",
        url,
        key: token.trim() || LM_STUDIO_PLACEHOLDER_KEY,
        catalog: "lmstudio",
      }),
    }).then(
      async (created) => {
        keySaved("custom_endpoint", "settings", "unverified");
        if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
        setToken("");
      },
      (cause: unknown) => {
        keySaved("custom_endpoint", "settings", "error");
        setError(cause instanceof Error && cause.message ? cause.message : t("apiInstances.failed"));
      },
    ).finally(() => setBusy(false));
  };

  return (
    <div className={cn(heading && "rounded-lg border border-hairline/40 bg-inset px-3 py-2")}>
      {heading && <div className="text-[13px] text-ink">{t("lmStudio.title")}</div>}
      <p className={cn("text-[12px] leading-4 text-ink-secondary", heading && "mt-1")}>{t("lmStudio.desc")}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        <label className="flex flex-col gap-1 text-[12px] leading-4 text-ink-secondary">
          {t("lmStudio.port")}
          <input
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            aria-label={t("lmStudio.port")}
            spellCheck={false}
            disabled={busy}
            className={cn(INPUT, "font-mono")}
          />
        </label>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={t("lmStudio.token")}
          aria-label={t("lmStudio.token")}
          autoComplete="off"
          disabled={busy}
          className={cn(INPUT, "font-mono")}
        />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("lmStudio.tokenHint")}</p>
        {url && <p className="truncate font-mono text-[12px] leading-4 text-ink-secondary">{url}</p>}
        <button
          type="button"
          onClick={add}
          disabled={busy || !url || present}
          className="ui-button self-start"
        >
          {busy ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
          {busy ? t("lmStudio.adding") : t("lmStudio.add")}
        </button>
        {present && <p className="text-[12px] text-ink-secondary">{t("lmStudio.added")}</p>}
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
