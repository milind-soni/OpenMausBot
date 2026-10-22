import { useEffect, useState } from "react";
import { Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { updaterMessage, useUpdaterState } from "@/lib/updater";
import { brand } from "../lib/brand";
import { t } from "@/lib/i18n";

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

export function UpdateBanner({ sidebarIndicator = false }: UpdateBannerProps) {
  const s = useUpdaterState();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pending, setPending] = useState<"install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

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
      ? t("update.banner.ready", { app: brand().name, version: s.version ?? "" })
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
        : t("update.banner.restartToFinish")
      : installing
        ? handoff
          ? t("update.banner.copying")
          : updaterMessage(s) || t("update.banner.reopening", { app: brand().name })
        : s.status === "handed-off"
          ? s.terminalOpened
            ? t("update.banner.copiedOpened")
            : t("update.banner.copiedPaste")
          : s.retryable === false
            ? t("update.banner.quitReopen", { error: friendlyError(updaterMessage(s, { restart: false })?.split(" Quit and reopen ")[0]), app: brand().name })
            : friendlyError(updaterMessage(s));

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary" title={subtitle}>
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
        <code className="mt-2.5 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-secondary">
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
