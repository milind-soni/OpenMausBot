import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, LogIn } from "lucide-react";
import { api, ApiError, useStore } from "@/state/store";
import { t } from "@/lib/i18n";

export interface DeviceSignInStatus {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  flowId: string | null;
  authorizationUrl: string | null;
  userCode?: string;
  expiresAt: string | null;
  message?: string;
}

export function deviceFlowUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status);
}

function endedFlow(phase: "expired" | "failed"): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(phase === "failed" ? { message: t("engineSetup.device.flowEnded") } : {}) };
}

/** Never turn arbitrary process output into a sign-in link. The server also
 * validates this address before returning a device challenge. */
export function codexDeviceLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://auth.openai.com" &&
      /^\/codex\/device\/?$/.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash
      ? url.href : null;
  } catch { return null; }
}

export function DeviceSignInProgress({ auth }: { auth: DeviceSignInStatus }) {
  const [copied, setCopied] = useState(false);
  const link = codexDeviceLink(auth.authorizationUrl);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(auth.userCode!);
      setCopied(true);
    } catch { /* The code remains selectable if clipboard access is blocked. */ }
  };

  if (auth.phase !== "waiting") {
    const label = auth.phase === "succeeded" ? t("engineSetup.device.connected")
      : auth.phase === "cancelled" ? t("engineSetup.device.cancelled")
      : auth.phase === "expired" ? t("engineSetup.device.expired")
      : auth.message || t("engineSetup.device.failed");
    return <p role="status" className={auth.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{label}</p>;
  }

  if (!link || !auth.userCode || !/^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(auth.userCode)) {
    return <p role="alert" className="text-[12px] text-danger">{t("engineSetup.device.invalidChallenge")}</p>;
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
      <p className="text-[12px] text-ink-secondary">{t("engineSetup.device.enterCode")}</p>
      <div className="flex items-center justify-between gap-2 rounded-lg bg-inset px-3 py-2">
        <code className="select-all font-mono text-lg font-semibold tracking-widest text-ink">{auth.userCode}</code>
        <button
          type="button"
          aria-label={t("engineSetup.device.copyCode")}
          onClick={() => void copy()}
          className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink"
        >
          {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
        </button>
      </div>
      <a href={link} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110">
        {t("engineSetup.device.openChatGPT")} <ExternalLink size={13} />
      </a>
      <p role="status" className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
        <Loader2 size={12} className="animate-spin" /> {t("engineSetup.device.waiting")}
      </p>
      {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) && (
        <p className="text-[11px] text-ink-secondary">{t("engineSetup.device.expires", { time: new Date(auth.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>
      )}
      <p className="text-[11px] leading-relaxed text-ink-secondary">{t("engineSetup.device.security")}</p>
    </div>
  );
}

export function CodexDeviceSignIn({ instanceId }: { instanceId: string }) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;

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
            setAuth(endedFlow("failed"));
            setError(null);
            return;
          }
          setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
          // Retry transient connectivity failures without creating another login.
          setAuth({ ...auth });
        });
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      controller.abort();
    };
  }, [auth, base, busy, instanceId, refreshInstances, refreshModels]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      setAuth(next);
      if (next.phase === "succeeded") await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
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
      if (deviceFlowUnavailable(cause)) setAuth(endedFlow("failed"));
      else setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 space-y-2" data-codex-device-sign-in>
      {auth && <DeviceSignInProgress auth={auth} />}
      {auth?.phase === "waiting" ? (
        <button type="button" disabled={busy} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
          {busy ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
        </button>
      ) : auth?.phase !== "succeeded" && (
        <button type="button" disabled={busy} onClick={() => void start()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {busy ? t("engineSetup.device.starting") : t("engineSetup.device.start")}
        </button>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <p className="text-[11px] leading-relaxed text-ink-secondary">{t("engineSetup.device.enableHint")}</p>
    </div>
  );
}
