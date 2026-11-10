import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { KEY_FIELD } from "./keys/KeyRow";

const INPUT = cn(KEY_FIELD, "font-sans");
const MAPPINGS = [
  ["opusModel", "claudeEndpoints.opus"],
  ["sonnetModel", "claudeEndpoints.sonnet"],
  ["haikuModel", "claudeEndpoints.haiku"],
] as const;

interface Draft {
  name: string;
  url: string;
  token: string;
  model: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
}

const EMPTY: Draft = { name: "", url: "", token: "", model: "", opusModel: "", sonnetModel: "", haikuModel: "" };

const draftOf = (instance: InstanceInfo): Draft => ({
  name: instance.displayName,
  url: instance.claudeEndpoint?.baseUrl ?? "",
  token: "",
  model: instance.claudeEndpoint?.models[0] ?? "",
  opusModel: instance.claudeEndpoint?.opusModel ?? "",
  sonnetModel: instance.claudeEndpoint?.sonnetModel ?? "",
  haikuModel: instance.claudeEndpoint?.haikuModel ?? "",
});

function EndpointForm({ instance, onDone }: { instance?: InstanceInfo; onDone: () => void }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState<Draft>(instance ? draftOf(instance) : EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof Draft) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value })),
    spellCheck: false,
    disabled: saving,
  });
  const ready = Boolean(draft.name.trim() && draft.url.trim() && draft.model.trim() && (instance || draft.token.trim()));

  const save = async () => {
    if (saving || !ready) return;
    setSaving(true);
    setError(null);
    const body = {
      displayName: draft.name.trim(),
      baseUrl: draft.url.trim(),
      model: draft.model.trim(),
      opusModel: draft.opusModel.trim(),
      sonnetModel: draft.sonnetModel.trim(),
      haikuModel: draft.haikuModel.trim(),
      ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
    };
    try {
      const result = instance
        ? await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-endpoint`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/api/instances/claude-endpoint", { method: "POST", body: JSON.stringify(body) });
      if (Array.isArray(result.instances)) dispatch({ type: "instances", instances: result.instances });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("claudeEndpoints.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form data-claude-endpoint-form={instance?.instanceId ?? "new"} className="flex flex-col gap-2 rounded-xl border border-hairline/50 bg-inset p-3"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.name")}
        <input {...field("name")} maxLength={80} autoFocus aria-label={t("claudeEndpoints.name")} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.baseUrl")}
        <input {...field("url")} type="url" maxLength={2048} placeholder="https://api.example.com/anthropic" aria-label={t("claudeEndpoints.baseUrl")} className={cn(INPUT, "font-mono")} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.token")}
        <input {...field("token")} type="password" maxLength={4096} autoComplete="off" aria-label={t("claudeEndpoints.token")} className={cn(INPUT, "font-mono")}
          placeholder={instance ? t("claudeEndpoints.tokenKeep") : ""} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeEndpoints.model")}
        <input {...field("model")} maxLength={160} placeholder="deepseek-chat" aria-label={t("claudeEndpoints.model")} className={cn(INPUT, "font-mono")} />
      </label>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeEndpoints.modelHint")}</p>
      <details className="text-[12px] text-ink-secondary">
        <summary className="cursor-pointer select-none hover:text-ink">{t("claudeEndpoints.mappings")}</summary>
        <div className="mt-2 flex flex-col gap-1.5">
          {MAPPINGS.map(([key, label]) => (
            <input key={key} {...field(key)} maxLength={160} aria-label={t(label)} placeholder={t(label)} className={cn(INPUT, "font-mono")} />
          ))}
          <p className="leading-relaxed">{t("claudeEndpoints.mappingsHint")}</p>
        </div>
      </details>
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
  const endpoint = instance.claudeEndpoint;
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
    <li data-claude-endpoint={instance.instanceId} className="px-3 py-2.5">
      <div className="flex min-h-9 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink" title={instance.displayName}>{instance.displayName}</div>
          <div className="truncate font-mono text-[11px] text-ink-secondary" title={endpoint?.baseUrl}>{endpoint?.baseUrl}</div>
          <div className="truncate text-[12px] text-ink-secondary">{endpoint?.models.join(" · ")}</div>
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

/** Custom Claude endpoints: their own engines, so this computer's Claude Code and its sign-in stay as they are. */
export function ClaudeEndpoints() {
  const { state } = useStore();
  const endpoints = state.instances.filter((instance) => instance.claudeEndpoint);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-claude-endpoints className="mt-3 space-y-2">
      <div className="text-[13px] leading-[18px] text-ink">{t("claudeEndpoints.title")}</div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeEndpoints.hint")}</p>
      {endpoints.length === 0
        ? <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeEndpoints.empty")}</p>
        : <ul className="divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
          {endpoints.map((instance) => open === instance.instanceId
            ? <li key={instance.instanceId} className="p-3"><EndpointForm instance={instance} onDone={() => setOpen(null)} /></li>
            : <EndpointRow key={instance.instanceId} instance={instance} onEdit={() => setOpen(instance.instanceId)} />)}
        </ul>}
      {open === "new"
        ? <EndpointForm onDone={() => setOpen(null)} />
        : <button type="button" onClick={() => setOpen("new")} className="flex min-h-8 w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
          <Plus size={14} />{t("claudeEndpoints.add")}
        </button>}
    </div>
  );
}