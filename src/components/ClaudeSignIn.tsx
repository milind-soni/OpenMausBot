import { useEffect, useState } from "react";
import { ExternalLink, Loader2, LogIn } from "lucide-react";
import { api } from "@/state/store";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { deviceFlowUnavailable, type DeviceSignInStatus } from "./CodexDeviceSignIn";

const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"];

/** Never turn arbitrary process output into a link: only Anthropic's own
 * sign-in pages over https. The server applies the same rule first. */
export function claudeSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = SIGN_IN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return url.protocol === "https:" && trusted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function endedFlow(phase: "expired" | "failed"): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(phase === "failed" ? { message: t("engineSetup.device.flowEnded") } : {}) };
}

/** Settings → Engines → Claude on a hosted server: open Anthropic's sign-in
 * page, paste the code it shows, done. The server drives the unmodified CLI. */
export function ClaudeSignIn({ instanceId }: { instanceId: string }) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"start" | "finish" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const link = claudeSignInLink(auth?.authorizationUrl);

  const refresh = async () => {
    await refreshInstances();
    await refreshModels(instanceId);
  };

  // Expire the link locally when the server says it does, and poll the
  // outcome while a code is being checked.
  useEffect(() => {
    if (auth?.phase !== "waiting" || !auth.flowId) return;
    const remaining = auth.expiresAt ? Date.parse(auth.expiresAt) - Date.now() : Number.NaN;
    const expiryTimer = Number.isFinite(remaining)
      ? window.setTimeout(() => {
          setAuth(endedFlow("expired"));
          setError(null);
        }, Math.max(0, remaining))
      : null;
    return () => {
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    };
  }, [auth]);

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      setAuth(next);
      setCode("");
      if (next.phase === "succeeded") await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    if (!auth?.flowId) return;
    setBusy("finish");
    setError(null);
    try {
      await api(`${base}/complete`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId, code: code.trim() }) });
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/status?flowId=${encodeURIComponent(auth.flowId)}`);
      setAuth(next);
      setCode("");
      if (next.phase === "succeeded") await refresh();
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) {
        // the server already knows the outcome; ask it rather than guess
        try {
          const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/status?flowId=${encodeURIComponent(auth.flowId)}`);
          setAuth(next);
          if (next.phase === "succeeded") await refresh();
          return;
        } catch {
          setAuth(endedFlow("failed"));
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!auth?.flowId) return;
    setBusy("cancel");
    setError(null);
    try {
      await api(`${base}/cancel`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId }) });
      setAuth({ phase: "cancelled", flowId: null, authorizationUrl: null, expiresAt: null });
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) setAuth(endedFlow("failed"));
      else setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  const outcome = auth && auth.phase !== "waiting"
    ? auth.phase === "succeeded"
      ? t("engineSetup.claude.connected")
      : auth.phase === "cancelled"
        ? t("engineSetup.device.cancelled")
        : auth.phase === "expired"
          ? t("engineSetup.device.expired")
          : auth.message || t("engineSetup.device.failed")
    : null;

  return (
    <div className="mt-3 space-y-2" data-claude-sign-in>
      {outcome ? (
        <p role="status" className={auth?.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{outcome}</p>
      ) : null}
      {auth?.phase === "waiting" ? (
        link ? (
          <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
            <a href={link} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110">
              {t("engineSetup.claude.open")} <ExternalLink size={13} />
            </a>
            <label className="block text-[12px] text-ink-secondary" htmlFor={`claude-code-${instanceId}`}>
              {t("engineSetup.claude.codeLabel")}
            </label>
            <input
              id={`claude-code-${instanceId}`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent-border"
            />
            <button
              type="button"
              disabled={busy !== null || code.trim().length < 8}
              onClick={() => void finish()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
            >
              {busy === "finish" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
              {busy === "finish" ? t("engineSetup.claude.finishing") : t("engineSetup.claude.finish")}
            </button>
            {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) ? (
              <p className="text-[11px] text-ink-secondary">{t("engineSetup.device.expires", { time: new Date(auth.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-ink-secondary">{t("engineSetup.claude.security")}</p>
            <button type="button" disabled={busy !== null} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
              {busy === "cancel" ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
            </button>
          </div>
        ) : (
          <p role="alert" className="text-[12px] text-danger">{t("engineSetup.claude.invalidChallenge")}</p>
        )
      ) : auth?.phase !== "succeeded" ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void start()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {busy === "start" ? t("engineSetup.claude.starting") : t("engineSetup.claude.start")}
        </button>
      ) : null}
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
