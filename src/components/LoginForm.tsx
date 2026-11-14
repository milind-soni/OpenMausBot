import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, LockKeyhole } from "lucide-react";

import type { LoginBots } from "../../shared/logins";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LoginFieldsInput } from "@/lib/logins";

// Security: the browser is asked not to fill or remember these fields, what was typed is dropped once saved, and a
// saved password is never shown.

const FIELD = "w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";
const LABEL = "flex flex-col gap-1 text-[12px] font-medium text-ink-secondary";

export function LoginForm({
  site,
  username = true,
  replacing = false,
  submitLabel,
  onSubmit,
  onCancel,
  children,
  autoFocus = false,
}: {
  site?: { value: string; onChange: (value: string) => void };
  username?: boolean;
  replacing?: boolean;
  submitLabel: string;
  onSubmit: (fields: LoginFieldsInput) => Promise<void>;
  onCancel?: () => void;
  children?: ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!replacing && !password) { setError(t("logins.passwordNeeded")); return; }
    setPending(true);
    setError(null);
    try {
      await onSubmit({ username: user.trim(), password, totp: totp.trim() });
      setPassword("");
      setTotp("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("logins.saveError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2.5" aria-busy={pending} data-login-form>
      {site && (
        <label className={LABEL}>
          {t("logins.site")}
          <input name="site" type="text" inputMode="url" autoComplete="off" spellCheck={false} required maxLength={2048}
            placeholder={t("logins.sitePlaceholder")} value={site.value} onChange={(event) => site.onChange(event.target.value)}
            disabled={pending} className={FIELD} autoFocus={autoFocus} aria-describedby={`${id}-site`} />
          <span id={`${id}-site`} className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("logins.siteHint")}</span>
        </label>
      )}
      {username && (
        <label className={LABEL}>
          {t("logins.username")}
          <input name="username" type="text" autoComplete="off" spellCheck={false} maxLength={512} value={user}
            onChange={(event) => setUser(event.target.value)} disabled={pending} className={FIELD} autoFocus={autoFocus && !site} />
        </label>
      )}
      <label className={LABEL}>
        {t(replacing ? "logins.passwordKeep" : "logins.password")}
        <input name="password" type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={password}
          required={!replacing} placeholder="••••••••" onChange={(event) => setPassword(event.target.value)} disabled={pending} className={FIELD}
          autoFocus={autoFocus && !site && !username} />
      </label>
      <label className={LABEL}>
        {t(replacing ? "logins.totpKeep" : "logins.totp")}
        <input name="totp" type="password" autoComplete="off" spellCheck={false} maxLength={2048} value={totp}
          onChange={(event) => setTotp(event.target.value)} disabled={pending} className={FIELD} aria-describedby={`${id}-totp`} />
        <span id={`${id}-totp`} className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("logins.totpHint")}</span>
      </label>
      {children}
      <p className="flex items-start gap-1 text-[12px] leading-snug text-ink-tertiary">
        <LockKeyhole size={11} aria-hidden="true" className="mt-[3px] shrink-0" /> {t("logins.private")}
      </p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={pending} className="ui-button ui-button-md">{t("logins.cancel")}</button>
        )}
        <button type="submit" disabled={pending} className="ui-button ui-button-md ui-button-primary inline-flex items-center gap-1.5">
          {pending && <Loader2 size={13} className="animate-spin" />}{submitLabel}
        </button>
      </div>
    </form>
  );
}

export function LoginBotPicker({ value, onChange, bots, disabled = false }: {
  value: LoginBots;
  onChange: (value: LoginBots) => void;
  bots: ReadonlyArray<{ id: string; name: string }>;
  disabled?: boolean;
}) {
  const name = useId();
  const chosen = value === "all" ? [] : value;
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1 text-[12px] font-medium text-ink-secondary">{t("settings.logins.whoCanUse")}</legend>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="radio" name={name} checked={value === "all"} onChange={() => onChange("all")} />
        {t("settings.logins.allBots")}
      </label>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="radio" name={name} checked={value !== "all"} onChange={() => onChange(chosen)} />
        {t("settings.logins.onlyThese")}
      </label>
      {value !== "all" && (
        <div className={cn("ms-6 flex flex-col gap-1", bots.length > 6 && "max-h-40 overflow-y-auto")}>
          {bots.map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={chosen.includes(bot.id)}
                onChange={(event) => onChange(event.target.checked ? [...chosen, bot.id] : chosen.filter((id) => id !== bot.id))} />
              <span className="truncate">{bot.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
