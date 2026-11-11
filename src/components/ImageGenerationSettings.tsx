import { useEffect, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { IMAGE_DEFAULT_MODELS, IMAGE_MAX_PER_TURN_DEFAULT, IMAGE_MODEL_CHOICES, IMAGE_PROVIDERS, normalizeImageGenerationUrl, type ImageProvider, type ImageProviderTest } from "../../shared/image-generation";
import { saveCredential } from "./keys/key-save";
import { LearnMore, SETTINGS_INLINE_INPUT, SETTINGS_INPUT, SettingRow, SettingsField, SettingsFormFoot, SettingsGroup, SettingsRows, StatusDot } from "./SettingsPrimitives";
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
  const [more, setMore] = useState(false);
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

  const statusText = status?.ready
    ? primary.configured
      ? t("imageGen.status.ready", { provider: PROVIDER_LABEL[primary.provider] })
      : t("imageGen.status.backupOnly", { provider: PROVIDER_LABEL[fallback!.provider] })
    : t("imageGen.status.notReady");
  return (
    <>
      <SettingsGroup label={t("settings.ai.images")} block="images"
        description={<>{t("imageGen.introShort")}{" "}<LearnMore onClick={() => setMore((open) => !open)} /></>}
        footnote={<span role="status" data-testid="image-gen-status" className="inline-flex items-center">
          {status?.ready ? <StatusDot tone={primary.configured ? "success" : "warning"} /> : <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}
          {statusText}
        </span>}>
        {more && <p data-image-gen-more="" className="px-4 text-[12px] leading-4 text-ink-secondary">{t("imageGen.intro")}</p>}
        <SettingsRows selectWidth={200}>
          <SlotRow
            slot="primary" provider={primary.provider} model={primary.model} configured={primary.configured} openrouterModels={openrouterModels}
            disabled={saving || !state.config} onProvider={chooseProvider} onModel={(model) => void save({ imageGen: { primary: { provider: primary.provider, model } } })}
          />
          <SlotRow
            slot="fallback" provider={fallback?.provider ?? null} model={fallback?.model ?? ""} configured={fallback?.configured === true} exclude={primary.provider} openrouterModels={openrouterModels}
            disabled={saving || !state.config} onProvider={chooseProvider} onModel={(model) => fallback && void save({ imageGen: { fallback: { provider: fallback.provider, model } } })}
          />
          <SettingRow title={t("imageGen.maxPerTurn.label")} subtitle={t("imageGen.maxPerTurn.help")} message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
            <Select
              data-testid="image-gen-max"
              value={String(status?.maxPerTurn ?? IMAGE_MAX_PER_TURN_DEFAULT)}
              onChange={(event) => void save({ imageGen: { maxPerTurn: Number(event.target.value) } })}
              disabled={saving || !state.config}
              aria-label={t("imageGen.maxPerTurn.label")}
            >
              {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
            </Select>
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>

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
            className={cn(SETTINGS_INLINE_INPUT, "w-[200px] text-left")}
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

  const keyState = t(configured ? "imageGen.key.saved" : provider === "custom" ? "imageGen.key.optional" : "imageGen.key.missing");
  return (
    <SettingsGroup label={PROVIDER_LABEL[provider]} block={`images-${provider}`}>
      <SettingsRows>
        <div className="flex flex-col gap-3 px-4 pb-1 pt-3">
          {provider === "custom" && (
            <SettingsField label={t("imageGen.custom.url")}>
              <input
                type="url"
                value={customUrl}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void saveUrl()}
                onBlur={() => url !== null && void saveUrl()}
                disabled={saving}
                placeholder="http://127.0.0.1:4000/v1"
                autoComplete="off"
                className={SETTINGS_INPUT}
              />
            </SettingsField>
          )}
          <SettingsField label={t((own ?? shared!).label)}>
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
              className={SETTINGS_INPUT}
            />
          </SettingsField>
          <p className="text-[13px] leading-[18px] text-ink-secondary">
            {shared && <>{t(shared.note)}{" "}
              <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
                className="cursor-pointer text-accent-text hover:underline">{t("imageGen.key.manage")}</button>{" "}</>}
            {KEY_URL[provider] ? <a href={KEY_URL[provider]} target="_blank" rel="noreferrer" className="text-accent-text hover:underline focus-visible:underline">{t("imageGen.key.get")}</a> : t("imageGen.custom.help", { app: productName() })}
          </p>
        </div>
        <SettingsFormFoot status={<span className="flex flex-col gap-1">
          <span role="status" className="flex items-center">{configured ? <StatusDot tone="success" /> : <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}{keyState}</span>
          {verdict && <span role="status" className={verdict.ok ? "text-ink-secondary" : "text-danger"}>{verdict.text}</span>}
          {error && <span role="alert" className="text-danger">{error}</span>}
        </span>}>
          {configured && <button type="button" onClick={() => void saveKey("")} disabled={saving} data-danger="" className="settings-quiet cursor-pointer">{t("keys.removeKey")}</button>}
          {configured && <button type="button" onClick={() => void test()} disabled={testing || saving} className="ui-button ui-button-md cursor-pointer rounded-full">{testing ? t("keys.testing") : t("keys.test")}</button>}
          <button type="button" onClick={() => void saveKey(value.trim())} disabled={saving || !value.trim()} className="ui-button ui-button-md cursor-pointer rounded-full">
            {saving ? t("settings.threads.saving") : t("common.save")}
          </button>
        </SettingsFormFoot>
      </SettingsRows>
    </SettingsGroup>
  );
}
