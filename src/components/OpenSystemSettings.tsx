import { createElement, Fragment, type ReactNode } from "react";
import { t } from "@/lib/i18n";

/** "Open System Settings" on a line about a permission the computer refused, where the desktop app can open its pane. */
export function OpenSystemSettings({ pane }: { pane: "mic" | "speech" }) {
  const open = typeof window === "undefined" ? undefined : window.ogb?.permOpenSettings;
  if (typeof open !== "function") return null;
  return (
    <button type="button" data-open-system-settings={pane} onClick={() => void open(pane).catch(() => {})}
      className="shrink-0 rounded text-[13px] text-ink-secondary transition-colors hover:text-ink">
      {t("permissions.openSystemSettings")}
    </button>
  );
}

/** A refused-permission line followed by its Open System Settings. */
export function withOpenSettings(text: string, pane: "mic" | "speech"): ReactNode {
  return createElement(Fragment, null, text, " ", createElement(OpenSystemSettings, { pane }));
}
