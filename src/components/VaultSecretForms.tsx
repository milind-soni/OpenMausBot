import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2, LockKeyhole } from "lucide-react";

import type { LoginBots } from "../../shared/logins";
import { VAULT_SECRET_NAME_MAX, type VaultSecret } from "../../shared/vault";
import { t } from "@/lib/i18n";
import { addSecret, changeSecret, importEnv, parseEnv } from "@/lib/vault";
import { LoginBotPicker } from "./LoginForm";

// Security: what was typed is dropped once saved, and a saved value is never shown: it can only be replaced.

const FIELD = "w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";
const LABEL = "flex flex-col gap-1 text-[12px] font-medium text-ink-secondary";

type Bots = ReadonlyArray<{ id: string; name: string }>;

function Shell({ onSubmit, onCancel, pending, error, submitLabel, children, form }: {
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
  submitLabel: string;
  children: ReactNode;
  form: string;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2.5" aria-busy={pending} {...{ [`data-${form}`]: "" }}>
      {children}
      <p className="flex items-start gap-1 text-[12px] leading-snug text-ink-tertiary">
        <LockKeyhole size={11} aria-hidden="true" className="mt-[3px] shrink-0" /> {t("settings.vault.secret.private")}
      </p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className="ui-button ui-button-md">{t("logins.cancel")}</button>
        <button type="submit" disabled={pending} className="ui-button ui-button-md ui-button-primary inline-flex items-center gap-1.5">
          {pending && <Loader2 size={13} className="animate-spin" />}{submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Adds a secret, or changes one: its name, its value (empty keeps the saved one) and who may use it. */
export function SecretForm({ secret, bots, onCancel, onSaved }: { secret?: VaultSecret; bots: Bots; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(secret?.name ?? "");
  const [value, setValue] = useState("");
  const [who, setWho] = useState<LoginBots>(secret?.bots ?? "all");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (secret) await changeSecret(secret.id, { ...(name.trim() !== secret.name ? { name: name.trim() } : {}), value, bots: who });
      else await addSecret(name.trim(), value, who);
      setValue("");
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("settings.vault.secret.saveError"));
    } finally {
      setPending(false);
    }
  };
  return (
    <Shell form="secret-form" onSubmit={(event) => void submit(event)} onCancel={onCancel} pending={pending} error={error}
      submitLabel={t(secret ? "settings.logins.saveChange" : "settings.vault.secret.save")}>
      <label className={LABEL}>
        {t("settings.vault.secret.name")}
        <input name="secretName" type="text" autoComplete="off" spellCheck={false} required maxLength={VAULT_SECRET_NAME_MAX} value={name} autoFocus
          placeholder={t("settings.vault.secret.namePlaceholder")} onChange={(event) => setName(event.target.value)} disabled={pending} className={FIELD} />
        <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("settings.vault.secret.nameHint")}</span>
      </label>
      <label className={LABEL}>
        {t(secret ? "settings.vault.secret.valueKeep" : "settings.vault.secret.value")}
        <input name="secretValue" type="password" autoComplete="new-password" spellCheck={false} required={!secret} value={value} placeholder="••••••••"
          onChange={(event) => setValue(event.target.value)} disabled={pending} className={FIELD} />
      </label>
      <LoginBotPicker value={who} onChange={setWho} bots={bots} disabled={pending} />
    </Shell>
  );
}

/** A pasted .env file: each NAME=value line becomes a secret named NAME. */
export function EnvImportForm({ bots, onCancel, onSaved }: { bots: Bots; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [who, setWho] = useState<LoginBots>("all");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const lines = parseEnv(text);
    if (!lines.length) { setError(t("settings.vault.env.none")); return; }
    setPending(true);
    setError(null);
    setDone(null);
    try {
      setDone(await importEnv(lines, who));
      setText("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("settings.vault.secret.saveError"));
    } finally {
      setPending(false);
      await onSaved().catch(() => {});
    }
  };
  return (
    <Shell form="env-form" onSubmit={(event) => void submit(event)} onCancel={onCancel} pending={pending} error={error} submitLabel={t("settings.vault.env.submit")}>
      <label className={LABEL}>
        {t("settings.vault.env.label")}
        <textarea name="envText" rows={5} autoComplete="off" spellCheck={false} autoFocus value={text} onChange={(event) => setText(event.target.value)}
          disabled={pending} placeholder="STRIPE_SECRET_KEY=…" dir="ltr" className={`${FIELD} font-mono`} />
        <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("settings.vault.env.hint")}</span>
      </label>
      <LoginBotPicker value={who} onChange={setWho} bots={bots} disabled={pending} />
      {done !== null && <p role="status" className="text-[12px] text-ink-secondary">{t("settings.vault.env.done", { count: String(done) })}</p>}
    </Shell>
  );
}
