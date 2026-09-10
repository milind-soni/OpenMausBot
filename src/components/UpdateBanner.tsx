// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge. Renders nothing in the browser/dev (no bridge)
// and while idle/checking; appears only when actionable: an update to
// download, a download in progress, a restart to apply, or an error.
import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { brand } from "../lib/brand";

// The one action button in the card. Disabled drops the accent fill for the
// flat raised grey — the "I heard you" the click needs while the main process
// gets going.
const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name the two cases that actually happen and clip anything else to its
// first line.
function friendlyError(message?: string): string {
  if (!message) return t("update.somethingWrong");
  if (/cannot find .*\.yml|404/i.test(message))
    return t("update.noRelease");
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return t("update.unreachable");
  return message.split("\n")[0].slice(0, 140);
}

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the popup returns for the next
  // update (and when an available one finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"download" | "install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

  if (!s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  // while busy the card owns the moment: no dismissing, no second click
  const installing = s.status === "installing";
  const preparing = s.status === "preparing";
  const busy = s.status === "downloading" || preparing || installing;
  // Ubuntu system packages can't be swapped under a running app, so the
  // command is copied and a terminal opens; the user finishes there.
  // Nothing restarts, and the card has to stop promising that it will.
  const handoff = s.installMode === "handoff";

  const title =
    s.status === "available"
      ? `${brand().name} ${s.version} is available`
      : s.status === "downloading"
        ? t("update.downloading", { version: s.version ?? t("update.versionFallback") })
        : preparing
          ? t("update.preparing")
          : s.status === "downloaded"
            ? `${s.version} is ready`
            : installing
              ? handoff
                ? t("update.openingTerminal")
                : t("update.restarting")
              : s.status === "handed-off"
                ? t("update.finishInTerminal")
                : t("update.failed");
  const subtitle =
    s.status === "available"
      ? t("update.readyToDownload")
      : s.status === "downloading"
        ? // no percent yet means the transfer hasn't reported in — don't imply 0
          s.percent == null
          ? t("update.startingDownload")
          : `${Math.round(s.percent)}%`
        : preparing
          ? t("update.downloadComplete")
          : s.status === "downloaded"
            ? handoff
              ? t("update.copyCommandHint")
              : t("update.restartToFinish")
            : installing
              ? handoff
                ? t("update.copying")
                : s.message || t("update.willReopen", { app: brand().name })
              : s.status === "handed-off"
                ? s.terminalOpened
                  ? t("update.copiedPasteOpen")
                  : t("update.copiedPaste")
                : s.retryable === false
                  ? t("update.quitReopen", { name: brand().name })
                  : friendlyError(s.message);

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
        {!busy && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title={t("update.dismiss")}
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

      {s.status === "downloading" && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-control">
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width]",
              // before the first progress report, a sliver that breathes beats
              // a zero-width bar that looks stalled
              s.percent == null && "w-1/4 animate-pulse",
            )}
            style={s.percent == null ? undefined : { width: `${Math.min(100, Math.max(0, s.percent))}%` }}
          />
        </div>
      )}

      {(preparing || installing) && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> {preparing ? t("update.preparingShort") : handoff ? t("update.opening") : t("update.restartingShort")}
          </button>
        </div>
      )}

      {!busy && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && (
            <button
              onClick={() => {
                setPending("download");
                void updater.download();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "download" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> {t("update.starting")}
                </>
              ) : (
                <>
                  <ArrowDownToLine size={13} /> {t("update.download")}
                </>
              )}
            </button>
          )}
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
                  <Loader2 size={13} className="animate-spin" /> {handoff ? t("update.opening") : t("update.restartingShort")}
                </>
              ) : handoff ? (
                <>
                  <PackageOpen size={13} /> {t("update.install")}
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> {t("update.restartToUpdate")}
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
                t("computer.linux.tryAgain")
              )}
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {/* after a hand-off there is nothing left to postpone */}
            {s.status === "handed-off" || s.retryable === false ? t("update.dismiss") : t("update.later")}
          </button>
        </div>
      )}
    </div>
  );
}
