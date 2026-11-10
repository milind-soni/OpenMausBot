import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PlugZap, RefreshCw, X } from "lucide-react";

import { FIRST_HOUR_OFFER_KEY } from "../../shared/person-wait";
import { api, type Bot, type Message } from "@/state/store";
import { ApiError } from "@/state/api";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { AUTHORIZATION_LINK_MS, reserveConnectionPage, reusableConnectionUrl, type PendingAuthorization } from "@/lib/connector-oauth";
import { accountAliasTaken, requiresAccountAlias } from "@/lib/connector-status";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { cn } from "@/lib/cn";
import { askPrimary, ASK_QUIET_BUTTON, AskCard, AskSettledLine } from "./AskCard";
import { CardHint } from "./CardHint";

const STATUS_CHECK_MS = 4_000;
/** Composio marks an unfinished account EXPIRED shortly after its link lapses; the card keeps asking until it can say so. */
const STATUS_WATCH_MS = AUTHORIZATION_LINK_MS + 2 * 60 * 1_000;

export function ConnectorCard({ botId, color, threadId, message }: { botId: string; color?: Bot["color"]; threadId: string; message: Message }) {
  const connector = message.connector!;
  const gone = connector.dismissed || connector.superseded;
  const isMcp = connector.source === "mcp";
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | { key: LocaleKey } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<(PendingAuthorization & { target: string }) | null>(null);
  const [label, setLabel] = useState("");
  const polling = useRef(false);
  const opening = useRef<ReturnType<typeof reserveConnectionPage> | null>(null);

  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const target = `${endpoint}?threadId=${encodeURIComponent(threadId)}`;
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const pendingAuthorization = authorization?.target === target && connector.status !== "failed" && connector.status !== "connected" && !gone
    ? authorization : null;
  const authorizationUrl = reusableConnectionUrl(pendingAuthorization);
  useEffect(() => {
    setBusy(false);
    setLocalError(null);
    setRefusal(null);
    setAuthorization(null);
    setLabel("");
    return () => {
      opening.current?.cancel();
      opening.current = null;
    };
  }, [target, gone]);
  const checkStatus = useCallback(async () => {
    const result = await api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`);
    return Boolean(result.connected);
  }, [endpoint, threadId]);

  useEffect(() => {
    if (connector.status !== "authorizing" || gone) return;
    polling.current = true;
    const startedAt = Date.now();
    const check = () => {
      if (!polling.current) return;
      void checkStatus()
        .then((connected) => {
          if (connected) polling.current = false;
        })
        .catch(() => {});
    };
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= STATUS_WATCH_MS) clearInterval(timer);
      else check();
    }, STATUS_CHECK_MS);
    const onReturn = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      polling.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [checkStatus, gone, connector.status]);

  if (gone) return null;

  const connect = async (alias?: string) => {
    if (busy || opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    const isCurrent = () => opening.current === launch && currentTarget.current === target;
    setBusy(true);
    setLocalError(null);
    setRefusal(null);
    try {
      const reusableUrl = alias ? null : reusableConnectionUrl(pendingAuthorization);
      const createdAt = reusableUrl ? pendingAuthorization!.createdAt : Date.now();
      const result = reusableUrl ? { url: reusableUrl } : await api(`${endpoint}/authorize`, {
          method: "POST",
          body: JSON.stringify(alias ? { threadId, alias } : { threadId }),
        });
      if (!isCurrent()) return;
      const url = mcpSignInLink(typeof result.url === "string" ? result.url : null);
      if (!url) throw new Error(t("connectors.invalidAuthorizationUrl"));
      setAuthorization({ target, url, createdAt });
      if (!await launch.open(url) && isCurrent()) {
        setLocalError({ key: "connectors.card.popupBlocked" });
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (isMcp && error instanceof ApiError && error.status === 409) setRefusal(error.message);
      else setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      launch.cancel();
      if (isCurrent()) {
        opening.current = null;
        setBusy(false);
      }
    }
  };

  const resume = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    opening.current?.cancel();
    opening.current = null;
    setBusy(false);
    setAuthorization(null);
    void api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  };

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing";
  const error = localError ?? connector.error;
  const stopped = connector.stopped === true;
  const errorText = typeof error === "string" ? error : "";
  const labelNeeded = !authorizing && (requiresAccountAlias(errorText) || accountAliasTaken(errorText));

  if (stopped && !connected) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={connector.label}>
        <span className="text-ink-secondary">{connector.label}</span>
        <span> · {t("chat.turnStopped")}</span>
      </AskSettledLine>
    );
  }

  if (connected) {
    return (
      <AskSettledLine
        ariaLabel={connector.label}
        action={!connector.resumed && !stopped && (
          <button type="button" onClick={() => void resume()} disabled={busy} className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t("connectors.card.continueTask")}
          </button>
        )}
        detail={error && <p role="alert" className="ms-[19px] mt-1 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</p>}
      >
        <span className="text-ink-secondary" title={connector.resumed ? t("connectors.card.resumed") : t("connectors.card.paused")}>
          {connector.label}
        </span>
        <span> · {t("connectors.card.connected")}{connector.resumed ? ` · ${t("connectors.card.continuing")}` : stopped ? ` · ${t("chat.turnStopped")}` : ""}</span>
      </AskSettledLine>
    );
  }

  return (
    <AskCard
      tour="connector"
      ariaLabel={connector.label}
      stays={!connector.resumeKey.startsWith(FIRST_HOUR_OFFER_KEY)}
      icon={<PlugZap size={15} />}
      title={isMcp ? t("connectors.card.signInTo", { label: connector.label }) : connector.label}
      explanation={connector.description}
      onDismiss={dismiss}
      dismissLabel={t("connectors.card.notNow")}
      footer={
        <>
          <span className="me-auto flex min-w-0 items-center gap-1.5 text-[12px] text-ink-tertiary">
            {authorizing && <Loader2 size={12} className="shrink-0 animate-spin" />}
            {authorizing ? t("connectors.card.waiting") : t("connectors.card.requested")}
          </span>
          <button
            type="button"
            onClick={() => void connect(labelNeeded ? label.trim() : undefined)}
            disabled={busy || (labelNeeded && !label.trim())}
            {...askPrimary(color)}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : authorizing ? <RefreshCw size={14} /> : <PlugZap size={14} />}
            {authorizing
              ? t("connectors.card.openAgain")
              : connector.status === "failed"
                ? t("connectors.card.tryAgain")
                : t(isMcp ? "connectors.card.signIn" : "connectors.card.connectSecurely")}
          </button>
        </>
      }
    >
      <CardHint id="spot.connector" />
      <p className="text-[12px] text-ink-tertiary">{t(isMcp ? "connectors.card.mcpSignInHint" : "connectors.card.signInHint")}</p>
      {refusal && <p role="status" className="mt-1.5 text-[12px] text-ink-secondary">{refusal}</p>}
      {labelNeeded ? (
        <form
          className="mt-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim()) void connect(label.trim());
          }}
        >
          <p role="alert" className="text-[12px] text-danger">
            {t(requiresAccountAlias(errorText) ? "connectors.aliasNeeded" : "connectors.aliasTaken")}
          </p>
          <input
            value={label}
            maxLength={64}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("connectors.aliasPlaceholder")}
            aria-label={t("connectors.aliasAriaAnother", { service: connector.label })}
            className="mt-1.5 h-8 w-full rounded-full bg-inset px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </form>
      ) : error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</p>}
      {authorizationUrl && (
        <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
          if (!reusableConnectionUrl(pendingAuthorization)) {
            event.preventDefault();
            void connect();
          }
        }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
          {t("connectors.openAuthorizationPage")}
        </a>
      )}
    </AskCard>
  );
}
