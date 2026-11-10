import { useCallback, useEffect, useState } from "react";

import { unlessRefused } from "@/lib/admin-scope";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { serverUpdateConfirmBody, serverUpdateView, type ServerUpdateCheck, type ServerUpdateStatus, type ServerUpdateView } from "@/lib/server-update";
import { ApiError } from "@/state/api";
import { api, useStore } from "@/state/store";
import type { AppUpdateAnswer } from "@/types/ogb";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingRow } from "./SettingsPrimitives";

const STATUS = "/api/updates/server";
const POLL_MS = 4_000;

/** This desktop app's version when the window shows a server from the Server menu that may ask for the app's update. */
function askableAppVersion(): string | null {
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  return ogb?.app?.ownPage === false && ogb.appUpdate && ogb.app.version ? ogb.app.version : null;
}

const settled = (status: ServerUpdateStatus | null) => status?.run?.outcome !== "requested" && status?.run?.outcome !== "running";

/** The check every session may read, the admin's button state, and the press. While the server restarts the page's
 * connection drops; the store's own reconnect brings it back (`state.connected`), and only then is the server asked again. */
export function useServerUpdate() {
  const { state } = useStore();
  const connected = state.connected !== false;
  const [check, setCheck] = useState<ServerUpdateCheck | null>(null);
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [appAnswer, setAppAnswer] = useState<AppUpdateAnswer | null>(null);

  const readStatus = useCallback(async () => {
    const next = await unlessRefused(STATUS, () => api<ServerUpdateStatus>(STATUS, { timeoutMs: 20_000 }), null);
    setStatus(next);
    return next;
  }, []);

  const load = useCallback(async () => {
    setChecking(true);
    setFailed(false);
    try {
      const next = await api<ServerUpdateCheck>("/api/updates/check", { timeoutMs: 20_000 });
      setCheck(next);
      if (next.install !== "desktop" && next.install !== "managed") await readStatus().catch(() => null);
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }, [readStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const updating = !settled(status);
  useEffect(() => {
    if (!updating || !connected) return;
    let alive = true;
    const ask = () => void readStatus().then((next) => {
      if (alive && settled(next)) void load();
    }).catch(() => {});
    ask();
    const timer = setInterval(ask, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [updating, connected, readStatus, load]);

  const updateServer = useCallback(async () => {
    setPressed(true);
    setProblem(null);
    try {
      const answer = await api<{ status: ServerUpdateStatus }>(STATUS, { method: "POST", body: "{}", timeoutMs: 20_000 });
      setStatus(answer.status);
    } catch (error) {
      if (error instanceof ApiError) {
        const body = error.body as { status?: ServerUpdateStatus } | undefined;
        if (body?.status) setStatus(body.status);
        setProblem(error.status === 429 ? t("serverUpdate.reason.tooSoon") : error.status === 409 ? null : t("serverUpdate.failed"));
      } else {
        // No answer: the server may already be stopping for the update. Wait for it as if it had said so.
        setStatus((current) => current && { ...current, run: { outcome: "requested", from: current.current, at: Date.now() } });
      }
    } finally {
      setPressed(false);
    }
  }, []);

  const updateApp = useCallback(async () => {
    try {
      setAppAnswer(await window.ogb!.appUpdate!.request());
    } catch {
      setAppAnswer("failed");
    }
  }, []);

  const view: ServerUpdateView = serverUpdateView({ check, status, app: askableAppVersion(), checking, failed, pressed, appAnswer });
  return { check, status, view: problem ? { ...view, note: problem, noteTone: "danger" as const } : view, load, readStatus, updateServer, updateApp };
}

const ACTION_LABEL = {
  check: "settings.updates.check",
  "update-server": "serverUpdate.updateServer",
  "update-app": "serverUpdate.updateApp",
  reload: "settings.simple.updates.reload",
} as const;

/** Settings → Updates on a server's page: one row for what is behind (the server, this app, or both) and the one action
 * that fixes it. A server updated for its owner (this computer's app, a Cloud we run) gets no button. */
export function ServerUpdateRow({ title }: { title: string }) {
  const update = useServerUpdate();
  const [confirming, setConfirming] = useState(false);
  const { view, check, status } = update;
  const press = () => {
    if (view.action === "check") return void update.load();
    if (view.action === "reload") return window.location.reload();
    if (view.action === "update-app") return void update.updateApp();
    if (view.action === "update-server") {
      void update.readStatus().catch(() => null);
      setConfirming(true);
    }
  };
  const release = check?.available && check.releaseUrl && view.action !== "check" ? check.releaseUrl : null;
  return (
    <>
      <SettingRow
        title={title}
        subtitle={[view.label, view.subtitle].filter(Boolean).join(" ")}
        message={view.note ? <span className={view.noteTone === "danger" ? "text-danger" : "text-ink-secondary"}>{view.note}</span> : undefined}
      >
        <div className="flex items-center gap-2">
          {release && (
            <button type="button" className="ui-button" onClick={() => openExternalLink(release)}>{t("settings.simple.updates.seeRelease")}</button>
          )}
          {view.action && (
            <button type="button" className="ui-button" disabled={view.busy} onClick={press}>{t(ACTION_LABEL[view.action])}</button>
          )}
        </div>
      </SettingRow>
      <ConfirmDialog
        open={confirming}
        title={t("serverUpdate.confirmTitle")}
        body={serverUpdateConfirmBody(status?.activeTurns ?? 0)}
        confirmLabel={t("serverUpdate.updateServer")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void update.updateServer();
        }}
      />
    </>
  );
}
