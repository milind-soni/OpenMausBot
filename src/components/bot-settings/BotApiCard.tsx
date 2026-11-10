import { useEffect, useState } from "react";
import { Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { api, useStore, type Bot } from "@/state/store";
import { BOT_API_KEY_PLACEHOLDER, BOT_API_UPGRADE, botApiCurl } from "../../../shared/bot-api";
import { NoteLine, useCloudUsage, useUpgrade } from "../CloudUsageMeter";
import { Switch } from "../SettingsPrimitives";

export interface BotApiCall {
  id: string;
  receivedAt: number;
  outcome: "accepted" | "rejected";
  statusCode: number;
  preview?: string;
  reason?: string;
  repeats?: number;
}

export interface BotApiView {
  enabled: boolean;
  /** Absent from an older server: it takes calls. */
  canTakeCalls?: boolean;
  url: string;
  canManage: boolean;
  callCount: number;
  lastCalledAt?: number;
  calls?: BotApiCall[];
}

/** The key rides only on the answer that made it: nothing keeps it after this view. */
type Minted = BotApiView & { key: string };

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";

export function callsLine(view: Pick<BotApiView, "callCount" | "lastCalledAt">, now = Date.now()): string {
  if (!view.callCount || view.lastCalledAt === undefined) return t("botApi.callsNone");
  const when = relativeTime(view.lastCalledAt, now);
  return view.callCount === 1 ? t("botApi.callsOne", { when }) : t("botApi.calls", { count: view.callCount, when });
}

export function callWords(call: Pick<BotApiCall, "outcome" | "statusCode" | "repeats" | "reason">): string {
  const words = call.reason === BOT_API_UPGRADE ? t("botApi.starter")
    : call.statusCode === 200 ? t("botApi.call.replied")
    : call.statusCode === 202 ? t("botApi.call.accepted")
      : call.statusCode === 401 ? t("botApi.call.wrongKey")
        : call.statusCode === 403 ? t("botApi.call.off")
          : call.statusCode === 429 ? t("automations.calls.tooFast")
            : call.statusCode === 409 ? t("botApi.call.busy")
              : call.statusCode === 413 ? t("automations.calls.tooLarge")
                : call.statusCode === 400 || call.statusCode === 415 ? t("automations.calls.unreadable")
                  : t("botApi.call.failed");
  return call.repeats && call.repeats > 1 ? `${words} (${call.repeats})` : words;
}

const onlyThisComputer = (url: string) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);

export function webhooksLine(count: number): string {
  return count === 0 ? t("botApi.webhooksNone") : count === 1 ? t("botApi.webhooksOne") : t("botApi.webhooks", { count });
}

/** Starter: one line and the usual Upgrade (its preview, then the person's confirmation). Where this page has no way to change the
 * plan, a browser tab on the Cloud's own address, the line stands alone. */
function BotApiStarter({ className }: { className?: string }) {
  const { usage, bridge } = useCloudUsage();
  const upgrade = useUpgrade(bridge, usage, "app_settings");
  return (
    <div className={cn("rounded-xl bg-card p-4", className)} data-testid="bot-api">
      <div className="text-[15px] font-medium text-ink">{t("botApi.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary" data-testid="bot-api-starter">{t("botApi.starter")}</div>
      {bridge && usage && (
        <button type="button" onClick={() => upgrade.start()} disabled={upgrade.busy !== null} className={cn(buttonCls, "mt-3")} data-testid="bot-api-upgrade">{t("roomCard.upgrade")}</button>
      )}
      {upgrade.note && <div className="mt-2"><NoteLine note={upgrade.note} /></div>}
      {upgrade.dialog}
    </div>
  );
}

/** The Bot API, the same in the bot panel and in Bot settings: a switch, the key once, the command to paste. */
export function BotApiCard(props: { bot: Bot; webhooksLink?: boolean; className?: string }) {
  const { state } = useStore();
  return state.config?.cloudStarter === true ? <BotApiStarter className={props.className} /> : <BotApiSection {...props} />;
}

function BotApiSection({ bot, webhooksLink = false, className }: { bot: Bot; webhooksLink?: boolean; className?: string }) {
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
      const { key, ...next } = await request() as BotApiView & { key?: string };
      setView(next);
      setFreshKey(key ?? null);
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
  const refreshCalls = () => { api<BotApiView>(path).then(setView).catch(() => undefined); };
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
      {view?.canTakeCalls === false && <div className="mt-2 text-[13px] text-warning" data-testid="bot-api-cant-take">{t("botApi.cantTake")}</div>}
      {view?.enabled && (
        <div className="mt-3 flex flex-col gap-2">
          <pre data-testid="bot-api-curl" className="whitespace-pre-wrap break-all rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-[1.5] text-ink">{curl}</pre>
          <div className="flex justify-end">
            <button type="button" onClick={() => void copy()} className={cn(buttonCls, "inline-flex items-center gap-1.5")} data-testid="bot-api-copy">
              <Copy size={13} aria-hidden="true" />
              {copied === "copied" ? t("botApi.copied") : copied === "failed" ? t("botApi.copyFailed") : t("botApi.copy")}
            </button>
          </div>
          <div className={cn("text-[12px]", freshKey ? "text-warning" : "text-ink-secondary")} data-testid="bot-api-key-note">
            {freshKey ? t("botApi.keyOnce") : t("botApi.keyHidden")}
          </div>
          <div className="text-[12px] text-ink-secondary" data-testid="bot-api-password">{t("botApi.password")}</div>
          {onlyThisComputer(view.url) && <div className="text-[12px] text-ink-secondary" data-testid="bot-api-local">{t("botApi.localOnly")}</div>}
          {canManage && (
            confirmingNewKey ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
                <span>{t("botApi.newKeyConfirm")}</span>
                <button type="button" onClick={() => void newKey()} disabled={busy} className={buttonCls} data-testid="bot-api-replace">{t("botApi.replace")}</button>
                <button type="button" onClick={() => setConfirmingNewKey(false)} className={buttonCls}>{t("common.cancel")}</button>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <details className="min-w-0 flex-1 text-[12px] text-ink-secondary" data-testid="bot-api-calls" onToggle={(event) => { if (event.currentTarget.open) refreshCalls(); }}>
                  <summary className="cursor-pointer">{callsLine(view)}</summary>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {(view.calls ?? []).map((call) => (
                      <li key={call.id} className="min-w-0 truncate" title={call.preview}>
                        {relativeTime(call.receivedAt)} · {callWords(call)}{call.preview ? ` · ${call.preview}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
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
          onClick={() => dispatch({ type: "showRoutines", view: "list" })}
          className="mt-3 text-[13px] text-ink-secondary hover:text-ink"
          data-testid="bot-api-webhooks"
        >
          {webhooksLine(webhookCount)}
        </button>
      )}
    </div>
  );
}
