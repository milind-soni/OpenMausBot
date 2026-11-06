import { useEffect, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";

import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { api, type Bot } from "@/state/store";

export interface TelegramView {
  available: boolean;
  connected: boolean;
  username?: string;
  chats: Array<{ id: string; name?: string }>;
  linkExpiresAt?: number;
  lastError?: { at: number; message: string };
}

/** The code and link ride only on the answer that made them: a reload shows the waiting state without them. */
type StartedLink = TelegramView & { code: string; url: string; expiresAt: number };

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";
const WATCH_MS = 2_000;

export function TelegramCard({ bot, className }: { bot: Bot; className?: string }) {
  const [view, setView] = useState<TelegramView | null>(null);
  const [token, setToken] = useState("");
  const [link, setLink] = useState<StartedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const path = `/api/bots/${bot.id}/telegram`;
  // The server drops the code once a chat claims it or it expires: waiting while it is still open, expired when it went with no new chat.
  const waiting = link !== null && view?.linkExpiresAt !== undefined;
  const expired = link !== null && !waiting && (view?.chats.length ?? 0) === link.chats.length;

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setLink(null);
    setToken("");
    api<TelegramView>(path).then((loaded) => { if (!cancelled) setView(loaded); }).catch(() => { if (!cancelled) setError(t("telegram.error")); });
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { api<TelegramView>(path).then(setView).catch(() => undefined); }, WATCH_MS);
    return () => window.clearInterval(timer);
  }, [waiting, path]);

  const change = async (request: () => Promise<TelegramView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await request());
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t("telegram.error"));
    } finally {
      setBusy(false);
    }
  };
  const connect = () => change(async () => { const next = await api<TelegramView>(path, { method: "POST", body: JSON.stringify({ token }) }); setToken(""); return next; });
  const startLink = () => change(async () => { const started = await api<StartedLink>(`${path}/link`, { method: "POST" }); setLink(started); return started; });
  const disconnect = () => change(async () => { setLink(null); return api<TelegramView>(path, { method: "DELETE" }); });
  const copy = async () => {
    if (!link) return;
    setCopied((await copyText(link.url)) === "copied");
    window.setTimeout(() => setCopied(false), 1500);
  };
  const linked = view?.chats ?? [];

  return (
    <div className={cn("rounded-xl bg-card p-4", className)} data-testid="telegram">
      <div className="text-[15px] font-medium text-ink">{t("telegram.title")}</div>
      {view?.available === false ? (
        <div className="mt-0.5 text-[13px] text-ink-secondary" data-testid="telegram-unavailable">{t("telegram.teamUnavailable")}</div>
      ) : !view?.connected ? (
        <>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{t("telegram.hint", { name: bot.name })}</div>
          <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13px] text-ink-secondary hover:text-ink">
            {t("telegram.openBotFather")} <ExternalLink size={12} aria-hidden="true" />
          </a>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={t("telegram.tokenPlaceholder")}
              aria-label={t("telegram.token")}
              className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-tertiary"
              data-testid="telegram-token"
            />
            <button type="button" onClick={() => void connect()} disabled={!view || busy || !token.trim()} className={buttonCls} data-testid="telegram-connect">{t("telegram.connect")}</button>
          </div>
        </>
      ) : (
        <div className="mt-1 flex flex-col gap-2 text-[13px]">
          <div className="text-ink" data-testid="telegram-connected">{t("telegram.connected", { username: view.username ?? "" })}</div>
          {linked.length > 0 && (
            <div className="text-ink-secondary" data-testid="telegram-chats">{t("telegram.linked", { names: linked.map((chat) => chat.name ?? chat.id).join(", ") })}</div>
          )}
          {waiting && link ? (
            <div className="flex flex-col gap-2 rounded-lg bg-inset p-3" data-testid="telegram-link">
              <div className="text-ink">{t("telegram.linkHint")}</div>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-[12px] text-ink underline" data-testid="telegram-link-url">{link.url}</a>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void copy()} className={cn(buttonCls, "inline-flex items-center gap-1.5")} data-testid="telegram-copy">
                  <Copy size={13} aria-hidden="true" />{copied ? t("telegram.copied") : t("telegram.copy")}
                </button>
                <span className="text-ink-secondary" data-testid="telegram-waiting">{t("telegram.waiting")}</span>
              </div>
            </div>
          ) : expired ? (
            <div className="text-ink-secondary" data-testid="telegram-expired">{t("telegram.expired")}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {!waiting && (
              <button type="button" onClick={() => void startLink()} disabled={busy} className={buttonCls} data-testid="telegram-start-link">
                {linked.length ? t("telegram.linkAnother") : t("telegram.link")}
              </button>
            )}
            <button type="button" onClick={() => void disconnect()} disabled={busy} className={buttonCls} data-testid="telegram-disconnect">{t("telegram.disconnect")}</button>
          </div>
        </div>
      )}
      {view?.lastError && !error && <div className="mt-2 text-[12px] text-warning" data-testid="telegram-last-error">{view.lastError.message}</div>}
      {error && <div className="mt-2 text-[12px] text-danger" role="alert">{error}</div>}
    </div>
  );
}
