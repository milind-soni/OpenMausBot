import { useEffect, useState } from "react";
import { Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { api, useStore, type Bot } from "@/state/store";
import { BOT_API_KEY_PLACEHOLDER, botApiCurl } from "../../../shared/bot-api";
import { Switch } from "../SettingsPrimitives";

export interface BotApiView {
  enabled: boolean;
  url: string;
  canManage: boolean;
  callCount: number;
  lastCalledAt?: number;
}

/** The key rides only on the answer that made it: nothing keeps it after this view. */
type Minted = BotApiView & { key: string };

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";

export function callsLine(view: Pick<BotApiView, "callCount" | "lastCalledAt">, now = Date.now()): string {
  if (!view.callCount || view.lastCalledAt === undefined) return t("botApi.callsNone");
  const when = relativeTime(view.lastCalledAt, now);
  return view.callCount === 1 ? t("botApi.callsOne", { when }) : t("botApi.calls", { count: view.callCount, when });
}

export function webhooksLine(count: number): string {
  return count === 0 ? t("botApi.webhooksNone") : count === 1 ? t("botApi.webhooksOne") : t("botApi.webhooks", { count });
}

/** The Bot API, the same in the bot panel and in Bot settings: a switch, the key once, the command to paste. */
export function BotApiCard({ bot, webhooksLink = false, className }: { bot: Bot; webhooksLink?: boolean; className?: string }) {
  const { state, dispatch } = useStore();
  const [view, setView] = useState<BotApiView | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [confirmingNewKey, setConfirmingNewKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const path = `/api/bots/${bot.id}/bot-api`;

  useEffect(() => {
    let cancelled = false;
    setFreshKey(null);
    setView(null);
    api<BotApiView>(path).then((loaded) => { if (!cancelled) setView(loaded); }).catch(() => { if (!cancelled) setError(t("botApi.error")); });
    return () => { cancelled = true; };
  }, [path]);

  const change = async (request: () => Promise<BotApiView | Minted>) => {
    setBusy(true);
    setError(null);
    setConfirmingNewKey(false);
    try {
      const next = await request();
      setView(next);
      setFreshKey("key" in next ? next.key : null);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t("botApi.error"));
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => change(() => api<BotApiView | Minted>(path, { method: "POST", body: JSON.stringify({ enabled: !view?.enabled }) }));
  const newKey = () => change(() => api<Minted>(`${path}/new-key`, { method: "POST" }));
  const curl = view ? botApiCurl(view.url, freshKey ?? BOT_API_KEY_PLACEHOLDER) : "";
  const copy = async () => {
    const result = await copyText(curl);
    setCopied(result === "copied" ? "copied" : "failed");
    window.setTimeout(() => setCopied(null), 1500);
  };
  const webhookCount = state.webhooks.filter((webhook) => webhook.botId === bot.id).length;
  const canManage = view?.canManage ?? false;

  return (
    <div className={cn("rounded-xl bg-card p-4", className)} data-testid="bot-api">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">{t("botApi.title")}</div>
          <div className="mt-0.5 text-[14px] text-ink">{t("botApi.switch")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{canManage || !view ? t("botApi.hint", { name: bot.name }) : t("botApi.notAllowed", { name: bot.name })}</div>
        </div>
        <Switch
          aria-label={t("botApi.switch")}
          checked={view?.enabled === true}
          disabled={!view || !canManage || busy}
          onClick={() => void toggle()}
          data-testid="bot-api-switch"
        />
      </div>
      {view?.enabled && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="relative">
            <pre data-testid="bot-api-curl" className="overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 pr-24 font-mono text-[12px] leading-[1.5] text-ink">{curl}</pre>
            <button type="button" onClick={() => void copy()} className={cn(buttonCls, "absolute right-2 top-2 inline-flex items-center gap-1.5")} data-testid="bot-api-copy">
              <Copy size={13} aria-hidden="true" />
              {copied === "copied" ? t("botApi.copied") : copied === "failed" ? t("botApi.copyFailed") : t("botApi.copy")}
            </button>
          </div>
          <div className={cn("text-[12px]", freshKey ? "text-warning" : "text-ink-secondary")} data-testid="bot-api-key-note">
            {freshKey ? t("botApi.keyOnce") : t("botApi.keyHidden")}
          </div>
          {canManage && (
            confirmingNewKey ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
                <span>{t("botApi.newKeyConfirm")}</span>
                <button type="button" onClick={() => void newKey()} disabled={busy} className={buttonCls} data-testid="bot-api-replace">{t("botApi.replace")}</button>
                <button type="button" onClick={() => setConfirmingNewKey(false)} className={buttonCls}>{t("common.cancel")}</button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-secondary" data-testid="bot-api-calls">{callsLine(view)}</span>
                <button type="button" onClick={() => setConfirmingNewKey(true)} disabled={busy} className={buttonCls} data-testid="bot-api-new-key">{t("botApi.newKey")}</button>
              </div>
            )
          )}
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {webhooksLink && (
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleSettings", open: true, section: "access" })}
          className="mt-3 text-[13px] text-ink-secondary hover:text-ink"
          data-testid="bot-api-webhooks"
        >
          {webhooksLine(webhookCount)}
        </button>
      )}
    </div>
  );
}
