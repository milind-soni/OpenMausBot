import { useEffect, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";

import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";

export interface IMessageView {
  available: boolean;
  connected: boolean;
  number?: string;
  chats: Array<{ id: string; name?: string }>;
  linkExpiresAt?: number;
  lastError?: { at: number; message: string };
}

/** The code and link ride only on the answer that made them: a reload shows the waiting state without them. */
type StartedLink = IMessageView & { code: string; command: string; url: string; expiresAt: number };

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";
const fieldCls = "min-w-0 flex-1 rounded-lg bg-inset px-3 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-tertiary";
const WATCH_MS = 2_000;

export function IMessageCard({ bot, className }: { bot: Bot; className?: string }) {
  const [view, setView] = useState<IMessageView | null>(null);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [number, setNumber] = useState("");
  const [link, setLink] = useState<StartedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const path = `/api/bots/${bot.id}/imessage`;
  // The server drops the code once a phone claims it or it expires: waiting while it is still open, expired when it went with no new phone.
  const waiting = link !== null && view?.linkExpiresAt !== undefined;
  const expired = link !== null && !waiting && (view?.chats.length ?? 0) === link.chats.length;

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setLink(null);
    setKeyId("");
    setSecret("");
    setNumber("");
    api<IMessageView>(path).then((loaded) => { if (!cancelled) setView(loaded); }).catch(() => { if (!cancelled) setError(t("imessage.error")); });
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { api<IMessageView>(path).then(setView).catch(() => undefined); }, WATCH_MS);
    return () => window.clearInterval(timer);
  }, [waiting, path]);

  const change = async (request: () => Promise<IMessageView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await request());
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t("imessage.error"));
    } finally {
      setBusy(false);
    }
  };
  const connect = () => change(async () => {
    const next = await api<IMessageView>(path, { method: "POST", body: JSON.stringify({ keyId, secret, number }) });
    setKeyId("");
    setSecret("");
    return next;
  });
  const startLink = () => change(async () => { const started = await api<StartedLink>(`${path}/link`, { method: "POST" }); setLink(started); return started; });
  const disconnect = () => change(async () => { setLink(null); return api<IMessageView>(path, { method: "DELETE" }); });
  const copy = async () => {
    if (!link) return;
    setCopied((await copyText(link.command)) === "copied");
    window.setTimeout(() => setCopied(false), 1500);
  };
  const linked = view?.chats ?? [];

  return (
    <div className={cn("rounded-xl bg-card p-4", className)} data-testid="imessage">
      <div className="text-[15px] font-medium text-ink">{t("imessage.title")}</div>
      {view?.available === false ? (
        <div className="mt-0.5 text-[13px] text-ink-secondary" data-testid="imessage-unavailable">{t("imessage.teamUnavailable")}</div>
      ) : !view?.connected ? (
        <>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{t("imessage.hint", { name: bot.name })}</div>
          <div className="mt-1 text-[13px] text-ink-secondary" data-testid="imessage-plans">{t("imessage.plans")}</div>
          <a href="https://dashboard.sendblue.com" target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13px] text-ink-secondary hover:text-ink">
            {t("imessage.openSendblue")} <ExternalLink size={12} aria-hidden="true" />
          </a>
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
              {t("imessage.keyId")}
              <input type="password" autoComplete="off" value={keyId} onChange={(event) => setKeyId(event.target.value)} className={fieldCls} data-testid="imessage-key-id" />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
              {t("imessage.secret")}
              <input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} className={fieldCls} data-testid="imessage-secret" />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] text-ink-secondary">
                {t("imessage.number")}
                <input type="tel" autoComplete="off" value={number} onChange={(event) => setNumber(event.target.value)} placeholder={t("imessage.numberPlaceholder")} className={fieldCls} data-testid="imessage-number" />
              </label>
              <button type="button" onClick={() => void connect()} disabled={!view || busy || !keyId.trim() || !secret.trim() || !number.trim()} className={buttonCls} data-testid="imessage-connect">{t("imessage.connect")}</button>
            </div>
          </div>
        </>
      ) : (
        <div className="mt-1 flex flex-col gap-2 text-[13px]">
          <div className="text-ink" data-testid="imessage-connected">{t("imessage.connected", { number: view.number ?? "" })}</div>
          {linked.length > 0 && (
            <div className="text-ink-secondary" data-testid="imessage-chats">{t("imessage.linked", { names: linked.map((chat) => chat.name ?? chat.id).join(", ") })}</div>
          )}
          {waiting && link ? (
            <div className="flex flex-col gap-2 rounded-lg bg-inset p-3" data-testid="imessage-link">
              <div className="text-ink">{t("imessage.linkHint", { number: view.number ?? "" })}</div>
              <div className="font-mono text-[15px] text-ink" data-testid="imessage-command">{link.command}</div>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-ink-secondary underline" data-testid="imessage-link-url">{t("imessage.openMessages")}</a>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void copy()} className={cn(buttonCls, "inline-flex items-center gap-1.5")} data-testid="imessage-copy">
                  <Copy size={13} aria-hidden="true" />{copied ? t("imessage.copied") : t("imessage.copy")}
                </button>
                <span className="text-ink-secondary" data-testid="imessage-waiting">{t("imessage.waiting")}</span>
              </div>
            </div>
          ) : expired ? (
            <div className="text-ink-secondary" data-testid="imessage-expired">{t("imessage.expired")}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {!waiting && (
              <button type="button" onClick={() => void startLink()} disabled={busy} className={buttonCls} data-testid="imessage-start-link">
                {linked.length ? t("imessage.linkAnother") : t("imessage.link")}
              </button>
            )}
            <button type="button" onClick={() => void disconnect()} disabled={busy} className={buttonCls} data-testid="imessage-disconnect">{t("imessage.disconnect")}</button>
          </div>
        </div>
      )}
      {view?.lastError && !error && <div className="mt-2 text-[12px] text-warning" data-testid="imessage-last-error">{view.lastError.message}</div>}
      {error && <div className="mt-2 text-[12px] text-danger" role="alert">{error}</div>}
    </div>
  );
}
