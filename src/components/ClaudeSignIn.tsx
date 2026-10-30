import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, LogIn } from "lucide-react";
import { api, ApiError, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { engineSignedIn } from "@/lib/product-events";
import { type DeviceSignInStatus } from "./DeviceSignIn";

const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"];

/**
 * Security: never turn arbitrary process output into a link; only Anthropic's own sign-in pages over https. The server
 * applies the same rule first.
 */
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

function ended(phase: "expired" | "failed", message?: string): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(message ? { message } : {}) };
}

/** `autoStart` begins at once and opens Anthropic's page; `onDone` hears the outcome so an account list can close it. */
export function ClaudeSignIn({ instanceId, autoStart = false, onDone }: {
  instanceId: string;
  autoStart?: boolean;
  onDone?: (signedIn: boolean) => void;
}) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"start" | "finish" | "cancel" | null>(autoStart ? "start" : null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const link = claudeSignInLink(auth?.authorizationUrl);

  const succeeded = async () => {
    setAuth({ phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null });
    setCode("");
    engineSignedIn("claude", "code");
    // The sign-in already succeeded: a failed catalog refresh must not read as a failed sign-in.
    try { await refreshInstances(); } catch {}
    try { await refreshModels(instanceId); } catch {}
    onDone?.(true);
  };

  useEffect(() => {
    if (auth?.phase !== "waiting" || !auth.expiresAt) return;
    const remaining = Date.parse(auth.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = window.setTimeout(() => setAuth(ended("expired")), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [auth]);

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      setCode("");
      if (next.phase === "succeeded") return await succeeded();
      setAuth(next);
      const opened = claudeSignInLink(next.authorizationUrl);
      if (opened) await openExternalLink(opened).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void start();
  }, [autoStart]);

  // The server ends the flow once Claude Code accepts the code, so a 200 here is the sign-in itself.
  const finish = async () => {
    if (!auth?.flowId) return;
    setBusy("finish");
    setError(null);
    try {
      await api(`${base}/complete`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId, code: code.trim() }) });
      await succeeded();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("engineSetup.device.failed");
      if (cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status)) {
        setAuth(ended("expired"));
        return;
      }
      // A code Claude Code refused ends the flow; one it never took (a typo) leaves it open to try again.
      const still = await api(`${base}/status?flowId=${encodeURIComponent(auth.flowId)}`)
        .then(({ auth: next }: { auth: DeviceSignInStatus }) => next.phase === "waiting")
        .catch(() => false);
      if (still) setError(message);
      else setAuth(ended("failed", message));
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
    } catch { /* The flow is gone either way. */ }
    setAuth(null);
    setBusy(null);
    onDone?.(false);
  };

  if (auth?.phase === "succeeded") {
    return <p role="status" data-claude-sign-in className="mt-3 text-[12px] text-success">{t("engineSetup.claude.connected")}</p>;
  }

  if (auth?.phase === "waiting" && !link) {
    return <p role="alert" data-claude-sign-in className="mt-3 text-[12px] text-danger">{t("engineSetup.claude.invalidChallenge")}</p>;
  }

  if (auth?.phase === "waiting" && link) {
    return (
      <form data-claude-sign-in className="mt-3 space-y-3 rounded-xl border border-hairline/50 bg-app p-3" onSubmit={(event) => { event.preventDefault(); void finish(); }}>
        <div className="space-y-1.5">
          <p className="text-[12px] font-medium text-ink">{t("accounts.claude.step1")}</p>
          <a href={link} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (window.ogb?.openExternal) { event.preventDefault(); void openExternalLink(link); }
          }} className="flex w-fit items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover">
            {t("accounts.claude.openAgain")} <ExternalLink size={12} />
          </a>
        </div>
        <div className="space-y-1.5">
          <label className="block text-[12px] font-medium text-ink" htmlFor={`claude-code-${instanceId}`}>{t("accounts.claude.step2")}</label>
          <div className="flex gap-2">
            <input
              id={`claude-code-${instanceId}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder={t("accounts.claude.codePlaceholder")}
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent-border"
            />
            <button type="submit" disabled={busy !== null || code.trim().length < 8} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
              {busy === "finish" && <Loader2 size={13} className="animate-spin" />}
              {busy === "finish" ? t("engineSetup.claude.finishing") : t("accounts.claude.finish")}
            </button>
          </div>
        </div>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-ink-secondary">{t("accounts.claude.security")}</p>
          <button type="button" disabled={busy !== null} onClick={() => void cancel()} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
            {t("common.cancel")}
          </button>
        </div>
      </form>
    );
  }

  const outcome = auth?.phase === "expired" ? t("engineSetup.device.expired")
    : auth?.phase === "failed" ? auth.message || t("engineSetup.device.failed") : null;
  return (
    <div className="mt-3 space-y-2" data-claude-sign-in>
      {outcome && <p role="status" className="text-[12px] text-ink-secondary">{outcome}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void start()}
          className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {busy === "start" ? t("engineSetup.claude.starting") : auth || error ? t("engineSetup.device.tryAgain") : t("engineSetup.claude.start")}
        </button>
        {onDone && (auth || error) && busy === null && (
          <button type="button" onClick={() => onDone(false)} className="rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">{t("common.cancel")}</button>
        )}
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
