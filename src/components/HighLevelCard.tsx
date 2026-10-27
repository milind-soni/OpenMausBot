import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, MoreHorizontal } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import { openExternalLink } from "@/lib/app-links";
import {
  HIGHLEVEL_API,
  cancelHighLevelSignIn,
  isHighLevelStatus,
  runHighLevelSignIn,
  watchHighLevelSignIn,
  type HighLevelFlow,
  type HighLevelSignInResult,
  type HighLevelStatus,
} from "@/lib/highlevel-sign-in";
import { forgetHighLevelStatus, rememberHighLevelStatus } from "@/lib/highlevel-status";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

const pill = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";
const field = "h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50";

export function HighLevelIcon() {
  return (
    <svg viewBox="0 0 40 40" className="size-10 shrink-0 rounded-[10px]" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#1b5e9b" />
      <path d="M11 11h4.5v7h9v-7H29v18h-4.5v-7h-9v7H11z" fill="#fff" />
    </svg>
  );
}

/** The native HighLevel card in Connected apps: one connection per installation, set up by signing in. */
export function HighLevelCard({ refreshKey = 0, onConnection }: {
  refreshKey?: number;
  /** true once connected, false otherwise, null until the server has answered */
  onConnection?: (connected: boolean | null) => void;
}) {
  const [status, setStatus] = useState<HighLevelStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"connect" | "token" | "disconnect" | null>(null);
  const [flow, setFlow] = useState<HighLevelFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenMode, setTokenMode] = useState(false);
  const [token, setToken] = useState("");
  const [locationId, setLocationId] = useState("");
  const mounted = useRef(true);
  const watching = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<HighLevelStatus | null> => {
    try {
      const response = await api(HIGHLEVEL_API);
      if (!mounted.current) return null;
      if (!isHighLevelStatus(response)) throw new Error(t("highlevel.failed"));
      rememberHighLevelStatus(response);
      setStatus(response);
      setLoadFailed(false);
      return response;
    } catch {
      if (mounted.current) setLoadFailed(true);
      return null;
    }
  }, []);

  const finish = useCallback(async (result: HighLevelSignInResult) => {
    if (!mounted.current) return;
    if (result.phase === "failed") setError(result.message || t("highlevel.failed"));
    else if (result.phase === "expired") setError(t("highlevel.expired"));
    await load();
  }, [load]);

  /** Follows a flow the server already has (after a reload, or started elsewhere) without opening anything. */
  const follow = useCallback((current: HighLevelFlow) => {
    if (watching.current) return;
    const controller = new AbortController();
    watching.current = controller;
    setFlow(current);
    void watchHighLevelSignIn(current, { api, open: openExternalLink, signal: controller.signal })
      .then(finish)
      .finally(() => {
        if (watching.current === controller) watching.current = null;
        if (mounted.current) setFlow(null);
      });
  }, [finish]);

  useEffect(() => {
    mounted.current = true;
    void load().then((loaded) => {
      if (loaded?.state === "connecting" && loaded.flow && mounted.current) follow(loaded.flow);
    });
    return () => {
      mounted.current = false;
      watching.current?.abort();
      watching.current = null;
    };
  }, [load, follow, refreshKey]);

  useEffect(() => {
    onConnection?.(status ? status.state === "connected" : null);
  }, [status, onConnection]);

  const connect = async () => {
    if (busy || watching.current) return;
    // Reserve the tab during the click, before the request consumes the browser's user activation.
    const launch = reserveConnectionPage();
    const controller = new AbortController();
    watching.current = controller;
    setBusy("connect");
    setError(null);
    try {
      const result = await runHighLevelSignIn({
        api,
        signal: controller.signal,
        onStarted: (started) => {
          if (!mounted.current) return;
          setFlow(started);
          setBusy(null);
        },
        open: async (url) => {
          const opened = await launch.open(url);
          launch.cancel();
          if (!opened && mounted.current && !controller.signal.aborted) setError(t("connectors.popupBlockedContinue"));
          return opened;
        },
      });
      await finish(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      launch.cancel();
      if (watching.current === controller) watching.current = null;
      if (mounted.current) {
        setFlow(null);
        setBusy(null);
      }
    }
  };

  const cancel = () => {
    const controller = watching.current;
    if (controller) {
      controller.abort();
      return;
    }
    // A flow the server reported but nobody here is following (its watcher ended): tell the server directly.
    if (flow) void cancelHighLevelSignIn(flow.flowId, api).then(() => load());
  };

  const connectWithToken = async () => {
    if (busy) return;
    const trimmedToken = token.trim();
    const trimmedLocation = locationId.trim();
    if (!trimmedToken || !trimmedLocation) {
      setError(t("highlevel.tokenIncomplete"));
      return;
    }
    setBusy("token");
    setError(null);
    try {
      await api(`${HIGHLEVEL_API}/token`, { method: "POST", body: JSON.stringify({ token: trimmedToken, locationId: trimmedLocation }) });
      if (!mounted.current) return;
      setToken("");
      setLocationId("");
      setTokenMode(false);
      await load();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    if (!window.confirm(t("highlevel.disconnectConfirm"))) return;
    setBusy("disconnect");
    setError(null);
    try {
      await api(HIGHLEVEL_API, { method: "DELETE" });
      forgetHighLevelStatus();
      await load();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (status?.state === "unavailable") return null;

  const state = status?.state ?? null;
  const connecting = flow !== null || busy === "connect" || state === "connecting";
  const connected = state === "connected";
  const needsSignIn = state === "needs-sign-in";
  const description = connected && status?.location?.name
    ? t("highlevel.connectedTo", { name: status.location.name })
    : connected
      ? t("apps.connected")
      : needsSignIn
        ? t("connectors.signedOut")
        : t("highlevel.description");
  const menu = (connected || needsSignIn) && (
    <SidebarPopoverMenu
      placement="below"
      ariaLabel={t("highlevel.menu")}
      triggerClassName="shrink-0"
      items={[{ key: "disconnect", label: t("connectors.disconnect"), disabled: busy !== null, onSelect: () => void disconnect() }]}
      renderTrigger={() => (
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-control/80 text-ink hover:bg-raised-hover">
          {busy === "disconnect" ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={15} aria-hidden="true" />}
        </span>
      )}
    />
  );

  return (
    <div data-app-tile="highlevel" data-highlevel-state={state ?? "loading"} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <HighLevelIcon />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{t("highlevel.title")}</span>
            {connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={description}>{description}</p>
        </div>
        {connecting ? (
          <button type="button" onClick={cancel} className={pill}>{t("mcp.auth.cancel")}</button>
        ) : status === null ? (
          loadFailed
            ? <button type="button" onClick={() => void load()} className={pill}>{t("connectors.action.retry")}</button>
            : <button type="button" disabled className={pill} aria-label={t("common.checking")}><Loader2 size={14} className="animate-spin" /></button>
        ) : connected ? (
          menu
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label={t(needsSignIn ? "highlevel.reconnect" : "highlevel.connect")}
              disabled={busy !== null}
              onClick={() => void connect()}
              className={pill}
            >
              {t(needsSignIn ? "connectors.action.reconnect" : "connectors.action.connect")}
            </button>
            {menu}
          </div>
        )}
      </div>
      <div className="ps-[52px]">
        {connecting && (
          <p role="status" className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-secondary">
            <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" />
            <span>{t("highlevel.finishInBrowser")}</span>
            {flow && (
              <button type="button" onClick={() => void openExternalLink(flow.authorizationUrl).catch(() => setError(t("mcp.auth.openFailed")))} className="text-accent-text underline underline-offset-2">
                {t("mcp.auth.openAgain")}
              </button>
            )}
          </p>
        )}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
        {!connecting && status !== null && !connected && !needsSignIn && (
          tokenMode ? (
            <form
              data-highlevel-token-form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(event) => { event.preventDefault(); void connectWithToken(); }}
            >
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("highlevel.tokenField")}
                placeholder={t("highlevel.tokenField")}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className={field}
              />
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("highlevel.locationField")}
                placeholder={t("highlevel.locationField")}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                className={field}
              />
              <p className="text-[12px] leading-relaxed text-ink-secondary">{t("highlevel.tokenHelp")}</p>
              <div className="flex items-center gap-2">
                <button type="submit" disabled={busy !== null} className={pill}>
                  {busy === "token" ? <Loader2 size={14} className="animate-spin" /> : t("connectors.action.connect")}
                </button>
                <button type="button" onClick={() => { setTokenMode(false); setError(null); }} className="text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink">
                  {t("highlevel.useSignIn")}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => { setTokenMode(true); setError(null); }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
              {t("highlevel.useToken")}
            </button>
          )
        )}
      </div>
    </div>
  );
}
