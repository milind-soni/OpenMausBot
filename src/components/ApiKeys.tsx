// Paste-a-key rows. Packaged Electron saves secrets in the OS-backed store;
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, Plus, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type ConfigSection = "composio" | "box" | "opencodeGo" | "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras";
/** Sections whose key can be tried against the provider from the server. */
export type TestableProvider = "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras";

const SECTIONS: Record<
  ConfigSection,
  {
    /** `firstKey`: nothing was saved before this value. */
    body: (value: string, firstKey: boolean) => unknown;
    /** A key is saved. */
    flag: (config: ConfigStatus) => boolean;
    /** Works with no saved key: Cloud Pro includes it. */
    included?: (config: ConfigStatus) => boolean;
  }
> = {
  composio: {
    body: (v) => ({ composio: { apiKey: v } }),
    flag: (c) => c.composio.configured,
  },
  box: {
    body: (v) => ({ box: { token: v } }),
    flag: (c) => c.box.configured && c.box.included !== true,
    included: (c) => c.box.included === true,
  },
  opencodeGo: { body: (v) => ({ opencodeGo: { apiKey: v } }), flag: (c) => c.opencodeGo?.configured ?? false },
  // A key first saved here runs only "Claude (API key)"; signed-in Claude
  // bots stay on their plan unless the person turns that on below the row.
  anthropic: {
    body: (v, firstKey) => ({ anthropic: { key: v, ...(firstKey && v ? { everyClaudeBot: false } : {}) } }),
    flag: (c) => c.anthropic?.configured ?? false,
  },
  openai: { body: (v) => ({ openai: { key: v } }), flag: (c) => c.openai?.configured ?? false },
  openrouter: { body: (v) => ({ openrouter: { key: v } }), flag: (c) => c.openrouter?.configured ?? false },
  openaiCompat: { body: (v) => ({ openaiCompat: { key: v } }), flag: (c) => c.openaiCompat?.configured ?? false },
  mistral: { body: (v) => ({ mistral: { key: v } }), flag: (c) => c.mistral?.configured ?? false },
  cerebras: { body: (v) => ({ cerebras: { key: v } }), flag: (c) => c.cerebras?.configured ?? false },
  xai: { body: (v) => ({ xai: { key: v } }), flag: (c) => c.xai?.configured ?? false },
};

// Provider keys have no desktop-shell slot yet and go through the server's
// own 0600 config, the same place they live on a hosted server.
const ELECTRON_CREDENTIAL: Partial<Record<ConfigSection, "composioApiKey" | "boxToken" | "opencodeGoApiKey">> = {
  composio: "composioApiKey",
  box: "boxToken",
  opencodeGo: "opencodeGoApiKey",
};

const CREDENTIALS: Record<
  ConfigSection,
  {
    labelKey: LocaleKey;
    /** a literal placeholder that is not copy — an example key shape */
    placeholder?: string;
    placeholderKey?: LocaleKey;
    descriptionKey: LocaleKey;
    href: string;
    linkLabelKey: LocaleKey;
    optional: boolean;
    /** Shown under the field, not tucked into the help popover: it changes
     * what the key does to people's existing logins or bills. */
    warningKey?: LocaleKey;
    /** A quieter line under the field. */
    noteKey?: LocaleKey;
  }
> = {
  composio: {
    labelKey: "keys.composio.label",
    placeholder: "ak_…",
    descriptionKey: "keys.composio.desc",
    href: "https://dashboard.composio.dev",
    linkLabelKey: "keys.composio.link",
    optional: true,
  },
  box: {
    labelKey: "keys.boat.label",
    placeholderKey: "keys.boat.placeholder",
    descriptionKey: "keys.boat.desc",
    href: "https://docs.boat.dev/api-keys",
    linkLabelKey: "keys.boat.link",
    optional: true,
    warningKey: "keys.boat.warning",
  },
  opencodeGo: {
    labelKey: "keys.opencode.label",
    placeholderKey: "keys.opencode.placeholder",
    descriptionKey: "keys.opencode.desc",
    href: "https://opencode.ai/docs/providers/",
    linkLabelKey: "keys.opencode.link",
    optional: true,
  },
  anthropic: {
    labelKey: "keys.anthropic.label",
    placeholder: "sk-ant-…",
    descriptionKey: "keys.anthropic.desc",
    href: "https://console.anthropic.com/settings/keys",
    linkLabelKey: "keys.anthropic.link",
    optional: true,
  },
  openai: {
    labelKey: "keys.openai.label",
    placeholder: "sk-…",
    descriptionKey: "keys.openai.desc",
    href: "https://platform.openai.com/api-keys",
    linkLabelKey: "keys.openai.link",
    optional: true,
    noteKey: "keys.openai.note",
  },
  openrouter: {
    labelKey: "keys.openrouter.label",
    placeholder: "sk-or-v1-…",
    descriptionKey: "keys.openrouter.desc",
    href: "https://openrouter.ai/keys",
    linkLabelKey: "keys.openrouter.link",
    optional: true,
  },
  openaiCompat: {
    labelKey: "keys.openaiCompat.label",
    placeholderKey: "keys.openaiCompat.placeholder",
    descriptionKey: "keys.openaiCompat.desc",
    href: "https://platform.openai.com/docs/api-reference",
    linkLabelKey: "keys.openaiCompat.link",
    optional: true,
  },
  mistral: {
    labelKey: "keys.mistral.label",
    placeholderKey: "keys.mistral.placeholder",
    descriptionKey: "keys.mistral.desc",
    href: "https://console.mistral.ai/api-keys",
    linkLabelKey: "keys.mistral.link",
    optional: true,
  },
  cerebras: {
    labelKey: "keys.cerebras.label",
    placeholder: "csk-…",
    descriptionKey: "keys.cerebras.desc",
    href: "https://cloud.cerebras.ai/",
    linkLabelKey: "keys.cerebras.link",
    optional: true,
  },
  xai: {
    labelKey: "keys.xai.label",
    placeholder: "xai-…",
    descriptionKey: "keys.xai.desc",
    href: "https://console.x.ai",
    linkLabelKey: "keys.xai.link",
    optional: true,
  },
};

/** The catalog is read when a row renders, not when this module loads. */
function credentialCopy(section: ConfigSection) {
  const entry = CREDENTIALS[section];
  return {
    ...entry,
    label: t(entry.labelKey),
    placeholder: entry.placeholderKey ? t(entry.placeholderKey) : entry.placeholder ?? "",
    description: t(entry.descriptionKey),
    linkLabel: t(entry.linkLabelKey),
    warning: entry.warningKey ? t(entry.warningKey) : undefined,
    note: entry.noteKey ? t(entry.noteKey) : undefined,
  };
}

function CredentialHelp({ section }: { section: ConfigSection }) {
  const credential = credentialCopy(section);
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("keys.aboutAria", { label: credential.label })}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className="flex size-6 items-center justify-center rounded-md text-ink-secondary outline-none transition-colors hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {motion.shown && (
        <div
          id={popoverId}
          role="group"
          aria-label={t("keys.helpAria", { label: credential.label })}
          className={cn("absolute right-0 z-30 mt-1.5 w-[270px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl", motion.className)} {...motion.exitProps}
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{credential.description}</div>
          <a
            href={credential.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {credential.linkLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}

/** A paste saves at once, so a clipboard holding a sentence instead of the
 * key would otherwise be stored and then "rejected". No provider key or
 * token has spaces in it. */
export function looksLikeKey(value: string): boolean {
  return value.length > 0 && !/\s/.test(value);
}

export function ApiKeyRow({
  section,
  onSaved,
  testProvider,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
  /** Check the key against the provider as soon as it saves, and offer a
   * Test button to check the saved key again. */
  testProvider?: TestableProvider;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);
  const testGeneration = useRef(0);
  // A ref, not the state: blur and Enter can both fire before a re-render.
  const savingRef = useRef(false);
  const saveAfterPaste = useRef(false);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const included = state.config ? SECTIONS[section].included?.(state.config) === true : false;
  const clearing = !value.trim() && configured;
  const credential = credentialCopy(section);

  const test = async () => {
    if (!testProvider) return;
    setTesting(true);
    setVerdict(null);
    const generation = ++testGeneration.current;
    try {
      const result = await api("/api/keys/test", { method: "POST", body: JSON.stringify({ provider: testProvider }) });
      if (generation !== testGeneration.current) return;
      const outcome = result.ok
        ? result.check === "authentication" ? t("keys.testAuthenticated")
          : result.models?.length ? t("keys.testCatalog", { models: result.models.join(", ") }) : t("keys.testCatalogNoModels")
        : result.reason === "rejected" ? t("keys.testRejected")
          : result.reason === "unreachable" ? t("keys.testUnreachable")
            : t("keys.testUnexpected", { status: String(result.status ?? "?") });
      setVerdict(`${t("keys.testSaved")} ${outcome}`);
    } catch (cause) {
      if (generation === testGeneration.current) setVerdict(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === testGeneration.current) setTesting(false);
    }
  };

  /** Saves the draft, or removes the saved key when `remove` is set. */
  const save = (remove = false) => {
    const next = remove ? "" : value.trim();
    if (savingRef.current || (!remove && !next)) return;
    if (!remove && !looksLikeKey(next)) {
      setError(t("keys.notAKey"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    testGeneration.current++;
    setVerdict(null);
    const electronSlot = ELECTRON_CREDENTIAL[section];
    const request = window.ogb?.setCredential && electronSlot
      ? window.ogb.setCredential(electronSlot, next)
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify(SECTIONS[section].body(next, !configured)),
        });
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        const nowConfigured = SECTIONS[section].flag(status);
        onSaved?.(nowConfigured);
        if (next && nowConfigured) void test();
      })
      .catch((e) => setError(e.message))
      .finally(() => { savingRef.current = false; setSaving(false); });
  };

  // A paste is the whole key: save it once the field holds it.
  useEffect(() => {
    if (!saveAfterPaste.current) return;
    saveAfterPaste.current = false;
    save();
  });

  return (
    <div data-api-key-row={section}>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured || included ? "bg-success" : "bg-raised-hover")} />
        <span>{credential.label}</span>
        {credential.optional && (
          <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            {t("keys.optional")}
          </span>
        )}
        {configured && <span className="text-[11px] text-ink-secondary">{t("keys.configured")}</span>}
        {included && <span className="text-[11px] text-ink-secondary">{t("keys.includedWithCloudPro")}</span>}
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <div className="relative w-full">
          <input
            type="password"
            value={value}
            onChange={(e) => { testGeneration.current++; setVerdict(null); setError(null); setValue(e.target.value); }}
            onPaste={() => { saveAfterPaste.current = true; }}
            onBlur={() => save()}
            disabled={saving}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder={configured ? t("keys.replace") : credential.placeholder}
            aria-label={credential.label}
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          {(saving || testing) && (
            <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />
          )}
        </div>
        {clearing && (
          <button
            type="button"
            onClick={() => save(true)}
            disabled={saving}
            className="flex w-[72px] shrink-0 items-center justify-center rounded-lg bg-control py-2 text-[13px] text-danger hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            title={t("keys.removeKey")}
          >
            {t("keys.clear")}
          </button>
        )}
        {testProvider && clearing && (
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || saving}
            className="flex shrink-0 items-center justify-center rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? t("keys.testing") : t("keys.test")}
          </button>
        )}
      </div>
      {credential.warning && (
        <div className="mt-1.5 flex gap-1.5 text-[11.5px] leading-[1.4] text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>{credential.warning}</span>
        </div>
      )}
      {credential.note && <p className="mt-1.5 text-[11.5px] leading-[1.4] text-ink-secondary">{credential.note}</p>}
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
      {verdict && <div role="status" className="mt-1 text-[12px] text-ink-secondary">{verdict}</div>}
    </div>
  );
}

/** Whether the Anthropic key also runs signed-in Claude bots. Off, only
 * "Claude (API key)" bills per token; on, every Claude bot does. */
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
    <div data-anthropic-every-claude-bot className="-mt-2">
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink">
        <input type="checkbox" checked={on} disabled={saving} onChange={toggle} className="mt-0.5 accent-accent" />
        <span>
          {t("keys.anthropic.everyBot")}
          <span className="block text-[11.5px] leading-[1.4] text-ink-secondary">
            {on ? t("keys.anthropic.everyBotOn") : t("keys.anthropic.everyBotOff")}
          </span>
        </span>
      </label>
      {on && (
        <div className="mt-1.5 flex gap-1.5 text-[11.5px] leading-[1.4] text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>{t("keys.anthropic.warning")}</span>
        </div>
      )}
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
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

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ vps: { sshAlias: alias.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{t("keys.vps.label")}</span>
        <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          {t("keys.optional")}
        </span>
        {configured && <span className="text-[11px] text-success">{t("keys.connected")}</span>}
      </div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">
        {t("keys.vps.descBefore")}
        <a
          href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/byo-vps.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {t("keys.vps.descLink")}
        </a>
        {t("keys.vps.descAfter")}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label={t("keys.vps.aria")}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!alias.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            !alias.trim() && configured ? "bg-control text-danger hover:bg-raised-hover" : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={!alias.trim() && configured ? t("keys.vps.removeAlias") : t("common.save")}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && configured ? t("keys.clear") : <><Check size={13} />{t("common.save")}</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The OpenAI-compatible engine's base URL: a setting next to its key, so
 * OpenRouter, Groq, Together or OpenAI itself are one field away. Saves when
 * the field is left or Enter is pressed, like the key above it. */
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
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">{t("keys.openaiCompat.url")}</div>
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
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {saving && (
          <Loader2 size={13} aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{t("keys.openaiCompat.urlHint")}</p>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

type OpenAiCompatInstanceRow = {
  instanceId: string;
  displayName?: string;
  url?: string;
};

/** Extra OpenAI-compatible endpoints: each entry is its own engine instance
 * with its own key and base URL, selectable by every bot. Add, list and
 * remove here; the built-in openaiCompat slot above is unchanged. */
export function OpenAiCompatInstances() {
  const [rows, setRows] = useState<OpenAiCompatInstanceRow[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api("/api/instances")
      .then((data: { instances?: OpenAiCompatInstanceRow[] }) =>
        setRows(Array.isArray(data?.instances) ? data.instances : []),
      )
      .catch(() => setRows([]));
  }, []);

  const refresh = () =>
    void api("/api/instances")
      .then((data: { instances?: OpenAiCompatInstanceRow[] }) =>
        setRows(Array.isArray(data?.instances) ? data.instances : []),
      )
      .catch(() => {});

  const extras = (rows ?? []).filter((row) => {
    const driver = (row as { driver?: string }).driver;
    return driver === "openai-compat" && row.instanceId !== "openaiCompat";
  });

  const add = () => {
    if (busy || !name.trim() || !url.trim() || !key.trim()) return;
    if (/^https?:\/\//i.test(key.trim())) {
      setError(t("apiInstances.keyLooksLikeUrl"));
      return;
    }
    const modelList = models.split(",").map((m) => m.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    void api("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({ displayName: name.trim(), url: url.trim(), key: key.trim(), ...(modelList.length ? { models: modelList } : {}) }),
    })
      .then((data: { instances?: OpenAiCompatInstanceRow[] }) => {
        if (Array.isArray(data?.instances)) setRows(data.instances);
        setName("");
        setUrl("");
        setKey("");
        setModels("");
      })
      .catch((e: Error) => setError(e.message || t("apiInstances.failed")))
      .finally(() => setBusy(false));
  };

  const remove = (instanceId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" })
      .then(() => refresh())
      .catch((e: Error) => setError(e.message || t("apiInstances.failed")))
      .finally(() => setBusy(false));
  };

  const refreshModels = (instanceId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void api(`/api/instances/${encodeURIComponent(instanceId)}/refresh-models`, { method: "POST" })
      .then(() => refresh())
      .catch((e: Error) => setError(e.message || t("apiInstances.failed")))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">{t("apiInstances.title")}</div>
      <p className="mb-2 text-[11.5px] leading-relaxed text-ink-secondary">{t("apiInstances.subtitle")}</p>
      {rows !== null && extras.length === 0 && (
        <p className="text-[11.5px] text-ink-secondary">{t("apiInstances.empty")}</p>
      )}
      {extras.map((row) => (
        <div
          key={row.instanceId}
          className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-[12px] text-ink">{row.displayName || row.instanceId}</div>
            {row.url && <div className="truncate font-mono text-[11px] text-ink-secondary">{row.url}</div>}
          </div>
          <button
            type="button"
            onClick={() => refreshModels(row.instanceId)}
            disabled={busy}
            aria-label={t("apiInstances.refreshModels")}
            title={t("apiInstances.refreshModels")}
            className="shrink-0 rounded-md px-2 py-1 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-50"
          >
            <RotateCw size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => remove(row.instanceId)}
            disabled={busy}
            aria-label={t("apiInstances.remove")}
            title={t("apiInstances.remove")}
            className="shrink-0 rounded-md px-2 py-1 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="mt-2 flex flex-col gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("apiInstances.name")}
          aria-label={t("apiInstances.name")}
          spellCheck={false}
          disabled={busy}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          aria-label={t("apiInstances.url")}
          spellCheck={false}
          disabled={busy}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("apiInstances.key")}
          type="password"
          aria-label={t("apiInstances.key")}
          disabled={busy}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={models}
          onChange={(e) => setModels(e.target.value)}
          placeholder={t("apiInstances.modelsPlaceholder")}
          aria-label={t("apiInstances.models")}
          spellCheck={false}
          disabled={busy}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <p className="text-[11px] leading-relaxed text-ink-secondary">{t("apiInstances.keyHint")}</p>
        <button
          type="button"
          onClick={add}
          disabled={busy || !name.trim() || !url.trim() || !key.trim()}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink hover:bg-inset disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
          ) : (
            <Plus size={12} aria-hidden="true" />
          )}
          {busy ? t("apiInstances.adding") : t("apiInstances.add")}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
