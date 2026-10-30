import { Settings } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { ChromeRailToggle } from "./ChromeRailToggle";
import { captionChrome, useDesktopCapabilities, windowFramed } from "./DesktopCapabilities";
import { UpdateIndicator } from "./UpdateIndicator";

/** A button in the frame's top bar: small, quiet, the bar's height and no more. */
export const FRAME_BAR_BUTTON = "flex size-[22px] shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

/** The window frame's top bar (windowFramed), as thin as the traffic lights allow: they sit in it on macOS (main puts
 * them there: electron/window-chrome.mjs), the caption buttons on Windows (WindowCaptionButtons, drawn over its right
 * end). The rail's button follows the traffic lights; an update while there is one, and the app's settings, close the
 * right end. The whole bar drags the window. It starts at the page's left edge, beside the window's rail when that
 * shows, whose own page paints the bar's colour above its places. */
export function WindowFrameBar() {
  const { capabilities } = useDesktopCapabilities();
  const { dispatch } = useStore();
  const chrome = capabilities.windowChrome;
  if (!windowFramed(chrome)) return null;
  const { dragProps } = captionChrome(chrome);
  return (
    <div
      data-window-frame-bar
      {...dragProps}
      // macOS: the traffic lights span 12-72px of the window, so the first button starts at 80px, wherever the page does.
      className={cn("flex h-7 shrink-0 items-center gap-0.5 bg-frame", chrome === "mac-inset" ? "pl-[calc(80px_-_var(--rail-beside,0px))] pr-2" : "pl-2 pr-[140px]")}
    >
      <ChromeRailToggle bar={FRAME_BAR_BUTTON} />
      <div className="min-w-0 flex-1" />
      <UpdateIndicator bar />
      <button
        type="button"
        data-frame-settings
        aria-label={t("sidebar.appSettings")}
        title={t("sidebar.appSettings")}
        onClick={() => dispatch({ type: "toggleAppSettings", open: true })}
        className={FRAME_BAR_BUTTON}
      >
        <Settings size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
