import { useEffect, useState } from "react";
import { appVersion } from "@/lib/app-links";
import { pageIsThisComputer } from "@/lib/companion-bridge";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
export { useSettingsPlace, type PlaceKind, type SettingsPlace } from "./settings-place";
import { useAdvancedMode } from "@/lib/interface-mode";
import { railShown, usePlaces, type RailPlace } from "@/lib/places";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";
import { workspacesAvailable } from "../WorkspacesSection";
import type { SettingsContext } from "./settings-index";

export function useSettingsContext(): SettingsContext {
  const { state } = useStore();
  const advanced = useAdvancedMode();
  const admin = useOwnerOrAdmin() === true;
  const places = usePlaces();
  const known = useKnownPlaceCount();
  const ogb = typeof window === "undefined" ? undefined : window.ogb;
  const client = ogb?.remoteClient?.active === true;
  const cloud = state.config?.cloudHome === true;
  const team = Boolean(state.config?.team);
  const desktop = Boolean(ogb);
  return {
    desktop,
    here: pageIsThisComputer(),
    cloud,
    team,
    client,
    admin,
    places: railShown(places) || known > 1,
    plan: desktop ? Boolean(ogb?.cloudAccount || (ogb?.cloudPlan && cloud)) : cloud && !team && admin,
    organization: Boolean(ogb?.organization) && !client,
    environments: Boolean(ogb?.environments),
    installations: workspacesAvailable(state.config),
    skills: skillsLibraryEnabled(state.config),
    advanced,
  };
}

/** How many places this app knows (a hidden rail's included), from main's environments list. */
function useKnownPlaceCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const environments = window.ogb?.remoteClient?.active ? undefined : window.ogb?.environments;
    if (!environments) return;
    let alive = true;
    void environments.state().then((next) => { if (alive) setCount(next?.environments?.length ?? 0); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return count;
}

/** The other places on the window's rail, in rail order. */
export function useOtherPlaces(): RailPlace[] {
  const { places } = usePlaces();
  return places.filter((place) => !place.active);
}

export const versionLine = (): string => t("settings.overview.version", { version: appVersion() });
