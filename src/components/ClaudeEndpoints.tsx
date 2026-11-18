import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { KEY_FIELD } from "./keys/KeyRow";

type Engine = "claude" | "codex";
// Placeholders only: an Anthropic key already has its own engine in Settings → Keys. An empty Codex URL means OpenAI.
const OFFICIAL = { claude: { url: "https://api.anthropic.com", model: "deepseek-chat" }, codex: { url: "https://api.openai.com/v1", model: "" } };
const INPUT = cn(KEY_FIELD, "font-sans");
interface Draft {
  name: string;
  url: string;
  token: string;
  model: string;
}

const EMPTY: Draft = { name: "", url: "", token: "", model: "" };

const draftOf = (instance: InstanceInfo): Draft => ({
  name: instance.displayName,
  url: (instance.claudeEndpoint ?? instance.codexEndpoint)?.baseUrl ?? "",
  token: "",
  model: "",
});

function EndpointForm({ instance, engine, onDone }: { instance?: InstanceInfo; engine: Engine; onDone: () => void }) {
  const { dispatch } = useStore();
  const official = OFFICIAL[engine];
  const [draft, setDraft] = useState<Draft>(instance ? draftOf(instance) : EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof Draft) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value })),
    spellCheck: false,
    disabled: saving,
  });
  const ready = Boolean(draft.name.trim() && (draft.url.trim() || engine === "codex") && (instance || draft.token.trim()));

  const save = async () => {
    if (saving || !ready) return;
    setSaving(true);
    setError(null);
    const body = {
      displayName: draft.name.trim(),
      baseUrl: draft.url.trim() || official.url,
      ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
      // Empty lets the server read the host's model list.
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    };
    try {
      const result = instance
        ? await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/${engine}-endpoint`, { method: "PATCH", body: JSON.stringify(body) })
        : await api(`/api/instances/${engine}-endpoint`, { method: "POST", body: JSON.stringify(body) });
      if (Array.isArray(result.instances)) dispatch({ type: "instances", instances: result.instances });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("claudeEndpoints.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form data-claude-endpoint-form={engine === "claude" ? instance?.instanceId ?? "new" : undefined} data-codex-endpoint-form={engine === "codex" ? instance?.instanceId ?? "new" : undefined} className="flex flex-col gap-2 rounded-xl border border-hairline/50 bg-inset p-3"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="text-[12px] leading-4 text-ink-secondary">{t(engine === "codex" ? "agentEndpoints.responses" : "agentEndpoints.messages")}</p>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.name")}
        <input {...field("name")} maxLength={80} autoFocus aria-label={t("claudeEndpoints.name")} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.baseUrl")}
        <input {...field("url")} type="url" maxLength={2048} placeholder={official.url} aria-label={t("claudeEndpoints.baseUrl")} className={cn(INPUT, "font-mono")} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.token")}
        <input {...field("token")} type="password" maxLength={4096} autoComplete="off" aria-label={t("claudeEndpoints.token")} className={cn(INPUT, "font-mono")}
          placeholder={instance ? t("claudeEndpoints.tokenKeep") : ""} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.model")}
        <input {...field("model")} maxLength={160} placeholder={official.model} aria-label={t("claudeEndpoints.model")} className={cn(INPUT, "font-mono")} />
      </label>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeEndpoints.modelHint")}</p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} disabled={saving} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-50">{t("common.cancel")}</button>
        <button type="submit" disabled={saving || !ready} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
          {saving && <Loader2 size={13} className="animate-spin" />}{t("common.save")}
        </button>
      </div>
    </form>
  );
}

function EndpointRow({ instance, onEdit }: { instance: InstanceInfo; onEdit: () => void }) {
  const { state, dispatch } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usedBy = state.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId
    || bot.fallback?.some((candidate) => candidate.instanceId === instance.instanceId)
    || bot.tasks?.some((task) => task.modelSelection?.instanceId === instance.instanceId)).length;
  const endpoint = instance.claudeEndpoint ?? instance.codexEndpoint;
  const remove = async () => {
    setConfirming(false);
    setRemoving(true);
    setError(null);
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "DELETE" });
      if (Array.isArray(result.instances)) dispatch({ type: "instances", instances: result.instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <li data-claude-endpoint={instance.claudeEndpoint ? instance.instanceId : undefined} data-codex-endpoint={instance.codexEndpoint ? instance.instanceId : undefined} className="px-3 py-2.5">
      <div className="flex min-h-9 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink" title={instance.displayName}>{instance.displayName}</div>
          <div className="truncate font-mono text-[11px] text-ink-secondary" title={endpoint?.baseUrl}>{endpoint?.baseUrl}</div>
        </div>
        <button type="button" onClick={onEdit} disabled={removing} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
          {t("claudeEndpoints.edit")}
        </button>
        <button type="button" disabled={removing || usedBy > 0} onClick={() => setConfirming(true)}
          title={usedBy > 0 ? t("accounts.inUse", { count: String(usedBy) }) : t("accounts.remove")}
          aria-label={t("claudeEndpoints.remove", { name: instance.displayName })}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50">
          {removing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      <ConfirmDialog open={confirming} title={t("accounts.removeTitle", { name: instance.displayName })}
        body={t("claudeEndpoints.removeBody")} confirmLabel={t("accounts.remove")} tone="neutral" pending={removing}
        onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />
    </li>
  );
}

function AgentEndpoints({ engine }: { engine: Engine }) {
  const { state } = useStore();
  const endpoints = state.instances.filter((instance) => engine === "claude" ? instance.claudeEndpoint : instance.codexEndpoint);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-claude-endpoints={engine === "claude" ? "" : undefined} data-codex-endpoints={engine === "codex" ? "" : undefined} className="mt-3 space-y-2">
      <div className="text-[13px] leading-[18px] text-ink">{t(engine === "claude" ? "claudeEndpoints.title" : "agentEndpoints.codexTitle")}</div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t(engine === "claude" ? "claudeEndpoints.hint" : "agentEndpoints.codexHint")}</p>
      {endpoints.length === 0
        ? <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeEndpoints.empty")}</p>
        : <ul className="divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
          {endpoints.map((instance) => open === instance.instanceId
            ? <li key={instance.instanceId} className="p-3"><EndpointForm engine={engine} instance={instance} onDone={() => setOpen(null)} /></li>
            : <EndpointRow key={instance.instanceId} instance={instance} onEdit={() => setOpen(instance.instanceId)} />)}
        </ul>}
      {open === "new"
        ? <EndpointForm engine={engine} onDone={() => setOpen(null)} />
        : <button type="button" onClick={() => setOpen("new")} className="flex min-h-8 w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
          <Plus size={14} />{t("claudeEndpoints.add")}
        </button>}
    </div>
  );
}
export function ClaudeEndpoints() { return <AgentEndpoints engine="claude" />; }
export function CodexEndpoints() { return <AgentEndpoints engine="codex" />; }
