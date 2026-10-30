import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { setChromeRailHidden, useChromeRail } from "@/lib/chrome-rail";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { SIMPLE_TOP_TOGGLE } from "./SidebarSimpleTop";

/** The window's rail of places, drawn small: a window with the rail at its left edge and three places on it. */
export function RailStripIcon({ size }: { size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
    <circle cx="6" cy="7.5" r="0.75" fill="currentColor" />
    <circle cx="6" cy="12" r="0.75" fill="currentColor" />
    <circle cx="6" cy="16.5" r="0.75" fill="currentColor" />
  </svg>;
}

/** The sidebar's button that hides and shows the window's rail of places, while this window has one. It takes the look
 * of the top row's other buttons: Simple's, Advanced's, or Advanced's column when the sidebar shows only avatars. */
export function ChromeRailToggle({ advanced, icons, style }: { advanced: boolean; icons: boolean; style?: CSSProperties }) {
  const rail = useChromeRail();
  if (!rail?.available) return null;
  const label = t(rail.hidden ? "rail.show" : "rail.hide");
  return <button type="button" data-rail-toggle aria-label={label} title={label} aria-expanded={!rail.hidden} style={style}
    onClick={() => setChromeRailHidden(!rail.hidden)}
    className={advanced ? cn("flex shrink-0 items-center justify-center text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      icons ? "size-[46px] rounded-xl" : "size-8 rounded-full") : SIMPLE_TOP_TOGGLE}>
    <RailStripIcon size={advanced && icons ? 20 : 18} />
  </button>;
}

/** Settings' switch for the same rail, while this window has one. */
export function ChromeRailRow() {
  const rail = useChromeRail();
  if (!rail?.available) return null;
  return <div data-rail-switch>
    <SettingRow title={t("rail.show")} subtitle={t("rail.showSub")}>
      <Switch checked={!rail.hidden} aria-label={t("rail.show")} onClick={() => setChromeRailHidden(!rail.hidden)} />
    </SettingRow>
  </div>;
}
