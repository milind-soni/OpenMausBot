import { useContext, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { SettingRow } from "../SettingsPrimitives";
import { useOtherPlaces } from "./settings-context";
import { SettingsShellContext } from "./settings-shell";

/** This computer as a Cloud's page can name it, and the way to switch the rail there when this page has one. */
export function useSwitchToComputer(): { name: string; open: (() => void) | null } {
  const page = useContext(SettingsShellContext)?.page;
  const others = useOtherPlaces(page);
  const computer = others.find((place) => place.kind === "computer");
  return { name: computer?.name ?? t("rail.thisComputer"), open: computer?.open ?? null };
}

/** "Change this from This computer. Switch to This computer" */
export function InertReason({ reason }: { reason?: string }) {
  const computer = useSwitchToComputer();
  return <>
    {reason ?? t("settings.inert.fromHere", { place: computer.name })}
    {computer.open && <>{" "}<button type="button" className="cursor-pointer text-accent-text hover:underline focus-visible:underline" onClick={computer.open}>{t("settings.inert.switchHere", { place: computer.name })}</button></>}
  </>;
}

/** A row that applies here but can't be changed from this page: it stays in place, its control at 40%, with the reason
 * and the way there under it. */
export function InertRow({ title, subtitle, control, reason }: { title: string; subtitle?: ReactNode; control?: ReactNode; reason?: string }) {
  return <SettingRow title={title} subtitle={subtitle} inert={<InertReason reason={reason} />}>{control ?? null}</SettingRow>;
}
