// The one in-app sign-in with a code for an engine's CLI on the machine
// running OpenMausBot: Codex with a ChatGPT account, Grok Build with a
// grok.com account (a one-time code entered at the provider's page), and the
// ChatGPT plan (a browser page, no code). The same card on the desktop, a
// self-hosted server and My Cloud.
import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, LogIn, X } from "lucide-react";
import { api, ApiError, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { useCopyFeedback } from "@/lib/copy-text";
import type { LocaleKey } from "@/locales";
import { deviceSignInLink, isDeviceSignInCode, type DeviceSignInProvider } from "../../shared/device-sign-in";
import { CodexMark } from "./ProviderIcons";

export interface DeviceSignInStatus {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  flowId: string | null;
  authorizationUrl: string | null;
  userCode?: string;
  expiresAt: string | null;
  message?: string;
}

/** Whose page an engine's device code is entered at. */
export function deviceSignInProvider(driverKind: string): DeviceSignInProvider {
  return driverKind === "grokAgent" ? "grok" : "codex";
}

/** The words that differ by whose account the code signs in. */
export const DEVICE_SIGN_IN_COPY: Record<DeviceSignInProvider, Record<"description" | "start" | "enterCode" | "open" | "security" | "connected" | "connectedAccount" | "failed" | "invalidChallenge", LocaleKey>> = {
  codex: {
    description: "engineSetup.device.description",
    start: "engineSetup.device.start",
    enterCode: "engineSetup.device.enterCode",
    open: "engineSetup.device.openChatGPT",
    security: "engineSetup.device.security",
    connected: "engineSetup.device.connected",
    connectedAccount: "engineSetup.device.connectedAccount",
    failed: "engineSetup.device.failed",
    invalidChallenge: "engineSetup.device.invalidChallenge",
  },
  grok: {
    description: "engineSetup.grok.description",
    start: "engineSetup.grok.start",
    enterCode: "engineSetup.grok.enterCode",
    open: "engineSetup.grok.open",
    security: "engineSetup.grok.security",
    connected: "engineSetup.grok.connected",
    connectedAccount: "engineSetup.grok.connectedAccount",
    failed: "engineSetup.grok.failed",
    invalidChallenge: "engineSetup.grok.invalidChallenge",
  },
};

export function deviceFlowUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status);
}

function endedFlow(phase: "expired" | "failed", browserPkce = false): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(phase === "failed" ? { message: t(browserPkce ? "engineSetup.chatgpt.flowEnded" : "engineSetup.device.flowEnded") } : {}) };
}

/** Never turn arbitrary process output into a sign-in link. The server also
 * validates this address before returning a device challenge. */
export function codexDeviceLink(value: string | null): string | null {
  return deviceSignInLink("codex", value);
}

export function chatgptPlanLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize" &&
      !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

const chatgptButton = "flex w-full items-center justify-center gap-2 rounded-lg border border-black/20 bg-white px-3 py-2 text-[12.5px] font-semibold text-black hover:opacity-85 disabled:opacity-50";

export function DeviceSignInProgress({ auth, browserPkce = false, provider = "codex" }: { auth: DeviceSignInStatus; browserPkce?: boolean; provider?: DeviceSignInProvider }) {
  // The code stays select-all, so one click selects it for Cmd/Ctrl+C when copying is blocked.
  const { state: codeCopy, copy: copyCode } = useCopyFeedback(auth.userCode ?? "");
  const copy = DEVICE_SIGN_IN_COPY[provider];
  const link = browserPkce ? chatgptPlanLink(auth.authorizationUrl) : deviceSignInLink(provider, auth.authorizationUrl, auth.userCode);
  const copyLabel = t(codeCopy === "failed" ? "common.copyFailed" : "engineSetup.device.copyCode");

  if (auth.phase !== "waiting") {
    const label = auth.phase === "succeeded" ? t(copy.connected)
      : auth.phase === "cancelled" ? t(browserPkce ? "engineSetup.chatgpt.cancelled" : "engineSetup.device.cancelled")
      : auth.phase === "expired" ? t(browserPkce ? "engineSetup.chatgpt.expired" : "engineSetup.device.expired")
      : auth.message || t(browserPkce ? "engineSetup.chatgpt.failed" : copy.failed);
    return <p role="status" className={auth.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{label}</p>;
  }

  if (!link || (!browserPkce && !isDeviceSignInCode(provider, auth.userCode))) {
    return <p role="alert" className="text-[12px] text-danger">{t(browserPkce ? "engineSetup.chatgpt.invalidChallenge" : copy.invalidChallenge)}</p>;
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
      {!browserPkce && <><p className="text-[12px] text-ink-secondary">{t(copy.enterCode)}</p>
      <div className="flex items-center justify-between gap-2 rounded-lg bg-inset px-3 py-2">
        <code className="select-all font-mono text-lg font-semibold tracking-widest text-ink">{auth.userCode}</code>
        <button
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={copyCode}
          className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink"
        >
          {codeCopy === "copied" ? <Check size={15} className="text-success" /> : codeCopy === "failed" ? <X size={15} className="text-danger" /> : <Copy size={15} />}
        </button>
      </div></>}
      <a href={link} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        if (window.ogb?.openExternal) { event.preventDefault(); void openExternalLink(link); }
      }} className={browserPkce ? chatgptButton : "flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110"}>
        {browserPkce && <CodexMark size={16} className="fill-current" />}
        {t(browserPkce ? "engineSetup.chatgpt.start" : copy.open)} <ExternalLink size={13} />
      </a>
      <p role="status" className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
        <Loader2 size={12} className="animate-spin" /> {t("engineSetup.device.waiting")}
      </p>
      {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) && (
        <p className="text-[11px] text-ink-secondary">{t(browserPkce ? "engineSetup.chatgpt.expires" : "engineSetup.device.expires", { time: new Date(auth.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>
      )}
      <p className="text-[11px] leading-relaxed text-ink-secondary">{t(browserPkce ? "engineSetup.chatgpt.security" : copy.security)}</p>
    </div>
  );
}

export function DeviceSignIn({ instanceId, browserPkce = false, provider = "codex" }: { instanceId: string; browserPkce?: boolean; provider?: DeviceSignInProvider }) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const copy = DEVICE_SIGN_IN_COPY[provider];
  const failed = t(browserPkce ? "engineSetup.chatgpt.failed" : copy.failed);

  const refresh = async () => {
    await refreshInstances();
    await refreshModels(instanceId);
  };

  useEffect(() => {
    if (busy || auth?.phase !== "waiting" || !auth.flowId) return;
    const controller = new AbortController();
    const remaining = auth.expiresAt ? Date.parse(auth.expiresAt) - Date.now() : Number.NaN;
    // Also expire the UI if the connection hangs or the server was restarted.
    // No credentials are removed: this only discards an obsolete challenge.
    const expiryTimer = Number.isFinite(remaining)
      ? window.setTimeout(() => { controller.abort(); setAuth(endedFlow("expired")); setError(null); }, Math.max(0, remaining))
      : null;
    const timer = window.setTimeout(() => {
      void api(`${base}/status?flowId=${encodeURIComponent(auth.flowId!)}`, { signal: controller.signal })
        .then(async ({ auth: next }: { auth: DeviceSignInStatus }) => {
          if (controller.signal.aborted) return;
          setAuth(next);
          setError(null);
          if (next.phase === "succeeded") {
            await refreshInstances();
            await refreshModels(instanceId);
          }
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (deviceFlowUnavailable(cause)) {
            setAuth(endedFlow("failed", browserPkce));
            setError(null);
            return;
          }
          setError(cause instanceof Error ? cause.message : failed);
          // Retry transient connectivity failures without creating another login.
          setAuth({ ...auth });
        });
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      controller.abort();
    };
  }, [auth, base, browserPkce, busy, failed, instanceId, refreshInstances, refreshModels]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      setAuth(next);
      if (next.phase === "succeeded") await refresh();
      else if (browserPkce && next.phase === "waiting") {
        const link = chatgptPlanLink(next.authorizationUrl);
        if (link) await openExternalLink(link);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failed);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!auth?.flowId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/cancel`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId }) });
      setAuth({ phase: "cancelled", flowId: null, authorizationUrl: null, expiresAt: null });
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) setAuth(endedFlow("failed", browserPkce));
      else setError(cause instanceof Error ? cause.message : failed);
    } finally { setBusy(false); }
  };

  // A cancelled, expired or failed sign-in has one next step: a new code.
  const startLabel = busy ? t(browserPkce ? "engineSetup.chatgpt.starting" : "engineSetup.device.starting")
    : auth || error ? t("engineSetup.device.tryAgain")
    : t(browserPkce ? "engineSetup.chatgpt.start" : copy.start);

  return (
    <div className="mt-3 space-y-2" data-device-sign-in={provider} data-chatgpt-plan-sign-in={browserPkce || undefined}>
      {auth && <DeviceSignInProgress auth={auth} browserPkce={browserPkce} provider={provider} />}
      {auth?.phase === "waiting" ? (
        <button type="button" disabled={busy} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
          {busy ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
        </button>
      ) : auth?.phase !== "succeeded" && (
        <button type="button" disabled={busy} onClick={() => void start()} className={browserPkce ? chatgptButton : "flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : browserPkce ? <CodexMark size={16} className="fill-current" /> : <LogIn size={14} />}
          {startLabel}
        </button>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {!browserPkce && provider === "codex" && <p className="text-[11px] leading-relaxed text-ink-secondary">{t("engineSetup.device.enableHint")}</p>}
    </div>
  );
}
