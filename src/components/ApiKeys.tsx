// Paste-a-key rows. Packaged Electron saves secrets in the OS-backed store;
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type ConfigSection = "composio" | "box" | "opencodeGo" | "anthropic" | "openaiCompat" | "xai" | "vision" | "dictation";
/** Sections whose key can be tried against the provider from the server. */
export type TestableProvider = "anthropic" | "openaiCompat" | "xai";

const SECTIONS: Record<
  ConfigSection,
  { body: (value: string) => unknown; flag: (config: ConfigStatus) => boolean }
> = {
  composio: {
    body: (v) => ({ composio: { apiKey: v } }),
    flag: (c) => c.composio.configured,
  },
  box: { body: (v) => ({ box: { token: v } }), flag: (c) => c.box.configured },
  opencodeGo: { body: (v) => ({ opencodeGo: { apiKey: v } }), flag: (c) => c.opencodeGo?.configured ?? false },
  anthropic: { body: (v) => ({ anthropic: { key: v } }), flag: (c) => c.anthropic?.configured ?? false },
  openaiCompat: { body: (v) => ({ openaiCompat: { key: v } }), flag: (c) => c.openaiCompat?.configured ?? false },
  xai: { body: (v) => ({ xai: { key: v } }), flag: (c) => c.xai?.configured ?? false },
  vision: { body: (v) => ({ vision: { key: v } }), flag: (c) => c.vision?.configured ?? false },
  dictation: { body: (v) => ({ dictation: { key: v } }), flag: (c) => c.dictation?.configured ?? false },
};

// Provider keys have no desktop-shell slot yet and go through the server's
// own 0600 config, the same place they live on a hosted server.
const ELECTRON_CREDENTIAL: Partial<Record<ConfigSection, "composioApiKey" | "boxToken" | "opencodeGoApiKey" | "visionApiKey" | "dictationApiKey">> = {
  composio: "composioApiKey",
  box: "boxToken",
  opencodeGo: "opencodeGoApiKey",
  vision: "visionApiKey",
  dictation: "dictationApiKey",
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
    warningKey?: LocaleKey;
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
    labelKey: "keys.box.label",
    placeholderKey: "keys.box.placeholder",
    descriptionKey: "keys.box.desc",
    href: "https://docs.ascii.dev/box/api-keys",
    linkLabelKey: "keys.box.link",
    optional: true,
    warningKey: "keys.box.warning",
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
  openaiCompat: {
    labelKey: "keys.openaiCompat.label",
    placeholder: "sk-or-v1-…",
    descriptionKey: "keys.openaiCompat.desc",
    href: "https://openrouter.ai/keys",
    linkLabelKey: "keys.openaiCompat.link",
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
  vision: {
    labelKey: "keys.vision.label",
    placeholder: "flm-…",
    descriptionKey: "keys.vision.desc",
    href: "https://github.com/freellmapi/freellmapi",
    linkLabelKey: "keys.vision.link",
    optional: true,
  },
  dictation: {
    labelKey: "keys.dictation.label",
    placeholder: "dg-…",
    descriptionKey: "keys.dictation.desc",
    href: "https://console.deepgram.com",
    linkLabelKey: "keys.dictation.link",
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
  };
}

function CredentialHelp({ section }: { section: ConfigSection }) {
  const credential = credentialCopy(section);
  const [open, setOpen] = useState(false);
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
      {open && (
        <div
          id={popoverId}
          role="group"
          aria-label={t("keys.helpAria", { label: credential.label })}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[270px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{credential.description}</div>
          {credential.warning && (
            <div className="mt-2 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>{credential.warning}</span>
            </div>
          )}
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

export function ApiKeyRow({
  section,
  onSaved,
  testProvider,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
  /** Offer a Test button that tries the saved key against the provider. */
  testProvider?: TestableProvider;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;
  const credential = credentialCopy(section);

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    const electronSlot = ELECTRON_CREDENTIAL[section];
    setVerdict(null);
    const request = window.ogb?.setCredential && electronSlot
      ? window.ogb.setCredential(electronSlot, value.trim())
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify(SECTIONS[section].body(value.trim())),
        });
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].flag(status));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const test = async () => {
    if (!testProvider || testing) return;
    setTesting(true);
    setVerdict(null);
    try {
      // A pasted, unsaved key is tried as typed; otherwise the saved one.
      const result = await api("/api/keys/test", { method: "POST", body: JSON.stringify({ provider: testProvider, ...(value.trim() ? { key: value.trim() } : {}) }) });
      setVerdict(
        result.ok
          ? result.models?.length ? t("keys.testOk", { models: result.models.join(", ") }) : t("keys.testOkNoModels")
          : result.reason === "rejected" ? t("keys.testRejected")
            : result.reason === "unreachable" ? t("keys.testUnreachable")
              : t("keys.testUnexpected", { status: String(result.status ?? "?") }),
      );
    } catch (cause) {
      setVerdict(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{credential.label}</span>
        {credential.optional && (
          <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            {t("keys.optional")}
          </span>
        )}
        {configured && <span className="text-[11px] text-success">{t("keys.connected")}</span>}
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={configured ? t("keys.replace") : credential.placeholder}
          aria-label={credential.label}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing
              ? "bg-control text-danger hover:bg-raised-hover"
              : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={clearing ? t("keys.removeKey") : t("common.save")}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? t("keys.clear") : <><Check size={13} />{t("common.save")}</>}
        </button>
        {testProvider && (configured || value.trim()) && (
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
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
      {verdict && <div role="status" className="mt-1 text-[12px] text-ink-secondary">{verdict}</div>}
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
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
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

/** The Vision engine's base URL: a setting next to its key, so a local
 * freellmapi proxy and a hosted one are one field away. */
export function VisionUrl() {
  const { state, dispatch } = useStore();
  const saved = state.config?.vision?.url ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(saved); }, [saved]);
  const dirty = value.trim() !== saved;

  const save = () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ vision: { url: value.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">{t("keys.vision.url")}</div>
      <div className="flex gap-2">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="http://localhost:3001/v1"
          aria-label={t("keys.vision.url")}
          spellCheck={false}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("common.save")}</>}
        </button>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{t("keys.vision.urlHint")}</p>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The OpenAI-compatible engine's base URL: a setting next to its key, so
 * OpenRouter, Groq, Together or OpenAI itself are one field away. */
export function OpenAiCompatUrl() {
  const { state, dispatch } = useStore();
  const saved = state.config?.openaiCompat?.url ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(saved); }, [saved]);
  const dirty = value.trim() !== saved;

  const save = () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ openaiCompat: { url: value.trim() } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">{t("keys.openaiCompat.url")}</div>
      <div className="flex gap-2">
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="https://openrouter.ai/api/v1"
          aria-label={t("keys.openaiCompat.url")}
          spellCheck={false}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />{t("common.save")}</>}
        </button>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{t("keys.openaiCompat.urlHint")}</p>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
