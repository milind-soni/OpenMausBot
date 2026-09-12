import { useEffect, useState, type CSSProperties } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/**
 * The Windows caption buttons (minimize / restore / maximize / close), drawn
 * by the renderer because the WCO overlay API cannot style hover. Styled with
 * the app's own tokens — same hover and ink colors as every header button —
 * so they read as part of the app, not as a foreign system strip.
 *
 * Sits absolutely at the window's top-right corner over the chat header,
 * which is a drag region; the buttons themselves opt out of it.
 */
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

  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;
  const captionButton = cn(
    "flex h-[26px] w-11 items-center justify-center text-ink-secondary",
    "hover:bg-raised hover:text-ink active:bg-raised/60",
  );

  return (
    <div
      aria-hidden
      style={noDrag}
      // Above docked panels (z-20/z-40, earlier in DOM) so they never cover
      // the window controls; true center-screen modals (z-50) still paint
      // over these, as they should.
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
