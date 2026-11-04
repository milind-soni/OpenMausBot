import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { IMAGE_DEFAULT_MODELS, IMAGE_MAX_PER_TURN_DEFAULT, IMAGE_MODEL_CHOICES, IMAGE_PROVIDERS, normalizeImageGenerationUrl, type ImageProvider, type ImageProviderTest } from "../../shared/image-generation";
import { saveCredential } from "./keys/key-save";
import { Card, SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";
import { productName } from "@/lib/brand";

const PROVIDER_LABEL: Record<ImageProvider, string> = {
  openai: "OpenAI", xai: "Grok (xAI)", gemini: "Gemini", openrouter: "OpenRouter", custom: "Custom",
};
const OWN_KEYS = {
  openai: { credential: "openaiImageApiKey", patch: (key: string) => ({ imageGen: { key } }), label: "imageGen.key.openai" },
  gemini: { credential: "geminiImageApiKey", patch: (key: string) => ({ imageGen: { geminiKey: key } }), label: "imageGen.key.gemini" },
  custom: { credential: "customImageApiKey", patch: (key: string) => ({ imageGen: { customApiKey: key } }), label: "imageGen.key.custom" },
} as const satisfies Partial<Record<ImageProvider, { credential: string; patch: (key: string) => object; label: LocaleKey }>>;
const SHARED_KEYS = {
  xai: { label: "imageGen.key.xai", note: "imageGen.key.sharedXai" },
  openrouter: { label: "imageGen.key.openrouter", note: "imageGen.key.sharedOpenrouter" },
} as const satisfies Partial<Record<ImageProvider, { label: LocaleKey; note: LocaleKey }>>;
const KEY_URL: Partial<Record<ImageProvider, string>> = {
  openai: "https://platform.openai.com/api-keys", gemini: "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai", openrouter: "https://openrouter.ai/keys",
};
const INPUT_CLASS = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50";
const BUTTON_CLASS = "flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";

type Slot = "primary" | "fallback";
type ModelChoice = { id: string; name: string; group: "recommended" | "more" };
type OpenRouterImageModels = { source: "openrouter" | "builtin"; models: ModelChoice[] };
const OTHER_MODEL = "\u0000other";

/** A fixed sentence per verdict: the vendor's own body never reaches the page. */
function imageTestText(provider: ImageProvider, result: ImageProviderTest): { ok: boolean; text: string } {
  if (result.ok) {
    if (result.freeTier) return { ok: false, text: t("imageGen.test.noCredit") };
    return { ok: true, text: t(provider === "openrouter" ? "imageGen.test.okOpenrouter" : "imageGen.test.ok") };
  }
  if (result.reason === "model_missing") return { ok: false, text: t("imageGen.test.modelMissing", { model: result.model }) };
  if (result.reason === "rejected") return { ok: false, text: t("imageGen.test.rejected") };
  if (result.reason === "unreachable") return { ok: false, text: t("imageGen.test.unreachable") };
  if (result.reason === "no_key") return { ok: false, text: t("imageGen.key.missing") };
  if (result.reason === "no_url") return { ok: false, text: t("imageGen.test.noUrl") };
  return { ok: false, text: t("imageGen.test.unexpected") };
}
type ImageGenStatus = NonNullable<ConfigStatus["imageGen"]>;

function keyConfigured(status: ImageGenStatus | undefined, provider: ImageProvider): boolean {
  if (provider === "openai") return status?.openaiConfigured === true;
  if (provider === "xai") return status?.xaiConfigured === true;
  if (provider === "gemini") return status?.geminiConfigured === true;
  if (provider === "openrouter") return status?.openrouterConfigured === true;
  return status?.customKeyConfigured === true;
}

export function ImageGenerationSettings() {
  const { state, dispatch } = useStore();
  const status = state.config?.imageGen;
  const primary = status?.primary ?? { provider: status?.provider ?? "openai", model: status?.model ?? IMAGE_DEFAULT_MODELS.openai, configured: status?.configured === true };
  const fallback = status?.fallback ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openrouterModels, setOpenrouterModels] = useState<OpenRouterImageModels | null>(null);
  const usesOpenrouter = primary.provider === "openrouter" || fallback?.provider === "openrouter";

  useEffect(() => {
    if (!usesOpenrouter || openrouterModels) return;
    let cancelled = false;
    api<OpenRouterImageModels>("/api/images/openrouter-models").then(
      (list) => { if (!cancelled) setOpenrouterModels(Array.isArray(list?.models) ? list : { source: "builtin", models: [] }); },
      () => { if (!cancelled) setOpenrouterModels({ source: "builtin", models: [] }); },
    );
    return () => { cancelled = true; };
  }, [usesOpenrouter, openrouterModels]);

  const save = async (patch: object) => {
    setSaving(true);
    setError(null);
    try {
      const next: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
      dispatch({ type: "configStatus", config: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const chooseProvider = (slot: Slot, value: string) => {
    if (slot === "fallback" && value === "") return void save({ imageGen: { fallback: null } });
    const provider = value as ImageProvider;
    const hidesBackup = slot === "primary" && fallback?.provider === provider;
    return void save({ imageGen: { [slot]: { provider }, ...(hidesBackup ? { fallback: null } : {}) } });
  };

  const providers = [primary.provider, ...(fallback ? [fallback.provider] : [])].filter((provider, index, all) => all.indexOf(provider) === index);

  return (
    <>
      <section className="space-y-2 px-4">
        <p className="text-[13px] leading-relaxed text-ink-secondary">{t("imageGen.intro")}</p>
        <p role="status" data-testid="image-gen-status" className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <span className={cn("size-1.5 shrink-0 rounded-full", !status?.ready ? "bg-raised-hover" : primary.configured ? "bg-success" : "bg-warning")} />
          {status?.ready
            ? primary.configured
              ? t("imageGen.status.ready", { provider: PROVIDER_LABEL[primary.provider] })
              : t("imageGen.status.backupOnly", { provider: PROVIDER_LABEL[fallback!.provider] })
            : t("imageGen.status.notReady")}
        </p>
      </section>

      <SlotRow
        slot="primary" provider={primary.provider} model={primary.model} configured={primary.configured} openrouterModels={openrouterModels}
        disabled={saving || !state.config} onProvider={chooseProvider} onModel={(model) => void save({ imageGen: { primary: { provider: primary.provider, model } } })}
      />
      <SlotRow
        slot="fallback" provider={fallback?.provider ?? null} model={fallback?.model ?? ""} configured={fallback?.configured === true} exclude={primary.provider} openrouterModels={openrouterModels}
        disabled={saving || !state.config} onProvider={chooseProvider} onModel={(model) => fallback && void save({ imageGen: { fallback: { provider: fallback.provider, model } } })}
      />
      <SettingRow title={t("imageGen.maxPerTurn.label")} subtitle={t("imageGen.maxPerTurn.help")}>
        <Select
          className="w-20"
          data-testid="image-gen-max"
          value={String(status?.maxPerTurn ?? IMAGE_MAX_PER_TURN_DEFAULT)}
          onChange={(event) => void save({ imageGen: { maxPerTurn: Number(event.target.value) } })}
          disabled={saving || !state.config}
          aria-label={t("imageGen.maxPerTurn.label")}
        >
          {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
        </Select>
      </SettingRow>
      {error && <p role="alert" className="px-4 text-[12px] text-danger">{error}</p>}

      {providers.map((provider) => <ProviderKeyCard key={provider} provider={provider} status={status} />)}
    </>
  );
}

function SlotRow({ slot, provider, model, configured, exclude, openrouterModels, disabled, onProvider, onModel }: {
  slot: Slot;
  provider: ImageProvider | null;
  model: string;
  configured: boolean;
  exclude?: ImageProvider;
  openrouterModels: OpenRouterImageModels | null;
  disabled: boolean;
  onProvider: (slot: Slot, value: string) => void;
  onModel: (model: string) => void;
}) {
  const label = t(slot === "primary" ? "imageGen.primary.label" : "imageGen.fallback.label");
  return (
    <>
      <SettingRow
        title={label}
        subtitle={provider && !configured ? t(provider === "custom" ? "imageGen.slot.needsConnection" : "imageGen.slot.needsKey") : t(slot === "primary" ? "imageGen.primary.help" : "imageGen.fallback.help")}
      >
        <Select
          className="w-48"
          data-testid={`image-gen-${slot}`}
          value={provider ?? ""}
          onChange={(event) => onProvider(slot, event.target.value)}
          disabled={disabled}
          aria-label={label}
        >
          {slot === "fallback" && <option value="">{t("imageGen.fallback.none")}</option>}
          {IMAGE_PROVIDERS.filter((option) => option !== exclude).map((option) => <option key={option} value={option}>{PROVIDER_LABEL[option]}</option>)}
        </Select>
      </SettingRow>
      {provider && <ModelRow slot={slot} slotLabel={label} provider={provider} model={model} openrouterModels={openrouterModels} disabled={disabled} onModel={onModel} />}
    </>
  );
}

function ModelRow({ slot, slotLabel, provider, model, openrouterModels, disabled, onModel }: {
  slot: Slot;
  slotLabel: string;
  provider: ImageProvider;
  model: string;
  openrouterModels: OpenRouterImageModels | null;
  disabled: boolean;
  onModel: (model: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const live = provider === "openrouter" && openrouterModels?.source === "openrouter" ? openrouterModels.models : null;
  const choices: ModelChoice[] = live ?? IMAGE_MODEL_CHOICES[provider].map((choice) => ({ ...choice, group: "recommended" }));
  const typing = draft !== null || choices.length === 0;
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() && draft.trim() !== model) onModel(draft.trim());
  };
  const pick = (value: string) => {
    if (value === OTHER_MODEL) return setDraft(model);
    setDraft(null);
    onModel(value);
  };
  return (
    <SettingRow
      title={t("decider.model.label")}
      subtitle={provider === "openrouter" && openrouterModels?.source === "builtin" ? t("decider.model.builtinNote") : undefined}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {choices.length > 0 && (
          <Select
            className="w-64 max-w-full"
            data-testid={`image-gen-${slot}-model`}
            value={typing ? OTHER_MODEL : model}
            onChange={(event) => pick(event.target.value)}
            disabled={disabled}
            aria-label={t("imageGen.model.label", { slot: slotLabel })}
          >
            {model && !choices.some((choice) => choice.id === model) && <option value={model}>{model}</option>}
            {(["recommended", "more"] as const).map((group) => {
              const inGroup = choices.filter((choice) => choice.group === group);
              return inGroup.length > 0 && (
                <optgroup key={group} label={t(group === "recommended" ? "decider.model.recommended" : "decider.model.more")}>
                  {inGroup.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
                </optgroup>
              );
            })}
            <option value={OTHER_MODEL}>{t("imageGen.model.other")}</option>
          </Select>
        )}
        {typing && (
          <input
            value={draft ?? model}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && commit()}
            disabled={disabled}
            placeholder={IMAGE_DEFAULT_MODELS[provider] || t("imageGen.model.placeholder")}
            aria-label={t("imageGen.model.idLabel", { slot: slotLabel })}
            autoComplete="off"
            spellCheck={false}
            className={cn(INPUT_CLASS, "w-64 max-w-full")}
          />
        )}
      </div>
    </SettingRow>
  );
}

function ProviderKeyCard({ provider, status }: { provider: ImageProvider; status: ImageGenStatus | undefined }) {
  const { dispatch } = useStore();
  const [value, setValue] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; text: string; models: string } | null>(null);
  // OpenRouter's verdict also covers the models it checked; once they change it no longer applies. Others check only the key.
  const models = provider === "openrouter" ? [status?.primary, status?.fallback].filter((slot) => slot?.provider === provider).map((slot) => slot?.model).join(" ") : "";
  const verdict = tested?.models === models ? tested : null;
  const setVerdict = (next: { ok: boolean; text: string } | null) => setTested(next && { ...next, models });
  const configured = keyConfigured(status, provider);
  const own = provider === "openai" || provider === "gemini" || provider === "custom" ? OWN_KEYS[provider] : null;
  const shared = provider === "xai" || provider === "openrouter" ? SHARED_KEYS[provider] : null;
  const customUrl = url ?? status?.customUrl ?? "";

  const run = async (work: () => Promise<ConfigStatus>) => {
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      dispatch({ type: "configStatus", config: await work() });
      setValue("");
      setUrl(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const saveKey = (key: string) => run(async () => {
    if (provider === "xai" || provider === "openrouter") return saveCredential(provider, key, false);
    return window.ogb?.setCredential && own
      ? window.ogb.setCredential(own.credential, key)
      : api("/api/config", { method: "PUT", body: JSON.stringify(own!.patch(key)) });
  });
  const saveUrl = () => run(async () => {
    const normalized = customUrl.trim() ? normalizeImageGenerationUrl(customUrl.trim()) : "";
    return api("/api/config", { method: "PUT", body: JSON.stringify({ imageGen: { customUrl: normalized } }) });
  });

  const test = async () => {
    setTesting(true);
    setVerdict(null);
    try {
      setVerdict(imageTestText(provider, await api<ImageProviderTest>("/api/images/test", { method: "POST", body: JSON.stringify({ provider }) })));
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card title={PROVIDER_LABEL[provider]}>
      <KeyState configured={configured} optional={provider === "custom"} />
      {shared && (
        <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
          {t(shared.note)}{" "}
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
            className="cursor-pointer text-accent hover:underline"
          >
            {t("imageGen.key.manage")}
          </button>
        </p>
      )}
      {provider === "custom" && (
        <div className="mb-2 flex gap-2">
          <input
            type="url"
            value={customUrl}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void saveUrl()}
            disabled={saving}
            placeholder="http://127.0.0.1:4000/v1"
            aria-label={t("imageGen.custom.url")}
            autoComplete="off"
            className={INPUT_CLASS}
          />
          <button type="button" onClick={() => void saveUrl()} disabled={saving || url === null} className={BUTTON_CLASS}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{t("common.save")}
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && value.trim() && void saveKey(value.trim())}
          disabled={saving}
          placeholder={configured ? t("keys.replace") : t("imageGen.key.paste")}
          aria-label={t((own ?? shared!).label)}
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
        />
        <button type="button" onClick={() => void saveKey(value.trim())} disabled={saving || !value.trim()} className={BUTTON_CLASS}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{t("common.save")}
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || saving}
            className="flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? t("keys.testing") : t("keys.test")}
          </button>
        )}
      </div>
      {verdict && <p role="status" className={cn("mt-1 text-[12px]", verdict.ok ? "text-success" : "text-danger")}>{verdict.text}</p>}
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
        {KEY_URL[provider] ? <a href={KEY_URL[provider]} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("imageGen.key.get")}</a> : <span>{t("imageGen.custom.help", { app: productName() })}</span>}
        {configured && (
          <button type="button" onClick={() => void saveKey("")} disabled={saving} className="cursor-pointer hover:text-danger disabled:opacity-50">
            {t("keys.removeKey")}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}

function KeyState({ configured, optional = false }: { configured: boolean; optional?: boolean }) {
  return (
    <div role="status" className="mb-2 flex items-center gap-2 text-[13px] text-ink-secondary">
      <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
      <span className={configured ? "text-success" : undefined}>
        {t(configured ? "imageGen.key.saved" : optional ? "imageGen.key.optional" : "imageGen.key.missing")}
      </span>
    </div>
  );
}
