// The update button at the foot of the sidebar and the card it opens.
//
// Updates download by themselves (electron/updater.mjs). While one is on its
// way, or downloaded and waiting for a restart, a small round button sits
// beside the profile icon; the rest of the time there is no button at all.
// It opens a centred card: the version, a few highlights from the release
// notes, and one primary action (the download's progress until it is done,
// then "Restart to update", or "Install" where a terminal finishes the job).
// Restarting is always the person's click; "Later" leaves everything as is.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, Loader2, PackageOpen, RefreshCw, X } from "lucide-react";

import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { releaseHighlights } from "@/lib/release-highlights";
import { RELEASES_URL, appVersion, openExternalLink } from "@/lib/app-links";
import { brand } from "../lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The statuses the button is shown for: an update on its way or waiting. */
export function updateIndicatorShown(state: UpdaterState | null): boolean {
  return Boolean(state && ["downloading", "preparing", "downloaded", "installing"].includes(state.status));
}

/** The button's accessible name, which says what it holds. */
export function updateIndicatorLabel(state: UpdaterState): string {
  const app = brand().name;
  const version = state.version ?? "";
  if (state.status === "downloaded" || state.status === "installing") {
    return t("update.button.ready", { app, version }).replace("  ", " ").trim();
  }
  if (state.status === "preparing") return t("update.button.preparing");
  return state.percent == null
    ? t("update.button.downloadingStart")
    : t("update.button.downloading", { percent: Math.round(state.percent) });
}

export function UpdateIndicator({ className }: { className?: string }) {
  const state = useUpdaterState();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Nothing left to act on (no update, a fresh check, or the deb hand-off now
  // finishing in a terminal, which the popup explains): the card closes. A
  // failure keeps it open, offering Try again.
  const settled = !state || state.status === "idle" || state.status === "checking" || state.status === "handed-off";
  useEffect(() => {
    if (settled) setOpen(false);
  }, [settled]);
  if (!state || !updateIndicatorShown(state)) {
    return open && !settled ? <UpdateCard state={state} onClose={() => setOpen(false)} returnFocusRef={buttonRef} /> : null;
  }
  const label = updateIndicatorLabel(state);
  const ready = state.status === "downloaded";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-update-indicator={state.status}
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        onClick={() => setOpen(true)}
        className={cn(
          "relative flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900 shadow-sm ring-1 ring-black/10 transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          className,
        )}
      >
        <ArrowDown size={16} strokeWidth={2.25} aria-hidden className={cn(!ready && "animate-pulse")} />
      </button>
      {open && <UpdateCard state={state} onClose={() => setOpen(false)} returnFocusRef={buttonRef} />}
    </>
  );
}

// The md button: 28px tall, 13px medium on a 16px line, a full pill, 8px
// between icon and label, the same for both so their labels share a baseline.
const button = "inline-flex h-7 min-w-0 items-center justify-center gap-2 rounded-full px-3.5 text-[13px] font-medium leading-4 transition-colors";
const primary = `${button} bg-accent text-white hover:brightness-110 disabled:cursor-default disabled:bg-control disabled:text-ink-secondary disabled:hover:brightness-100`;
const secondary = `${button} text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50`;

export function UpdateCard({
  state,
  onClose,
  returnFocusRef,
}: {
  state: UpdaterState;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const status = state.status;
  useEffect(() => setPending(false), [status]);

  // Focus moves in on open and back to the button on close; Tab stays inside.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (primaryRef.current && !primaryRef.current.disabled ? primaryRef.current : laterRef.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const target = returnFocusRef?.current?.isConnected ? returnFocusRef.current : opener;
      target?.focus();
    };
  }, [returnFocusRef]);

  const updater = window.ogb?.updater;
  const handoff = state.installMode === "handoff";
  const highlights = releaseHighlights(state.releaseNotes);
  const downloading = status === "downloading" || status === "preparing";
  const percent = status === "downloading" && state.percent != null ? Math.max(0, Math.min(100, Math.round(state.percent))) : null;
  const installing = status === "installing" || pending;
  const failed = status === "error";

  const action = () => {
    if (!updater) return;
    if (status === "downloaded") {
      setPending(true);
      void updater.install();
    } else if (failed && state.retryable !== false) {
      setPending(true);
      void updater.check();
    }
  };

  const primaryLabel = installing
    ? handoff ? t("settings.updates.opening") : t("settings.updates.restartingShort")
    : status === "preparing"
      ? t("settings.updates.preparingShort")
      : downloading
        ? percent == null ? t("update.card.downloadingStart") : t("update.card.downloading", { percent })
        : failed
          ? t("update.card.tryAgain")
          : handoff ? t("settings.updates.install") : t("update.card.restart");
  const primaryIcon = installing || (downloading && percent == null) || status === "preparing"
    ? <Loader2 size={14} className="animate-spin" aria-hidden />
    : downloading
      ? <ArrowDown size={14} aria-hidden />
      : handoff ? <PackageOpen size={14} aria-hidden /> : <RefreshCw size={14} aria-hidden />;

  const note = failed
    ? state.message?.split("\n")[0]?.slice(0, 160) || t("update.card.failed")
    : downloading
      ? t("update.card.downloadingNote")
      : handoff
        ? t("update.card.handoffNote")
        : t("update.card.restartNote", { app: brand().name });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-card-title"
        aria-describedby="update-card-note"
        data-update-card
        className="animate-pop-in relative w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("update.card.close")}
          className="absolute end-3 top-3 flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={16} aria-hidden />
        </button>
        <div className="flex items-center gap-3 pe-8">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900 ring-1 ring-black/10">
            <ArrowDown size={20} strokeWidth={2.25} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="update-card-title" className="text-[17px] font-semibold leading-6 text-ink">
              {t("update.card.title")}
            </h2>
            <p className="text-[13px] leading-5 text-ink-secondary">
              {[state.version ? `${brand().name} ${state.version}` : brand().name, appVersion() ? t("update.card.current", { version: appVersion() }) : ""].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>

        {highlights.length > 0 && (
          <div className="mt-5">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-secondary">{t("update.card.whatsNew")}</h3>
            <ul className="mt-2 space-y-2">
              {highlights.map((line) => (
                <li key={line} className="flex gap-2.5 text-[14px] leading-5 text-ink">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          type="button"
          onClick={() => void openExternalLink(RELEASES_URL)}
          className={cn(highlights.length > 0 ? "mt-3" : "mt-5", "block text-[13px] font-medium leading-5 text-accent hover:underline")}
        >
          {t("update.card.allNotes")}
        </button>

        {percent != null && (
          <div
            className="mt-5 h-1.5 overflow-hidden rounded-full bg-control"
            role="progressbar"
            aria-label={t("update.card.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
        )}

        <p id="update-card-note" className="mt-4 text-[13px] leading-5 text-ink-secondary">{note}</p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={laterRef}
            type="button"
            onClick={onClose}
            disabled={status === "installing"}
            className={secondary}
          >
            {t("update.card.later")}
          </button>
          <button
            ref={primaryRef}
            type="button"
            onClick={action}
            disabled={!updater || installing || downloading || (failed && state.retryable === false)}
            className={primary}
          >
            {primaryIcon}
            <span className="truncate">{primaryLabel}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
