import { useEffect, useState } from "react";
import { Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { updaterMessage, useUpdaterState } from "@/lib/updater";
import { productName } from "../lib/brand";
import { t } from "@/lib/i18n";
import { NoticeToast } from "./NoticeCard";

const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump (status line, every header, stack trace).
function friendlyError(message?: string): string {
  if (!message) return t("update.banner.somethingWrong");
  if (/cannot find .*\.yml|404/i.test(message))
    return t("update.banner.noRelease");
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return t("update.banner.offline");
  return message.split("\n")[0].slice(0, 140);
}

type UpdateBannerProps = {
  sidebarIndicator?: boolean;
};

/** Said once, the first time the person looks at the window after the app updated itself while they were away. */
function UpdatedLine({ version, onSeen }: { version: string; onSeen: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const look = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) setShown(true);
    };
    look();
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [shown]);
  return shown ? <NoticeToast text={t("update.updatedItself", { app: productName(), version })} onDone={onSeen} /> : null;
}

export function UpdateBanner({ sidebarIndicator = false }: UpdateBannerProps) {
  const s = useUpdaterState();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pending, setPending] = useState<"install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

  if (s?.updated && ["idle", "checking", "downloading", "preparing"].includes(s.status)) {
    return <UpdatedLine version={s.updated} onSeen={() => void window.ogb?.updater?.seen?.().catch(() => {})} />;
  }
  if (!s || s.status === "idle" || s.status === "checking" || s.status === "downloading" || s.status === "preparing") return null;
  if (sidebarIndicator && (s.status === "downloaded" || s.status === "installing")) return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  const installing = s.status === "installing";
  // Ubuntu system packages can't be swapped under a running app: the command is copied and a terminal opens.
  const handoff = s.installMode === "handoff";

  const title =
    s.status === "downloaded"
      ? t("update.banner.ready", { app: productName(), version: s.version ?? "" })
      : installing
        ? handoff
          ? t("settings.updates.openingTerminal")
          : t("settings.updates.restarting")
        : s.status === "handed-off"
          ? t("update.banner.finishInTerminal")
          : t("update.banner.failed");
  const subtitle =
    s.status === "downloaded"
      ? handoff
        ? t("update.banner.copyCommand")
        : s.installsByItself
          ? t("update.card.idleNote", { app: productName() })
          : t("update.banner.restartToFinish")
      : installing
        ? handoff
          ? t("update.banner.copying")
          : updaterMessage(s) || t("update.banner.reopening", { app: productName() })
        : s.status === "handed-off"
          ? `${updaterMessage(s) ? `${updaterMessage(s)} ` : ""}${s.terminalOpened ? t("update.banner.copiedOpened") : t("update.banner.copiedPaste")}`
          : s.retryable === false
            ? t("update.banner.quitReopen", { error: friendlyError(updaterMessage(s, { restart: false })?.split(" Quit and reopen ")[0]), app: productName() })
            : friendlyError(updaterMessage(s));

  return (
    <div className="animate-panel-in fixed bottom-4 left-[calc(var(--rail-beside,0px)_+_1rem)] z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {!installing && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title={t("update.banner.dismiss")}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {s.status === "handed-off" && s.command && (
        <code className="mt-2.5 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[12px] whitespace-pre text-ink-secondary">
          {s.command}
        </code>
      )}

      {installing && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> {t(handoff ? "settings.updates.opening" : "settings.updates.restartingShort")}
          </button>
        </div>
      )}

      {!installing && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "downloaded" && (
            <button
              onClick={() => {
                setPending("install");
                void updater.install();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> {t(handoff ? "settings.updates.opening" : "settings.updates.restartingShort")}
                </>
              ) : handoff ? (
                <>
                  <PackageOpen size={13} /> {t("settings.updates.install")}
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> {t("update.card.restart")}
                </>
              )}
            </button>
          )}
          {s.status === "error" && s.retryable !== false && (
            <button
              onClick={() => {
                setPending("check");
                void updater.check();
              }}
              disabled={pending !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:text-ink-secondary disabled:hover:bg-control"
            >
              {pending === "check" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> {t("common.checking")}
                </>
              ) : (
                t("update.card.tryAgain")
              )}
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {t(s.status === "handed-off" || s.retryable === false ? "update.banner.dismiss" : "update.card.later")}
          </button>
        </div>
      )}
    </div>
  );
}
