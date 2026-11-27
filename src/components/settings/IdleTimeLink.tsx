import { useContext } from "react";
import { t } from "@/lib/i18n";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { SettingsShellContext } from "./settings-shell";

export const DESKTOP_DETAILS_ANCHOR = "desktop-details";
/** Mirrors localVm.idleTimeoutMinutes' default in server/local-vm-settings.ts; the server is the authority. */
const DEFAULT_IDLE_MINUTES = 480;

/** Private and server desktops share one "Stop idle desktops after", set in Desktop details; elsewhere a line links to it. */
export function IdleTimeLink() {
  const minutes = useStoreSelector((s) => s.config?.localVm?.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES);
  const shell = useContext(SettingsShellContext);
  const dispatch = useStoreDispatch();
  const open = () => (shell ? shell.go("desktops", DESKTOP_DETAILS_ANCHOR) : dispatch({ type: "toggleAppSettings", open: true, section: "desktops" }));
  return (
    <p data-idle-time-link="" className="text-[12px] leading-4 text-ink-secondary">
      {t("vm.idle.shared", { minutes })}{" "}
      <button type="button" onClick={open} className="cursor-pointer text-accent-text hover:underline">{t("vm.idle.change")}</button>
    </p>
  );
}
