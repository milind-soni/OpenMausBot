import { pageIsThisComputer } from "@/lib/companion-bridge";
import { t } from "@/lib/i18n";
import { useStoreSelector } from "@/state/store-select";
import { useWindowPlace, windowPlaceName } from "../WindowPlaceTitle";

export type PlaceKind = "computer" | "cloud" | "team" | "server";

export interface SettingsPlace {
  name: string;
  kind: PlaceKind;
  color: string | null;
  /** a renamed workspace of this computer's own draws its initials */
  named: boolean;
}

/** The place on screen as Settings names it: the same name as the rail and the title bar, This computer by default. */
export function useSettingsPlace(): SettingsPlace {
  const config = useStoreSelector((state) => state.config);
  const place = useWindowPlace();
  const team = config?.team?.name;
  if (pageIsThisComputer()) {
    const name = place ? windowPlaceName(place, undefined) : t("rail.thisComputer");
    return { name, kind: "computer", color: place?.color ?? null, named: Boolean(place?.profileName) };
  }
  if (config?.cloudHome) {
    const name = place ? windowPlaceName(place, team) : team || t("cloudSetup.myCloud");
    return { name, kind: team ? "team" : "cloud", color: place?.color ?? null, named: true };
  }
  const name = place?.name || (typeof location === "undefined" ? "" : location.host) || t("rail.thisComputer");
  return { name, kind: "server", color: place?.color ?? null, named: true };
}

