import { useContext } from "react";
import { t } from "@/lib/i18n";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { SettingsShellContext } from "./settings-shell";

export const DESKTOP_DETAILS_ANCHOR = "desktop-details";
/** Mirrors localVm.idleTimeoutMinutes' default in server/local-vm-settings.ts; the server is the authority. */
const DEFAULT_IDLE_MINUTES = 480;

/** config.json's vpsIdle.timeoutMinutes, which overrides the shared time for server desktops; null when unset. */
export function useServerIdleOverride(): number | null {
  return useStoreSelector((s) => s.config?.vpsIdle?.timeoutMinutes ?? null);
}

/** Private and server desktops share one "Stop idle desktops after", set in Desktop details; elsewhere a line links to it.
 * `servers`: the line sits in server settings, so it shows the server override instead when one is set. */
export function IdleTimeLink({ servers = false }: { servers?: boolean }) {
  const minutes = useStoreSelector((s) => s.config?.localVm?.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES);
  const override = useServerIdleOverride();
  const cloudHome = useStoreSelector((s) => s.config?.cloudHome === true);
  const shell = useContext(SettingsShellContext);
  const dispatch = useStoreDispatch();
  if (servers && override !== null) return <p data-idle-time-link="" className="text-[12px] leading-4 text-ink-secondary">{t("vm.idle.serverOverride", { minutes: override })}</p>;
  // A Cloud home's Desktop details has no idle-time editor, so there is nothing to link to.
  if (cloudHome) return null;
  const open = () => (shell ? shell.go("desktops", DESKTOP_DETAILS_ANCHOR) : dispatch({ type: "toggleAppSettings", open: true, section: "desktops" }));
  return (
    <p data-idle-time-link="" className="text-[12px] leading-4 text-ink-secondary">
      {t("vm.idle.shared", { minutes })}{" "}
      <button type="button" onClick={open} className="cursor-pointer text-accent-text hover:underline">{t("vm.idle.change")}</button>
    </p>
  );
}
