import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { normalizeImageGenerationUrl, type AvatarImageProvider } from "../../shared/image-generation";

// Provider names are brand names and stay verbatim; the key label and the
// pricing note beside them are copy, so they travel as keys.
const PROVIDERS = {
  openai: { label: "OpenAI", keyLabelKey: "avatarGen.keyOpenai", hintKey: "avatarGen.hintOpenai", credential: "openaiImageApiKey" },
  xai: { label: "Grok (xAI)", keyLabelKey: "avatarGen.keyXai", hintKey: "avatarGen.hintXai", credential: "xaiApiKey" },
  custom: { labelKey: "avatarGen.providerCustom", keyLabelKey: "avatarGen.keyCustom", hintKey: "avatarGen.hintCustom", credential: "customImageApiKey" },
} as const satisfies Record<string, { label?: string; labelKey?: LocaleKey; keyLabelKey: LocaleKey; hintKey: LocaleKey; credential: string }>;

const INPUT_CLASS = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50";
const BUTTON_CLASS = "flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50";

export function AvatarImageGenerator({
  botLabel,
  disabled,
  generating,
  onGenerate,
  onSavingChange,
}: {
  botLabel: string;
  disabled: boolean;
  generating: boolean;
  onGenerate: (direction: string) => Promise<void>;
  onSavingChange: (saving: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const imageGen = state.config?.imageGen;
  const savedProvider = imageGen?.provider ?? "openai";
  // Null means follow the shared configuration. Drafts stay local until saved.
  const [providerDraft, setProviderDraft] = useState<AvatarImageProvider | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState("");
  const [direction, setDirection] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providerDraft ?? savedProvider;
  const customUrl = urlDraft ?? imageGen?.customUrl ?? "";
  const customModel = modelDraft ?? imageGen?.customModel ?? "";
  const providerInfo = PROVIDERS[provider];
  const busy = disabled || generating || saving;
  const keyConfigured = provider === "custom"
    ? imageGen?.customKeyConfigured === true
    : provider === "xai"
      ? (imageGen?.xaiConfigured ?? state.config?.xai?.configured) === true
      : (imageGen?.openaiConfigured ?? (savedProvider === "openai" && imageGen?.configured)) === true;
  const settingsDirty = provider !== savedProvider || (provider === "custom" && (
    customUrl.trim() !== (imageGen?.customUrl ?? "") ||
    customModel.trim() !== (imageGen?.customModel ?? "")
  ));
  const unsaved = settingsDirty || !!imageKey.trim();
  const configured = provider === savedProvider && imageGen?.configured === true;

  useEffect(() => {
    setImageKey("");
  }, [provider]);

  const setPending = (pending: boolean) => {
    setSaving(pending);
    onSavingChange(pending);
  };

  const saveConfig = async (patch: object) => {
    const status: ConfigStatus = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    dispatch({ type: "configStatus", config: status });
  };

  const saveCredential = async (key: string) => {
    const status: ConfigStatus = window.ogb?.setCredential
      ? await window.ogb.setCredential(providerInfo.credential, key)
      : await api("/api/config", {
          method: "PUT",
          body: JSON.stringify(provider === "xai"
            ? { xai: { key } }
            : { imageGen: provider === "custom" ? { customApiKey: key } : { key } }),
        });
    dispatch({ type: "configStatus", config: status });
    setImageKey("");
  };

  const chooseProvider = async (next: AvatarImageProvider) => {
    if (busy) return;
    setProviderDraft(next);
    setImageKey("");
    setUrlDraft(null);
    setModelDraft(null);
    setError(null);
    // Custom connections need an explicit save after their address/model is set.
    if (next === "custom") return;
    setPending(true);
    try {
      await saveConfig({ imageGen: { provider: next } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setProviderDraft(null);
      setPending(false);
    }
  };

  const saveConnection = async () => {
    if (busy || (provider === "custom" && (!customUrl.trim() || !customModel.trim()))) return;
    if (provider !== "custom" && !imageKey.trim()) return;
    setPending(true);
    setError(null);
    try {
      // Validate the whole connection before replacing its stored credential.
      const url = provider === "custom" ? normalizeImageGenerationUrl(customUrl.trim()) : "";
      const model = customModel.trim();
      if (provider === "custom" && (model.length > 200 || ["\r", "\n", "\0"].some((character) => model.includes(character)))) {
        throw new Error(t("avatarGen.modelError"));
      }
      if (imageKey.trim()) await saveCredential(imageKey.trim());
      if (provider === "custom") {
        await saveConfig({ imageGen: {
          provider,
          customUrl: url,
          customModel: model,
        } });
        setProviderDraft(null);
        setUrlDraft(null);
        setModelDraft(null);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setPending(false);
    }
  };

  const removeKey = async () => {
    if (busy) return;
    setPending(true);
    setError(null);
    try {
      await saveCredential("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setPending(false);
    }
  };

  const connectionForm = (
    <div className="space-y-2.5">
      {provider === "custom" && (
        <>
          <label className="block text-[11.5px] text-ink-secondary">
            {t("avatarGen.baseUrl")}
            <input
              type="url"
              value={customUrl}
              disabled={busy}
              onChange={(event) => setUrlDraft(event.target.value)}
              placeholder="http://127.0.0.1:4000/v1"
              autoComplete="off"
              className={`${INPUT_CLASS} mt-1`}
            />
          </label>
          <label className="block text-[11.5px] text-ink-secondary">
            {t("avatarGen.imageModel")}
            <input
              value={customModel}
              disabled={busy}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder={t("avatarGen.modelPlaceholder")}
              autoComplete="off"
              className={`${INPUT_CLASS} mt-1`}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-ink-secondary">
            {t("avatarGen.compatNote")}
          </p>
        </>
      )}
      <label className="block text-[11.5px] text-ink-secondary">
        {t(providerInfo.keyLabelKey)}{provider === "custom" ? t("avatarGen.keyOptional") : ""}
        <input
          type="password"
          value={imageKey}
          disabled={busy}
          onChange={(event) => setImageKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveConnection();
            }
          }}
          placeholder={t(keyConfigured ? "avatarGen.keySaved" : provider === "custom" ? "avatarGen.keyBlank" : "avatarGen.keyPaste")}
          autoComplete="off"
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      {provider === "xai" && (
        <p className="text-[11px] leading-relaxed text-ink-secondary">{t("avatarGen.xaiNote")}</p>
      )}
      {provider === "custom" && keyConfigured && (
        <p className="text-[11px] leading-relaxed text-ink-secondary">{t("avatarGen.customKeyNote")}</p>
      )}
      <div className="flex items-center justify-end gap-2">
        {keyConfigured && (
          <button type="button" onClick={() => void removeKey()} disabled={busy} className="mr-auto rounded-md py-1.5 text-[11.5px] text-ink-secondary hover:text-danger disabled:opacity-50">
            {t("avatarGen.removeKey")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveConnection()}
          disabled={busy || (provider === "custom" ? !customUrl.trim() || !customModel.trim() || (!unsaved && configured) : !imageKey.trim())}
          className={BUTTON_CLASS}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {t(provider === "custom" ? "avatarGen.saveConnection" : "avatarGen.saveKey")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="mt-5 border-t border-hairline/40 pt-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Sparkles size={14} className="text-accent" /> {t("avatarCard.generateWith")}
      </div>
      <label className="mt-3 block text-[11.5px] text-ink-secondary">
        {t("avatarGen.provider")}
        <select value={provider} onChange={(event) => void chooseProvider(event.target.value as AvatarImageProvider)} disabled={busy || !state.config} className={`${INPUT_CLASS} mt-1`}>
          {Object.entries(PROVIDERS).map(([value, info]) => <option key={value} value={value}>{"label" in info ? info.label : t(info.labelKey)}</option>)}
        </select>
      </label>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">
        {t(providerInfo.hintKey)}
        {" "}{t("avatarGen.hintShared")}
      </p>

      {configured ? (
        <details key={provider} className="mt-3 rounded-lg border border-hairline/40 px-3 py-2">
          <summary className="cursor-pointer text-[11.5px] text-ink-secondary">{t("avatarGen.connectionSettings")}</summary>
          <div className="mt-3">{connectionForm}</div>
        </details>
      ) : <div className="mt-3">{connectionForm}</div>}

      <textarea
        value={direction}
        disabled={busy}
        onChange={(event) => setDirection(event.target.value.slice(0, 400))}
        maxLength={400}
        placeholder={t("avatarCard.directionPlaceholder", { name: botLabel })}
        aria-label={t("avatarCard.directionAria")}
        className={`${INPUT_CLASS} mt-3 min-h-[72px] resize-none`}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] tabular-nums text-ink-secondary">{direction.length}/400</span>
        <button
          type="button"
          onClick={() => {
            if (!busy && configured && !unsaved) {
              setError(null);
              void onGenerate(direction.trim());
            }
          }}
          disabled={busy || !configured || unsaved}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {t(generating ? "avatarCard.generating" : "avatarCard.generate")}
        </button>
      </div>
      {unsaved && <p role="status" className="mt-2 text-[11px] text-ink-secondary">{t("avatarGen.saveFirst")}</p>}
      {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
