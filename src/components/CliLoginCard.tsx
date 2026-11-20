import { useEffect, useState } from "react";
import { TerminalSquare } from "lucide-react";

import type { CliLoginWire } from "../../shared/cli-login";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api } from "@/state/api";
import { NoticeCard, PRIMARY_BUTTON } from "./NoticeCard";

/** The oldest waiting request that has not run out, if any. */
export function cliLoginShown(requests: readonly CliLoginWire[], now: number): CliLoginWire | null {
  return requests.find((request) => request.expiresAt > now) ?? null;
}

/** Above Settings and every dialog: a terminal is waiting on this one click. */
export const CLI_LOGIN_LAYER = "z-[100]";

function useWaitingCliLogins(): [CliLoginWire[], (id: string) => void] {
  const [requests, setRequests] = useState<CliLoginWire[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void api<{ requests?: CliLoginWire[] }>("/api/auth/cli-login")
      .then((answer) => { if (alive) setRequests(answer.requests ?? []); })
      .catch(() => { if (alive) setRequests([]); });
    load();
    const stop = listenLiveFrames({ onFrame: (frame) => { if (frame.kind === "cli-login") load(); }, onMissedFrames: load });
    return () => { alive = false; stop(); };
  }, []);
  return [requests, (id) => setRequests((current) => current.filter((request) => request.id !== id))];
}

function useClock(until: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [until, now]);
  return now;
}

export function CliLoginPrompt() {
  const [requests, forget] = useWaitingCliLogins();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const now = useClock(requests.find((request) => request.expiresAt > Date.now())?.expiresAt);
  const request = cliLoginShown(requests, now);
  if (!request) return null;
  const answer = async (allow: boolean) => {
    setBusy(true);
    setFailed(null);
    try {
      await api(`/api/auth/cli-login/${encodeURIComponent(request.id)}/${allow ? "allow" : "deny"}`, { method: "POST", body: "{}" });
      forget(request.id);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const chatOnly = !request.scopes.includes("admin");
  return <NoticeCard titleId="cli-login-title" notice="cli-login" layer={CLI_LOGIN_LAYER} icon={TerminalSquare} title={t("cliLogin.title")}
    dismissLabel={t("cliLogin.deny")} onDismiss={() => void answer(false)}>
    <p className="mt-1 text-[13px] text-ink-secondary">
      {request.local ? t("cliLogin.bodyHere") : t("cliLogin.bodyElsewhere", { source: request.source })}
    </p>
    <p data-cli-login-code className="my-2 font-mono text-[20px] font-semibold tracking-[0.2em]">{request.code}</p>
    <p className="mb-1 text-[12px] text-ink-secondary">{t("cliLogin.match")}</p>
    <p className="mb-3 text-[12px] text-ink-secondary">
      {chatOnly ? t("cliLogin.scopeChat") : t("cliLogin.scopeAll")} · {request.label}
    </p>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void answer(true)}>{t("cliLogin.allow")}</button>
      <button type="button" className="py-2 text-[12px] text-ink-secondary hover:text-ink" disabled={busy} onClick={() => void answer(false)}>{t("cliLogin.deny")}</button>
    </div>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{failed}</p>}
  </NoticeCard>;
}

/** A terminal running `openmausbot login` waits here for one click. Only the owner or an admin sees it. */
export function CliLoginCard() {
  return useOwnerOrAdmin() === true ? <CliLoginPrompt /> : null;
}
