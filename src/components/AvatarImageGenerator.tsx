import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { normalizeImageGenerationUrl, type AvatarImageProvider } from "../../shared/image-generation";

const PROVIDERS = {
  openai: { label: "OpenAI", keyLabel: "OpenAI image API key", credential: "openaiImageApiKey" },
  xai: { label: "Grok (xAI)", keyLabel: "Grok API key", credential: "xaiApiKey" },
  custom: { label: "Custom", keyLabel: "Custom image API key", credential: "customImageApiKey" },
} as const;

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
        throw new Error("Use a model ID of at most 200 characters without control characters");
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
            Base URL
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
            Image model
            <input
              value={customModel}
              disabled={busy}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder="Model ID from your image provider"
              autoComplete="off"
              className={`${INPUT_CLASS} mt-1`}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-ink-secondary">
            OpenAI-compatible Images API. localhost refers to the OpenMausBot server, including when you open this page remotely.
          </p>
        </>
      )}
      <label className="block text-[11.5px] text-ink-secondary">
        {providerInfo.keyLabel}{provider === "custom" ? " (optional)" : ""}
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
          placeholder={keyConfigured ? "Saved key · paste to replace" : provider === "custom" ? "Leave blank for a keyless connection" : "Paste API key"}
          autoComplete="off"
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      {provider === "xai" && (
        <p className="text-[11px] leading-relaxed text-ink-secondary">Shares the Grok API key in Settings. Changing or removing it also affects other Grok features.</p>
      )}
      {provider === "custom" && keyConfigured && (
        <p className="text-[11px] leading-relaxed text-ink-secondary">The saved custom key will be used. Remove it for a keyless connection.</p>
      )}
      <div className="flex items-center justify-end gap-2">
        {keyConfigured && (
          <button type="button" onClick={() => void removeKey()} disabled={busy} className="mr-auto rounded-md py-1.5 text-[11.5px] text-ink-secondary hover:text-danger disabled:opacity-50">
            Remove saved key
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveConnection()}
          disabled={busy || (provider === "custom" ? !customUrl.trim() || !customModel.trim() || (!unsaved && configured) : !imageKey.trim())}
          className={BUTTON_CLASS}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {provider === "custom" ? "Save connection" : "Save key"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="mt-5 border-t border-hairline/40 pt-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Sparkles size={14} className="text-accent" /> Generate with AI
      </div>
      <label className="mt-3 block text-[11.5px] text-ink-secondary">
        Image provider
        <select value={provider} onChange={(event) => void chooseProvider(event.target.value as AvatarImageProvider)} disabled={busy || !state.config} className={`${INPUT_CLASS} mt-1`}>
          {Object.entries(PROVIDERS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
        </select>
      </label>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">
        {provider === "openai" ? "GPT Image 2 · low-quality square draft. Billed to your OpenAI API account."
          : provider === "xai" ? "Grok Imagine · API billing is separate from your Grok subscription."
            : "Connect a local router or image provider."}
        {" "}This connection is shared by all bot avatars.
      </p>

      {configured ? (
        <details key={provider} className="mt-3 rounded-lg border border-hairline/40 px-3 py-2">
          <summary className="cursor-pointer text-[11.5px] text-ink-secondary">Connection settings</summary>
          <div className="mt-3">{connectionForm}</div>
        </details>
      ) : <div className="mt-3">{connectionForm}</div>}

      <textarea
        value={direction}
        disabled={busy}
        onChange={(event) => setDirection(event.target.value.slice(0, 400))}
        maxLength={400}
        placeholder={`Optional direction, e.g. “a calm navigator inspired by ${botLabel}”`}
        aria-label="Avatar generation direction"
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
          {generating ? "Generating…" : "Generate avatar"}
        </button>
      </div>
      {unsaved && <p role="status" className="mt-2 text-[11px] text-ink-secondary">Save your connection changes before generating.</p>}
      {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
