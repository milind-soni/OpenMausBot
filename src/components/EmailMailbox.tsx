import { useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { Select } from "./Select";
import { outgoingFieldsOf, type EmailAccountView, type EmailOutgoingAnswer, type EmailOutgoingFields, type EmailSignInHint, type EmailTestAnswer } from "../../shared/email";

export const EMAIL_PILL = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";
export const EMAIL_FIELD = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50";
export const EMAIL_LINK = "self-start text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink";

/** A step of connecting: still going, passed (with the server it reached), or failed (with why, in one sentence). */
export type EmailCheck = { state: "waiting" } | { state: "done"; host?: string } | { state: "failed"; problem: string };

function CheckLine({ label, check }: { label: string; check: EmailCheck }) {
  return (
    <li data-email-check={check.state} className="flex min-w-0 items-start gap-1.5 text-[12px] leading-[18px]">
      <span aria-hidden="true" className="flex h-[18px] w-3.5 shrink-0 items-center justify-center">
        {check.state === "waiting" ? <Loader2 size={12} className="animate-spin text-ink-tertiary" />
          : check.state === "done" ? <Check size={13} strokeWidth={2.5} className="text-success" />
            : <X size={13} strokeWidth={2.5} className="text-warning" />}
      </span>
      <span className="shrink-0 text-ink">{label}</span>
      {check.state === "done" && check.host && <span dir="ltr" className="min-w-0 truncate text-ink-secondary">{check.host}</span>}
      {check.state === "failed" && <span role="alert" className="min-w-0 text-warning">{check.problem}</span>}
    </li>
  );
}

/** "✓ Reading imap.x" and "✓ Sending smtp.x", or what is still being checked, or why sending doesn't work. */
export function EmailCheckLines({ reading, sending }: { reading: EmailCheck; sending: EmailCheck }) {
  return (
    <ul data-email-checks className="flex flex-col gap-0.5">
      <CheckLine label={t("email.reading")} check={reading} />
      <CheckLine label={t("email.sending")} check={sending} />
    </ul>
  );
}

/** The outgoing server and its own sign-in, for when it can't be found or takes another one. */
export function OutgoingServerInputs<T extends EmailOutgoingFields>({ value, onChange, className = EMAIL_FIELD, disabled = false }: { value: T; onChange: (next: T) => void; className?: string; disabled?: boolean }) {
  const set = (name: keyof EmailOutgoingFields, next: string | number | undefined) => {
    const { [name]: _gone, ...rest } = value;
    onChange((next === undefined || next === "" ? rest : { ...rest, [name]: next }) as T);
  };
  return (
    <div data-email-outgoing-fields className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
      <input type="text" autoComplete="off" spellCheck={false} dir="ltr" disabled={disabled} aria-label={t("email.outgoingServer")} placeholder={t("email.outgoingServer")} value={value.smtpHost ?? ""} onChange={(event) => set("smtpHost", event.target.value)} className={className} />
      <input type="number" min={1} max={65535} autoComplete="off" dir="ltr" disabled={disabled} aria-label={t("email.port")} placeholder={t("email.port")} value={value.smtpPort ?? ""} onChange={(event) => set("smtpPort", event.target.value ? Number(event.target.value) : undefined)} className={className} />
      <div className="col-span-2 flex">
        <Select size="sm" className="w-full" aria-label={t("email.security")} disabled={disabled} value={value.smtpSecurity ?? ""} onChange={(event) => set("smtpSecurity", event.target.value)}>
          <option value="">{t("email.securityAuto")}</option>
          <option value="tls">{t("email.securityTls")}</option>
          <option value="starttls">{t("email.securityStarttls")}</option>
        </Select>
      </div>
      <input type="text" autoComplete="off" spellCheck={false} dir="ltr" disabled={disabled} aria-label={t("email.smtpUsername")} placeholder={t("email.smtpUsername")} value={value.smtpUsername ?? ""} onChange={(event) => set("smtpUsername", event.target.value)} className={cn(className, "col-span-2")} />
      <input type="password" autoComplete="new-password" spellCheck={false} dir="ltr" disabled={disabled} aria-label={t("email.smtpPassword")} placeholder={t("email.smtpPassword")} value={value.smtpPassword ?? ""} onChange={(event) => set("smtpPassword", event.target.value)} className={cn(className, "col-span-2")} />
    </div>
  );
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Gmail, Outlook and the providers that want an app password: one line, and their own way in. */
export function EmailSignInNote({ hint }: { hint: EmailSignInHint }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef<ReturnType<typeof reserveConnectionPage> | null>(null);
  const signIn = async (slug: "gmail" | "outlook") => {
    if (opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    setBusy(true);
    setError(null);
    try {
      const result = await api(`/api/connectors/${slug}/authorize`, { method: "POST" }) as { url?: unknown };
      const url = mcpSignInLink(typeof result.url === "string" ? result.url : null);
      if (!url) throw new Error(t("connectors.invalidAuthorizationUrl"));
      if (!await launch.open(url)) setError(t("connectors.popupBlockedContinue"));
    } catch (cause) { setError(message(cause)); }
    finally {
      launch.cancel();
      opening.current = null;
      setBusy(false);
    }
  };
  const note = hint.app === "gmail" ? t("email.needsGoogle") : hint.app === "outlook" ? t("email.needsMicrosoft") : t("email.needsAppPassword", { provider: hint.provider });
  return (
    <div data-email-sign-in={hint.app ?? "app-password"} className="flex flex-col gap-1.5">
      <p role="alert" className="text-[12px] leading-[18px] text-ink">{note}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {hint.app && (
          <button type="button" disabled={busy} onClick={() => void signIn(hint.app!)} className={EMAIL_PILL}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : t(hint.app === "gmail" ? "email.signInGoogle" : "email.signInMicrosoft")}
          </button>
        )}
        {hint.appPasswordUrl && <a href={hint.appPasswordUrl} target="_blank" rel="noopener noreferrer" className={EMAIL_LINK}>{t("email.makeAppPassword")}</a>}
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/** One connected mailbox, the same in Apps and in a chat: whether it reads and sends, a test to itself, and its outgoing
 * server, open by itself while sending doesn't work. `compact`: Apps' short button names, with the address on top. */
export function EmailMailbox({ account, onChanged, compact = false, fieldClassName = EMAIL_FIELD }: {
  account: EmailAccountView;
  onChanged: (account: EmailAccountView | null) => void | Promise<void>;
  compact?: boolean;
  fieldClassName?: string;
}) {
  const failing = Boolean(account.sendingProblem);
  const [editing, setEditing] = useState(failing);
  const [fields, setFields] = useState<EmailOutgoingFields>(() => outgoingFieldsOf(account));
  const [busy, setBusy] = useState<"check" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const at = `/api/email/accounts/${encodeURIComponent(account.address)}`;

  const check = async () => {
    if (busy) return;
    setBusy("check");
    setError(null);
    setDone(null);
    try {
      const answer = await api(`${at}/outgoing`, { method: "POST", body: JSON.stringify(fields) }) as EmailOutgoingAnswer;
      if (answer.ok) {
        setEditing(false);
        setFields(outgoingFieldsOf(answer.account));
        await onChanged(answer.account);
      } else {
        setError(answer.error);
        if (answer.account) await onChanged(answer.account);
      }
    } catch (cause) { setError(message(cause)); } finally { setBusy(null); }
  };

  const test = async () => {
    if (busy) return;
    setBusy("test");
    setError(null);
    setDone(null);
    try {
      const answer = await api(`${at}/test`, { method: "POST" }) as EmailTestAnswer;
      if (answer.ok) setDone(t("email.testSent", { address: account.address })); else { setError(answer.error); await onChanged(null); }
    } catch (cause) { setError(message(cause)); } finally { setBusy(null); }
  };

  const sending: EmailCheck = account.sendingProblem ? { state: "failed", problem: account.sendingProblem } : { state: "done", host: account.smtpHost };
  return (
    <div data-email-mailbox={account.address} className="flex min-w-0 flex-col gap-1.5">
      {compact && <p dir="ltr" className="truncate text-start text-[13px] font-medium leading-5 text-ink">{account.address}</p>}
      {!compact && !failing && <p role="status" className="text-[13px] font-medium leading-5 text-ink">{t("email.connectedDone")}</p>}
      <EmailCheckLines reading={account.problem ? { state: "failed", problem: account.problem } : { state: "done", host: account.imapHost }} sending={sending} />
      {!editing && (
        <div className="flex flex-wrap items-center gap-2">
          {!failing && (
            <button type="button" disabled={busy !== null} onClick={() => void test()} className={EMAIL_PILL}>
              {busy === "test" ? <Loader2 size={14} className="animate-spin" /> : t(compact ? "email.test" : "email.sendTestToMyself")}
            </button>
          )}
          <button type="button" disabled={busy !== null} onClick={() => { setEditing(true); setError(null); setDone(null); }} className={failing ? EMAIL_PILL : EMAIL_LINK}>
            {t(failing ? "email.outgoing" : "email.edit")}
          </button>
        </div>
      )}
      {editing && (
        <form data-email-outgoing className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void check(); }}>
          <p className="text-[12px] font-medium text-ink">{t("email.outgoing")}</p>
          <OutgoingServerInputs value={fields} onChange={setFields} className={fieldClassName} disabled={busy !== null} />
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy !== null} className={EMAIL_PILL}>{busy === "check" ? <Loader2 size={14} className="animate-spin" /> : t("common.tryAgain")}</button>
            {!failing && <button type="button" disabled={busy !== null} onClick={() => { setEditing(false); setFields(outgoingFieldsOf(account)); setError(null); }} className={EMAIL_LINK}>{t("common.cancel")}</button>}
          </div>
        </form>
      )}
      {done && <p role="status" className="text-[12px] text-ink-secondary">{done}</p>}
      {error && error !== account.sendingProblem && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
