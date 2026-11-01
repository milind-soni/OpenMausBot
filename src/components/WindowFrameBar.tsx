import { Settings } from "lucide-react";
import { useEffect } from "react";

import { sayFrameDrawn } from "@/lib/chrome-rail";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { ChromeRailToggle } from "./ChromeRailToggle";
import { captionChrome, useDesktopCapabilities, windowFrameable, windowFramed } from "./DesktopCapabilities";
import { UpdateIndicator } from "./UpdateIndicator";
import { WindowPlaceTitle } from "./WindowPlaceTitle";

/** A button in the frame's top bar: small, quiet, the bar's height and no more. */
export const FRAME_BAR_BUTTON = "flex size-[22px] shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

/** The window frame's top bar (windowFramed), as thin as the traffic lights allow: they sit in it on macOS (main puts
 * them there: electron/window-chrome.mjs), the caption buttons on Windows (WindowCaptionButtons, drawn over its right
 * end). The rail's button follows the traffic lights; the place on screen is named in its middle; an update while one
 * waits, and the app's settings, close the right end. The whole bar drags the window. It reaches under the window's
 * rail (the page starts --rail-beside in), so its middle is the window's middle. */
export function WindowFrameBar() {
  const { capabilities } = useDesktopCapabilities();
  const { dispatch } = useStore();
  const frameable = windowFrameable(capabilities), framed = windowFramed(capabilities);
  useEffect(() => { if (frameable) sayFrameDrawn(framed); }, [frameable, framed]);
  if (!framed) return null;
  const mac = capabilities.windowChrome === "mac-inset";
  const { dragProps } = captionChrome(capabilities.windowChrome);
  return (
    <div
      data-window-frame-bar
      {...dragProps}
      className="ml-[calc(-1*var(--rail-beside,0px))] grid h-7 shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-center bg-frame"
    >
      {/* macOS: the traffic lights span 12-72px of the window, so the first button starts at 80px. */}
      <div data-frame-bar-start className={cn("flex items-center gap-0.5", mac ? "pl-20" : "pl-[calc(var(--rail-beside,0px)+8px)]")}>
        <ChromeRailToggle bar={FRAME_BAR_BUTTON} />
      </div>
      <WindowPlaceTitle />
      <div data-frame-bar-end className={cn("flex items-center justify-end gap-0.5", mac ? "pr-2" : "pr-[140px]")}>
        <UpdateIndicator bar={FRAME_BAR_BUTTON} />
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
    </div>
  );
}
