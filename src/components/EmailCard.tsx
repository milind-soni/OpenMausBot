import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Loader2, Mail, MoreHorizontal, Plus } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { EmailConnectAnswer, EmailConnectRequest, EmailServerFields, EmailSignInHint, EmailStatus } from "../../shared/email";
import { EMAIL_FIELD, EMAIL_LINK, EMAIL_PILL, EmailCheckLines, EmailMailbox, EmailSignInNote, OutgoingServerInputs } from "./EmailMailbox";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

export function EmailIcon() {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#2f6f6d] text-white" aria-hidden="true"><Mail size={20} /></span>
  );
}

/** Where a mail server is, for when it can't be found from the address; the outgoing one only behind its own button. */
export function EmailServerInputs({ value, onChange, className = EMAIL_FIELD }: { value: EmailServerFields; onChange: (next: EmailServerFields) => void; className?: string }) {
  const [outgoing, setOutgoing] = useState(Boolean(value.smtpHost));
  const text = (name: "imapHost" | "username", label: string) => (
    <input type="text" autoComplete="off" spellCheck={false} dir="ltr" aria-label={label} placeholder={label} value={value[name] ?? ""} onChange={(event) => onChange({ ...value, [name]: event.target.value })} className={className} />
  );
  return (
    <div data-email-server-fields className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
        {text("imapHost", t("email.incomingServer"))}
        <input type="number" min={1} max={65535} autoComplete="off" dir="ltr" aria-label={t("email.port")} placeholder={t("email.port")} value={value.imapPort ?? ""} onChange={(event) => { const { imapPort: _gone, ...rest } = value; onChange(event.target.value ? { ...rest, imapPort: Number(event.target.value) } : rest); }} className={className} />
        <div className="col-span-2">{text("username", t("email.username"))}</div>
      </div>
      {outgoing ? <OutgoingServerInputs value={value} onChange={onChange} className={className} /> : <button type="button" onClick={() => setOutgoing(true)} className={EMAIL_LINK}>{t("email.outgoing")}</button>}
    </div>
  );
}

/** Why a connect didn't take: in one sentence, with the servers to type when none was found, or a provider's own way in. */
export type EmailConnectRefusal = { error: string; needsServer?: boolean; signIn?: EmailSignInHint };

/** Email and password, and Connect: the servers are found from the address. While it checks, "Reading" and "Sending"
 * tick as they pass; `reading` is the incoming server once it took the password. */
export function EmailConnectForm({ initialAddress = "", submit, reading, fieldClassName = EMAIL_FIELD, submitClassName = EMAIL_PILL, submitStyle, footer }: {
  initialAddress?: string;
  /** Connects, or says why not. */
  submit: (request: EmailConnectRequest) => Promise<EmailConnectRefusal | null>;
  reading?: string;
  fieldClassName?: string;
  submitClassName?: string;
  submitStyle?: CSSProperties;
  footer?: ReactNode;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [password, setPassword] = useState("");
  const [server, setServer] = useState<EmailServerFields>({});
  const [needsServer, setNeedsServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<EmailConnectRefusal | null>(null);

  const connect = async () => {
    if (busy || !address.trim() || !password) return;
    setBusy(true);
    setRefusal(null);
    try {
      // A password goes as typed: a mailbox's can begin or end with a space.
      const refused = await submit({ address: address.trim(), password, ...server });
      if (refused) {
        setRefusal(refused);
        if (refused.needsServer) setNeedsServer(true);
      } else setPassword("");
    } finally { setBusy(false); }
  };

  const anyScreenConnecting = busy || Boolean(reading);
  return (
    <form data-email-form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
      <input type="email" autoComplete="off" spellCheck={false} dir="ltr" disabled={busy} aria-label={t("email.address")} placeholder={t("email.address")} value={address} onChange={(event) => setAddress(event.target.value)} className={fieldClassName} />
      <input type="password" autoComplete="new-password" spellCheck={false} dir="ltr" disabled={busy} aria-label={t("email.password")} placeholder={t("email.password")} value={password} onChange={(event) => setPassword(event.target.value)} className={fieldClassName} />
      {needsServer && <EmailServerInputs value={server} onChange={setServer} className={fieldClassName} />}
      {anyScreenConnecting && <EmailCheckLines reading={reading ? { state: "done", host: reading } : { state: "waiting" }} sending={{ state: "waiting" }} />}
      {refusal && (refusal.signIn ? <EmailSignInNote hint={refusal.signIn} /> : <p role="alert" className="text-[12px] text-danger">{refusal.error}</p>)}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !address.trim() || !password} className={submitClassName} style={submitStyle}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : t("connectors.action.connect")}
        </button>
        {!needsServer && !busy && <button type="button" onClick={() => setNeedsServer(true)} className={EMAIL_LINK}>{t("email.typeServer")}</button>}
      </div>
      {footer}
    </form>
  );
}

/** The Email card in Apps: any mailbox on any mail host, connected with an address and a password. */
export function EmailCard({ refreshKey = 0, onConnection }: {
  refreshKey?: number;
  /** true once connected, false otherwise, null until the server has answered */
  onConnection?: (connected: boolean | null) => void;
}) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await api("/api/email") as EmailStatus;
      setStatus(answer);
      setLoadFailed(false);
    } catch { setLoadFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { onConnection?.(status ? status.state === "connected" : null); }, [status, onConnection]);

  const connect = async (request: EmailConnectRequest): Promise<EmailConnectRefusal | null> => {
    setDone(null);
    try {
      const answer = await api("/api/email/accounts", { method: "POST", body: JSON.stringify(request) }) as EmailConnectAnswer;
      if (!answer.ok) return { error: answer.error, ...(answer.needsServer ? { needsServer: true } : {}), ...(answer.signIn ? { signIn: answer.signIn } : {}) };
      setOpen(false);
      setDone(answer.sending.ok ? t("email.connected", { count: answer.inbox.messages }) : t("email.connectedNoSending", { count: answer.inbox.messages }));
      await load();
      return null;
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  const disconnect = async (mailbox: string) => {
    setDone(null);
    try { setStatus(await api(`/api/email/accounts/${encodeURIComponent(mailbox)}`, { method: "DELETE" }) as EmailStatus); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (status?.state === "unavailable") return null;
  const accounts = status?.accounts ?? [];
  const connected = accounts.length > 0;
  const description = connected ? accounts.map((account) => account.address).join(", ") : t("email.description");

  return (
    <div data-app-tile="email" data-email-state={status?.state ?? "loading"} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <EmailIcon />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{t("email.title")}</span>
            {connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={description}>{description}</p>
        </div>
        {status === null ? (
          loadFailed
            ? <button type="button" onClick={() => void load()} className={EMAIL_PILL}>{t("connectors.action.retry")}</button>
            : <button type="button" disabled className={EMAIL_PILL} aria-label={t("common.checking")}><Loader2 size={14} className="animate-spin" /></button>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            {(!connected || open) && <button type="button" onClick={() => { setOpen(!open); setError(null); }} className={EMAIL_PILL} aria-expanded={open}>{open ? t("common.cancel") : t("connectors.action.connect")}</button>}
            {connected && (
              <SidebarPopoverMenu
                placement="below"
                ariaLabel={t("email.menu")}
                triggerClassName="shrink-0"
                items={[
                  { key: "email-add", label: t("email.addAnother"), onSelect: () => { setOpen(true); setError(null); } },
                  ...accounts.map((account) => ({ key: `email-remove-${account.address}`, label: t("email.disconnect", { address: account.address }), onSelect: () => void disconnect(account.address) })),
                ]}
                renderTrigger={() => <span className="inline-flex size-7 items-center justify-center rounded-full bg-control/80 text-ink hover:bg-raised-hover"><MoreHorizontal size={15} aria-hidden="true" /></span>}
              />
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 ps-[52px]">
        {done && <p role="status" className="mt-1.5 text-[12px] text-ink-secondary">{done}</p>}
        {accounts.map((account) => <EmailMailbox key={`${account.address}:${account.connectedAt}`} compact account={account} onChanged={load} />)}
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        {open && <EmailConnectForm submit={connect} footer={<p className="text-[12px] leading-relaxed text-ink-secondary">{t("email.help")}</p>} />}
        {connected && !open && (
          <button type="button" onClick={() => { setOpen(true); setError(null); }} className="inline-flex items-center gap-1 self-start text-[12px] text-ink-secondary hover:text-ink">
            <Plus size={12} aria-hidden="true" />{t("email.addAnotherAddress")}
          </button>
        )}
      </div>
    </div>
  );
}
