import { useEffect, useState, type CSSProperties } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Drawn by the renderer because the WCO overlay API cannot style hover. They fill the right end of the window frame's
 * top bar (WindowFrameBar), which keeps their width clear. */
export function WindowCaptionButtons({ visible }: { visible: boolean }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const controls = window.ogb?.windowControls;
    if (!controls) return;
    let alive = true;
    void controls.state().then(({ maximized }) => {
      if (alive) setMaximized(maximized);
    });
    const unsubscribe = controls.onMaximizedChanged((value) => setMaximized(value));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!visible) return null;
  const controls = window.ogb?.windowControls;

  // SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type; the renderer accepts it as an inline
  // style.
  const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;
  const captionButton = cn(
    "flex h-7 w-11 items-center justify-center text-ink-secondary",
    "hover:bg-raised hover:text-ink active:bg-raised/60",
  );

  return (
    <div
      aria-hidden
      style={noDrag}
      // z-40: above docked panels (z-20/z-40, earlier in the DOM); centre-screen modals (z-50) still paint over.
      className="absolute right-0 top-0 z-40 flex items-stretch"
    >
      <button
        type="button"
        aria-label={t("window.minimize")}
        title={t("window.minimize")}
        className={captionButton}
        onClick={() => void controls?.minimize()}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        title={maximized ? t("window.restore") : t("window.maximize")}
        className={captionButton}
        onClick={() => void controls?.toggleMaximize()}
      >
        {maximized ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        aria-label={t("window.close")}
        title={t("window.close")}
        className={cn(captionButton, "hover:bg-danger/25 hover:text-danger")}
        onClick={() => void controls?.close()}
      >
        <X size={15} />
      </button>
    </div>
  );
}
