//A sign-in whose engine opens the person's browser itself (Mistral Vibe's ACP authenticate): the app starts the
// flow, then only polls until the engine reports it done — there is no link or code to show.
import { useEffect, useRef, useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { api, useStore } from "@/state/store";
import { intlLocale, t } from "@/lib/i18n";
import { engineSignedIn } from "@/lib/product-events";
import { deviceFlowUnavailable, type DeviceSignInStatus } from "./DeviceSignIn";

function ended(phase: "failed" | "expired"): DeviceSignInStatus {
  return {
    phase, flowId: null, authorizationUrl: null, expiresAt: null,
    ...(phase === "failed" ? { message: t("engineSetup.engineBrowser.failed") } : {}),
  };
}

/** A start button, a spinner while the person finishes in their browser, and the outcome. */
export function EngineBrowserSignIn({ instanceId, autoStart = false, onDone }: {
  instanceId: string;
  autoStart?: boolean;
  onDone?: (signedIn: boolean) => void;
}) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [busy, setBusy] = useState(autoStart);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const failed = t("engineSetup.engineBrowser.failed");

  // The sign-in already succeeded: a failed catalog refresh must not read as a failed sign-in.
  const refresh = async () => {
    engineSignedIn("mistral_vibe", "browser");
    try { await refreshInstances(); } catch {}
    try { await refreshModels(instanceId); } catch {}
    onDone?.(true);
  };

  useEffect(() => {
    if (busy || auth?.phase !== "waiting" || !auth.flowId) return;
    const controller = new AbortController();
    const remaining = auth.expiresAt ? Date.parse(auth.expiresAt) - Date.now() : Number.NaN;
    const expiryTimer = Number.isFinite(remaining)
      ? window.setTimeout(() => { controller.abort(); setAuth(ended("expired")); setError(null); }, Math.max(0, remaining))
      : null;
    const timer = window.setTimeout(() => {
      void api(`${base}/status?flowId=${encodeURIComponent(auth.flowId!)}`, { signal: controller.signal })
        .then(async ({ auth: next }: { auth: DeviceSignInStatus }) => {
          if (controller.signal.aborted) return;
          setAuth(next);
          setError(null);
          if (next.phase === "succeeded") await refresh();
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (deviceFlowUnavailable(cause)) {
            setAuth(ended("failed"));
            setError(null);
            return;
          }
          setError(cause instanceof Error ? cause.message : failed);
          setAuth({ ...auth });
        });
    }, 2000);
    return () => {
      window.clearTimeout(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      controller.abort();
    };
  }, [auth, base, busy, failed, instanceId, refreshInstances, refreshModels, onDone]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      setAuth(next);
      if (next.phase === "succeeded") await refresh();
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
      onDone?.(false);
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) setAuth(ended("failed"));
      else setError(cause instanceof Error ? cause.message : failed);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void start();
  }, [autoStart]);

  const startLabel = busy ? t("engineSetup.engineBrowser.starting")
    : auth || error ? t("engineSetup.device.tryAgain")
    : t("engineSetup.engineBrowser.start");

  if (auth && auth.phase !== "waiting") {
    const label = auth.phase === "succeeded" ? t("engineSetup.engineBrowser.connected")
      : auth.phase === "cancelled" ? t("engineSetup.engineBrowser.cancelled")
      : auth.phase === "expired" ? t("engineSetup.engineBrowser.expired")
      : auth.message || failed;
    return (
      <div data-engine-browser-sign-in className="mt-3 space-y-2">
        <p role="status" className={auth.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{label}</p>
        {auth.phase !== "succeeded" && (
          <button type="button" disabled={busy} onClick={() => void start()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
            <LogIn size={14} />
            {startLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2" data-engine-browser-sign-in>
      {auth?.phase !== "succeeded" && (
        <button type="button" disabled={busy} onClick={() => void start()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {startLabel}
        </button>
      )}
      {auth?.phase === "waiting" && (
        <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <Loader2 size={12} className="animate-spin" /> {t("engineSetup.engineBrowser.waiting")}
          </p>
          {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) && (
            <p className="text-[11px] text-ink-secondary">{t("engineSetup.engineBrowser.expires", { time: new Date(auth.expiresAt).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }) })}</p>
          )}
          <button type="button" disabled={busy} onClick={() => void cancel()}
            className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
            {busy ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
