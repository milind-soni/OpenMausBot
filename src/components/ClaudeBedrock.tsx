import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { KEY_FIELD } from "./keys/KeyRow";
import { PresetProviderMark } from "./ProviderIcons";

const INPUT = cn(KEY_FIELD, "font-sans");
const TIER_PLACEHOLDER = {
  opusModel: "global.anthropic.claude-opus-5-5",
  sonnetModel: "global.anthropic.claude-sonnet-5-5",
  haikuModel: "global.anthropic.claude-haiku-5-5",
  smallFastModel: "global.anthropic.claude-haiku-5-5",
} as const;
type Tier = keyof typeof TIER_PLACEHOLDER;
const TIERS: Tier[] = ["opusModel", "sonnetModel", "haikuModel", "smallFastModel"];

interface Draft {
  name: string;
  awsProfile: string;
  awsRegion: string;
  model: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  smallFastModel: string;
}

const EMPTY: Draft = { name: "Claude on Bedrock", awsProfile: "default", awsRegion: "", model: "", opusModel: "", sonnetModel: "", haikuModel: "", smallFastModel: "" };

const draftOf = (instance: InstanceInfo): Draft => {
  const bedrock = instance.claudeBedrock;
  return {
    name: instance.displayName,
    awsProfile: bedrock?.awsProfile || "default",
    awsRegion: bedrock?.awsRegion ?? "",
    model: "",
    opusModel: bedrock?.opusModel ?? "",
    sonnetModel: bedrock?.sonnetModel ?? "",
    haikuModel: bedrock?.haikuModel ?? "",
    smallFastModel: bedrock?.smallFastModel ?? "",
  };
};

const TIER_LABEL: Record<Tier, "claudeBedrock.opus" | "claudeBedrock.sonnet" | "claudeBedrock.haiku" | "claudeBedrock.smallFast"> = {
  opusModel: "claudeBedrock.opus",
  sonnetModel: "claudeBedrock.sonnet",
  haikuModel: "claudeBedrock.haiku",
  smallFastModel: "claudeBedrock.smallFast",
};

function BedrockForm({ instance, onDone }: { instance?: InstanceInfo; onDone: () => void }) {
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
  const ready = Boolean(draft.name.trim() && draft.awsProfile.trim() && draft.awsRegion.trim());

  const save = async () => {
    if (saving || !ready) return;
    setSaving(true);
    setError(null);
    const body = {
      displayName: draft.name.trim(),
      awsProfile: draft.awsProfile.trim(),
      awsRegion: draft.awsRegion.trim(),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...Object.fromEntries(TIERS.map((tier) => [tier, draft[tier].trim()])),
    };
    try {
      const result = instance
        ? await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-bedrock`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/api/instances/claude-bedrock", { method: "POST", body: JSON.stringify(body) });
      if (Array.isArray(result.instances)) dispatch({ type: "instances", instances: result.instances });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("claudeBedrock.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form data-claude-bedrock-form={instance?.instanceId ?? "new"} className="flex flex-col gap-2 rounded-xl border border-hairline/50 bg-inset p-3"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeBedrock.awsHint")}</p>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeBedrock.name")}
        <input {...field("name")} maxLength={80} autoFocus aria-label={t("claudeBedrock.name")} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeBedrock.profile")}
        <input {...field("awsProfile")} maxLength={128} placeholder="default" aria-label={t("claudeBedrock.profile")} className={cn(INPUT, "font-mono")} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeBedrock.region")}
        <input {...field("awsRegion")} maxLength={32} placeholder="us-east-1" aria-label={t("claudeBedrock.region")} className={cn(INPUT, "font-mono")} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("claudeBedrock.model")}
        <input {...field("model")} maxLength={160} placeholder="global.anthropic.claude-sonnet-5-5" aria-label={t("claudeBedrock.model")} className={cn(INPUT, "font-mono")} />
      </label>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeBedrock.modelHint")}</p>
      <details className="rounded-lg border border-hairline/40 px-2.5 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary outline-none hover:text-ink">{t("claudeBedrock.tiers")}</summary>
        <div className="mt-2 flex flex-col gap-2">
          {TIERS.map((tier) => (
            <label key={tier} className="flex flex-col gap-1 text-[12px] font-medium text-ink">
              {t(TIER_LABEL[tier])}
              <input {...field(tier)} maxLength={160} placeholder={TIER_PLACEHOLDER[tier]} aria-label={t(TIER_LABEL[tier])} className={cn(INPUT, "font-mono")} />
            </label>
          ))}
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

function BedrockRow({ instance, onEdit }: { instance: InstanceInfo; onEdit: () => void }) {
  const { state, dispatch } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usedBy = state.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId
    || bot.fallback?.some((candidate) => candidate.instanceId === instance.instanceId)
    || bot.tasks?.some((task) => task.modelSelection?.instanceId === instance.instanceId)).length;
  const bedrock = instance.claudeBedrock;
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
    <li data-claude-bedrock={instance.instanceId} className="px-3 py-2.5">
      <div className="flex min-h-9 items-center gap-3">
        <PresetProviderMark preset="aws" size={16} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink" title={instance.displayName}>{instance.displayName}</div>
          <div className="truncate font-mono text-[11px] text-ink-secondary">{t("claudeBedrock.rowSubtitle", { profile: bedrock?.awsProfile ?? "", region: bedrock?.awsRegion ?? "" })}</div>
        </div>
        <button type="button" onClick={onEdit} disabled={removing} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
          {t("claudeBedrock.edit")}
        </button>
        <button type="button" disabled={removing || usedBy > 0} onClick={() => setConfirming(true)}
          title={usedBy > 0 ? t("accounts.inUse", { count: String(usedBy) }) : t("accounts.remove")}
          aria-label={t("claudeBedrock.remove", { name: instance.displayName })}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50">
          {removing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      <ConfirmDialog open={confirming} title={t("accounts.removeTitle", { name: instance.displayName })}
        body={t("claudeBedrock.removeBody")} confirmLabel={t("accounts.remove")} tone="neutral" pending={removing}
        onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />
    </li>
  );
}

export function ClaudeBedrockEndpoints() {
  const { state } = useStore();
  const instances = state.instances.filter((instance) => instance.claudeBedrock);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-claude-bedrock-endpoints="" className="mt-3 space-y-2">
      <div className="text-[13px] leading-[18px] text-ink">{t("claudeBedrock.title")}</div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeBedrock.hint")}</p>
      {instances.length === 0
        ? <p className="text-[12px] leading-4 text-ink-secondary">{t("claudeBedrock.empty")}</p>
        : <ul className="divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
          {instances.map((instance) => open === instance.instanceId
            ? <li key={instance.instanceId} className="p-3"><BedrockForm instance={instance} onDone={() => setOpen(null)} /></li>
            : <BedrockRow key={instance.instanceId} instance={instance} onEdit={() => setOpen(instance.instanceId)} />)}
        </ul>}
      {open === "new"
        ? <BedrockForm onDone={() => setOpen(null)} />
        : <button type="button" onClick={() => setOpen("new")} className="flex min-h-8 w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
          <Plus size={14} />{t("claudeBedrock.add")}
        </button>}
    </div>
  );
}
