import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, Loader2, Mail } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { EmailAccountView, EmailOutgoingFields, EmailStatus } from "../../shared/email";
import { ASK_FIELD, AskCard } from "./AskCard";
import { EMAIL_FIELD, EMAIL_PILL, EmailMailbox, OutgoingServerInputs } from "./EmailMailbox";

/** A bot's card for a connected mailbox that can't send: its outgoing server and sending sign-in, checked before it is kept.
 * `submit` answers why it still can't send, or null once it does. */
export function EmailOutgoingRequestForm({ address, initial, submit, fieldClassName = EMAIL_FIELD, submitClassName = EMAIL_PILL, submitStyle }: {
  address: string;
  initial: EmailOutgoingFields;
  submit: (fields: EmailOutgoingFields) => Promise<string | null>;
  fieldClassName?: string;
  submitClassName?: string;
  submitStyle?: CSSProperties;
}) {
  const [fields, setFields] = useState<EmailOutgoingFields>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try { setError(await submit(fields)); } finally { setBusy(false); }
  };
  return (
    <form data-email-outgoing-request className="flex flex-col gap-2" onSubmit={(event) => void save(event)}>
      <p dir="ltr" className="truncate text-start text-[13px] font-medium leading-5 text-ink">{address}</p>
      <OutgoingServerInputs value={fields} onChange={setFields} className={fieldClassName} disabled={busy} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="submit" disabled={busy} className={submitClassName} style={submitStyle}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <LockKeyhole size={14} />}
          {t("chat.secret.save")}
        </button>
        <span className="flex items-center gap-1 text-[12px] text-ink-tertiary"><LockKeyhole size={11} /> {t("secretCard.email")}</span>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </form>
  );
}

/** A chat's mailbox card once connected: the same mailbox as in Apps, with a test to itself, and its outgoing server open
 * while sending doesn't work. Where the mailbox can't be shown (gone, or this person doesn't manage mailboxes), the
 * settled line instead. */
export function EmailRequestSettled({ address, label, settled, initial }: { address: string; label: string; settled: ReactNode; initial?: EmailAccountView }) {
  const [account, setAccount] = useState<EmailAccountView | null>(initial ?? null);
  const load = useCallback(async () => {
    try {
      const status = await api("/api/email") as EmailStatus;
      setAccount(status.accounts.find((one) => one.address.toLowerCase() === address.toLowerCase()) ?? null);
    } catch { setAccount(null); }
  }, [address]);
  useEffect(() => { if (!initial) void load(); }, [initial, load]);
  if (!account) return <>{settled}</>;
  return (
    <AskCard ariaLabel={label} icon={<Mail size={15} />} title={<span dir="ltr">{account.address}</span>}>
      <EmailMailbox account={account} onChanged={(next) => (next ? setAccount(next) : load())} fieldClassName={cn(ASK_FIELD, "w-full")} />
    </AskCard>
  );
}
