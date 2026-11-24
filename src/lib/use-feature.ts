import { skillBurgerEnabled, threadTabsEnabled } from "@/lib/feature-flags";
import { useDeviceFeature, type DeviceFeature } from "@/lib/feature-switches";
import type { ConfigStatus } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

/** Switches on Settings → Features kept in the place's config.json (`features.<name>`), so its server reads them too. */
export type PlaceFeature = "skillBurger" | "threadTabs";
export type Feature = PlaceFeature | DeviceFeature;

const PLACE_FEATURES: Record<PlaceFeature, (config: ConfigStatus | null | undefined) => boolean> = {
  skillBurger: skillBurgerEnabled,
  threadTabs: threadTabsEnabled,
};

export const isPlaceFeature = (name: Feature): name is PlaceFeature => Object.hasOwn(PLACE_FEATURES, name);

/** Whether a switch on Settings → Features is on. */
export function useFeature(name: Feature): boolean {
  const place = useStoreSelector((state) => (isPlaceFeature(name) ? PLACE_FEATURES[name](state.config) : false));
  const device = useDeviceFeature(isPlaceFeature(name) ? "mascotMotion" : name);
  return isPlaceFeature(name) ? place : device;
}
