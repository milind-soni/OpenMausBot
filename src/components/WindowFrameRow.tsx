import { useEffect, useState } from "react";

import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import type { WindowFrameState } from "../../electron/desktop-prefs.mjs";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** Settings' switch for the window's own frame, on macOS and Windows: this desktop's choice. macOS changes at once;
 * Windows draws its own title bar only from the next start, which the row says, with a way to restart where this page
 * may. */
export function WindowFrameRow() {
  const { capabilities } = useDesktopCapabilities();
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.windowFrame;
  const [state, setState] = useState<WindowFrameState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.state().then((next) => { if (alive) setState(next); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  const platform = capabilities.host?.platform;
  if (!bridge || !state || (platform !== "darwin" && platform !== "win32")) return null;
  const relaunch = window.ogb?.relaunch;
  const toggle = () => void bridge.set(!state.on).then(setState).catch(() => {});
  return <div data-window-frame-switch>
    <SettingRow title={t("settings.windowFrame.title")} subtitle={t("settings.windowFrame.subtitle")}>
      <Switch checked={state.on} aria-label={t("settings.windowFrame.title")} onClick={toggle} />
    </SettingRow>
    {state.restart && <div role="status" data-window-frame-restart className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 text-[13px] text-ink-secondary">
      <span>{t("settings.windowFrame.restart", { app: productName() })}</span>
      {relaunch && <button type="button" className="ui-button" onClick={() => void relaunch().catch(() => {})}>{t("settings.windowFrame.restartNow")}</button>}
    </div>}
  </div>;
}
