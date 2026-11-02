import { useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Switch } from "../SettingsPrimitives";
import { KEY_FIELD } from "./KeyRow";
import { cleanKey, looksLikeKey } from "./key-save";

/** Security: write-only; the server returns names, never keys, and hands the keys to OpenCode alone. */
export function OpenCodeProviderKeys() {
  const { state, dispatch } = useStore();
  const names = state.config?.opencodeGo?.providerKeys ?? [];
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = adding || removing !== null;

  const put = (target: string, value: string) =>
    api("/api/config", { method: "PUT", body: JSON.stringify({ opencodeGo: { providerKeys: { [target]: value } } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }));

  const add = () => {
    const target = name.trim().toUpperCase();
    const value = cleanKey(key);
    if (busy || !target || !value) return;
    if (!looksLikeKey(value)) {
      setError(t("keys.notAKey"));
      return;
    }
    setAdding(true);
    setError(null);
    put(target, value)
      .then(() => { setName(""); setKey(""); })
      .catch((e) => setError(e.message))
      .finally(() => setAdding(false));
  };

  const remove = (target: string) => {
    if (busy) return;
    setRemoving(target);
    setError(null);
    put(target, "")
      .catch((e) => setError(e.message))
      .finally(() => setRemoving(null));
  };

  return (
    <div data-opencode-provider-keys className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.opencode.otherProviders.hint")}</p>
      {state.config?.cloudHome !== true && (
        <p className="text-[12px] leading-4 text-ink-secondary">
          {t("keys.opencode.providersHint").split("{command}").flatMap((part, index) =>
            index === 0 ? [part] : [<code key={index} className="font-mono">opencode auth login</code>, part])}
        </p>
      )}
      {names.map((saved) => (
        <div key={saved} data-opencode-provider-key={saved} className="flex flex-wrap items-center gap-2">
          <span className={cn(KEY_FIELD, "block flex-1 truncate text-ink")}>{saved}</span>
          <button
            type="button"
            onClick={() => remove(saved)}
            disabled={busy}
            aria-label={t("keys.opencode.otherProviders.removeAria", { name: saved })}
            className="ui-button shrink-0"
          >
            {removing === saved ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("keys.row.remove")}
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => { setError(null); setName(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={busy}
          placeholder="VENICE_API_KEY"
          aria-label={t("keys.opencode.otherProviders.name")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,10rem)] flex-1 uppercase placeholder:normal-case")}
        />
        <input
          type="password"
          value={key}
          onChange={(e) => { setError(null); setKey(e.target.value); }}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={busy}
          placeholder={t("keys.opencode.otherProviders.keyPlaceholder")}
          aria-label={t("keys.opencode.otherProviders.key")}
          autoComplete="off"
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,10rem)] flex-1")}
        />
        <button type="button" onClick={add} disabled={busy || !name.trim() || !key.trim()} className="ui-button ui-button-primary shrink-0">
          {adding ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("common.save")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function AnthropicEveryClaudeBot() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state.config?.anthropic?.configured) return null;
  const on = state.config.anthropic.everyClaudeBot === true;
  const toggle = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ anthropic: { everyClaudeBot: !on } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };
  return (
    <div data-anthropic-every-claude-bot className="flex flex-col gap-1.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[18px] text-ink">{t("keys.anthropic.everyBot")}</div>
          <div className="text-[12px] leading-4 text-ink-secondary">{on ? t("keys.anthropic.everyBotOn") : t("keys.anthropic.everyBotOff")}</div>
        </div>
        <Switch checked={on} disabled={saving} onClick={toggle} aria-label={t("keys.anthropic.everyBot")} />
      </div>
      {on && (
        <p className="flex gap-1.5 text-[12px] leading-4 text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>{t("keys.anthropic.warning")}</span>
        </p>
      )}
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);
  const clearing = !alias.trim() && configured;

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ vps: { sshAlias: alias.trim() } }) })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-4 text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/byo-vps.md" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-key-input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label={t("keys.vps.aria")}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "w-auto min-w-[min(100%,12rem)] flex-1")}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || (!alias.trim() && !configured) || alias.trim() === (state.config?.vps?.sshAlias ?? "")}
          className={cn("ui-button shrink-0", !clearing && "ui-button-primary")}
          title={clearing ? t("keys.vps.removeAlias") : undefined}
        >
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : clearing ? t("keys.row.remove") : t("common.save")}
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function OpenAiCompatUrl() {
  const { state, dispatch } = useStore();
  const saved = state.config?.openaiCompat?.url ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  useEffect(() => { setValue(saved); }, [saved]);
  const dirty = value.trim() !== saved;

  const save = () => {
    if (savingRef.current || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ openaiCompat: { url: value.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[13px] leading-[18px] text-ink">{t("keys.openaiCompat.url")}</div>
      <div className="relative">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="https://api.groq.com/openai/v1"
          aria-label={t("keys.openaiCompat.url")}
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-8")}
        />
        {saving && <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />}
      </div>
      <p className="text-[12px] leading-4 text-ink-secondary">{t("keys.openaiCompat.urlHint")}</p>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}
