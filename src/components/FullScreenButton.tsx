import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { useCaptionChrome, useDesktopCapabilities } from "./DesktopCapabilities";

/**
 * Full screen under the bot's screen. Without control it only watches: the bot keeps working and the picture fills
 * the window, with Take control as its own button. With control held it goes on into the live desktop, as before.
 */
export function FullScreenButton({ held, frame, name, disabled, takeDisabled, error, onTakeControl }: {
  held: boolean;
  /** The latest watched frame of the bot's screen. */
  frame: string | null;
  name: string;
  disabled: boolean;
  /** The overlay's Take control is off for the same reasons as the panel's own Take control. */
  takeDisabled: boolean;
  /** Why the last control request failed, shown over the picture so a refused Take control keeps watching. */
  error: string | null;
  /** Take control; `true` opens the live desktop full screen. */
  onTakeControl: (expand: boolean) => void;
}) {
  const [watching, setWatching] = useState(false);
  const stopWatching = useCallback(() => setWatching(false), []);

  // Once control is held the live desktop takes over; handing it back returns to the panel, not to this view.
  useEffect(() => {
    if (held) setWatching(false);
  }, [held]);

  return (
    <>
      <button
        type="button"
        onClick={() => (held ? onTakeControl(true) : setWatching(true))}
        disabled={disabled}
        className="flex flex-auto items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        title={t(held ? "computer.openLiveDesktop" : "computer.watchFullScreenTitle")}
      >
        <Maximize2 size={14} />
        {t("computer.fullScreen")}
      </button>
      {watching && !held && (
        <WatchFullScreen
          frame={frame} name={name} takeDisabled={takeDisabled} error={error}
          onClose={stopWatching} onTakeControl={() => onTakeControl(true)}
        />
      )}
    </>
  );
}

/** The watch-only view: Tab stays inside it, and focus goes back to Full screen when it closes. */
function WatchFullScreen({ frame, name, takeDisabled, error, onClose, onTakeControl }: {
  frame: string | null;
  name: string;
  takeDisabled: boolean;
  error: string | null;
  onClose: () => void;
  onTakeControl: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const { dragProps, noDragStyle } = useCaptionChrome();
  const macInset = useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
  useModalDialog(dialogRef, onClose);
  // After the dialog has noted Full screen as the place to return to, so autoFocus can't take that place.
  useEffect(() => exitRef.current?.focus(), []);

  useEffect(() => {
    // Capture, and claim the key, so the same press cannot also close something beneath the overlay.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const iconButton = "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
  const label = t("computer.screenOf", { name });
  return (
    <div ref={dialogRef} tabIndex={-1} data-watch-full-screen role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-[65] flex flex-col bg-app outline-none">
      <header {...dragProps} className={cn("flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/40 bg-panel px-3 py-2", macInset && "pl-[86px]")}>
        <span className="min-w-0 truncate text-[13px] font-medium text-ink">{label}</span>
        <span className="pointer-events-none rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
          {t("computer.watchingBotWorks")}
        </span>
        <button ref={exitRef} type="button" style={noDragStyle} onClick={onClose} className={cn(iconButton, "ml-auto bg-control text-ink hover:bg-raised-hover")}>
          <Minimize2 size={14} aria-hidden="true" />
          <span className="max-sm:hidden">{t("desktopViewer.exitFullscreen")}</span>
        </button>
        <button
          type="button"
          style={noDragStyle}
          onClick={onTakeControl}
          disabled={takeDisabled}
          className={cn(iconButton, "bg-accent font-medium text-accent-ink hover:brightness-110")}
          title={t("computer.takeControlTitle")}
        >
          <Hand size={14} aria-hidden="true" />
          {t("computer.takeControl")}
        </button>
      </header>
      {error && (
        <div role="alert" className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-inset">
        {frame ? (
          <img src={frame} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            {t("computer.waitingFrame")}
          </span>
        )}
      </div>
    </div>
  );
}
