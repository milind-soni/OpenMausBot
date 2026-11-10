import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Mail, MoreHorizontal } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { EmailConnectAnswer, EmailServerFields, EmailStatus } from "../../shared/email";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

const pill = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";
const field = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50";

export function EmailIcon() {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#2f6f6d] text-white" aria-hidden="true"><Mail size={20} /></span>
  );
}

/** Where a mail server is, for when it can't be found from the address. */
export function EmailServerInputs({ value, onChange, className = field }: { value: EmailServerFields; onChange: (next: EmailServerFields) => void; className?: string }) {
  const text = (name: "imapHost" | "smtpHost" | "username", label: string) => (
    <input type="text" autoComplete="off" spellCheck={false} dir="ltr" aria-label={label} placeholder={label} value={value[name] ?? ""} onChange={(event) => onChange({ ...value, [name]: event.target.value })} className={className} />
  );
  const port = (name: "imapPort" | "smtpPort", label: string) => (
    <input type="number" min={1} max={65535} autoComplete="off" dir="ltr" aria-label={label} placeholder={label} value={value[name] ?? ""} onChange={(event) => { const { [name]: _gone, ...rest } = value; onChange(event.target.value ? { ...rest, [name]: Number(event.target.value) } : rest); }} className={className} />
  );
  return (
    <div data-email-server-fields className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
      {text("imapHost", t("email.incomingServer"))}{port("imapPort", t("email.port"))}
      {text("smtpHost", t("email.outgoingServer"))}{port("smtpPort", t("email.port"))}
      <div className="col-span-2">{text("username", t("email.username"))}</div>
    </div>
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
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState<EmailServerFields>({});
  const [needsServer, setNeedsServer] = useState(false);
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

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const answer = await api("/api/email/accounts", { method: "POST", body: JSON.stringify({ address: address.trim(), password, ...server }) }) as EmailConnectAnswer;
      if (!answer.ok) {
        setError(answer.error);
        if (answer.needsServer) setNeedsServer(true);
        return;
      }
      setPassword("");
      setOpen(false);
      setNeedsServer(false);
      setServer({});
      setAddress("");
      setDone(answer.sending.ok ? t("email.connected", { count: answer.inbox.messages }) : t("email.connectedNoSending", { count: answer.inbox.messages }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
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
  const problem = accounts.find((account) => account.problem)?.problem;

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
            ? <button type="button" onClick={() => void load()} className={pill}>{t("connectors.action.retry")}</button>
            : <button type="button" disabled className={pill} aria-label={t("common.checking")}><Loader2 size={14} className="animate-spin" /></button>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            {(!connected || open) && <button type="button" disabled={busy} onClick={() => { setOpen(!open); setError(null); }} className={pill} aria-expanded={open}>{open ? t("common.cancel") : t("connectors.action.connect")}</button>}
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
      <div className="ps-[52px]">
        {done && <p role="status" className="mt-1.5 text-[12px] text-ink-secondary">{done}</p>}
        {problem && !open && <p role="alert" className="mt-1.5 text-[12px] text-warning">{problem}</p>}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
        {open && (
          <form data-email-form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            <input type="email" autoComplete="off" spellCheck={false} dir="ltr" aria-label={t("email.address")} placeholder={t("email.address")} value={address} onChange={(event) => setAddress(event.target.value)} className={field} />
            <input type="password" autoComplete="new-password" spellCheck={false} dir="ltr" aria-label={t("email.password")} placeholder={t("email.password")} value={password} onChange={(event) => setPassword(event.target.value)} className={field} />
            {needsServer && <EmailServerInputs value={server} onChange={setServer} />}
            <p className="text-[12px] leading-relaxed text-ink-secondary">{t("email.help")}</p>
            <div className="flex items-center gap-2">
              <button type="submit" disabled={busy || !address.trim() || !password} className={pill}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : t("connectors.action.connect")}
              </button>
              {busy && <span role="status" className="text-[12px] text-ink-secondary">{t("email.checking")}</span>}
              {!needsServer && !busy && <button type="button" onClick={() => setNeedsServer(true)} className="text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink">{t("email.typeServer")}</button>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
