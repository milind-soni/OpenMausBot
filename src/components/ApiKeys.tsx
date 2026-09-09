// Paste-a-key rows. Packaged Electron saves secrets in the OS-backed store;
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type ConfigSection = "composio" | "box" | "opencodeGo";

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
};

const ELECTRON_CREDENTIAL: Record<ConfigSection, "composioApiKey" | "boxToken" | "opencodeGoApiKey"> = {
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
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;
  const credential = credentialCopy(section);

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential(ELECTRON_CREDENTIAL[section], value.trim())
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
      </div>
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
