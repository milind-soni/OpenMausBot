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
    home: pageIsThisComputer() || Boolean(ogb?.home),
    cloud,
    team,
    client,
    admin,
    places: known > 1 || (!ogb?.environments && railShown(places)),
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

export interface OtherPlace {
  key: string;
  name: string;
  kind: RailPlace["kind"];
  color: string | null;
  open: () => void;
}

/** The person's other places, in rail order: from the rail where this page has it, else from this computer's list of
 * environments (the window's own rail keeps its list to itself). */
export function useOtherPlaces(page?: string): OtherPlace[] {
  const { places } = usePlaces();
  const [listed, setListed] = useState<OtherPlace[]>([]);
  const environments = typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.environments;
  useEffect(() => {
    if (!environments || places.length > 0) return;
    let alive = true;
    void environments.state().then((state) => {
      if (!alive || !state) return;
      setListed(state.environments.filter((entry) => entry.id !== state.activeId).map((entry) => ({
        key: entry.id,
        name: entry.kind === "local" && !entry.dataDir ? t("rail.thisComputer") : entry.name,
        kind: entry.kind === "remote" ? "cloud" as const : "computer" as const,
        color: entry.color ?? null,
        open: () => void environments.switch(entry.id),
      })));
    }).catch(() => {});
    return () => { alive = false; };
  }, [environments, places.length]);
  const open = typeof window === "undefined" ? undefined : window.ogb?.workspaces?.open;
  if (places.length > 0) {
    return places.filter((place) => !place.active).map((place) => ({
      key: place.id, name: place.name, kind: place.kind, color: place.color ?? null, open: () => void open?.(place.id),
    }));
  }
  // A Cloud's page in the desktop window can't read the rail's list, but This computer is always on it.
  const openComputer = typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.rail?.openComputer;
  if (listed.length === 0 && openComputer && !pageIsThisComputer()) {
    return [{ key: "computer", name: t("rail.thisComputer"), kind: "computer", color: null, open: () => void openComputer(page).catch(() => {}) }];
  }
  return listed;
}

export const versionLine = (): string => t("settings.overview.version", { version: appVersion() });
