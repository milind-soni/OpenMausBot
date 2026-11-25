import { skillBurgerEnabled, teamBoardEnabled, threadTabsEnabled } from "@/lib/feature-flags";
import type { ConfigStatus } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

/** Switches on Settings → Features, kept in the place's config.json (`features.<name>`), so its server reads them too. */
export type Feature = "skillBurger" | "threadTabs" | "teamBoard";

const FEATURES: Record<Feature, (config: ConfigStatus | null | undefined) => boolean> = {
  skillBurger: skillBurgerEnabled,
  threadTabs: threadTabsEnabled,
  teamBoard: teamBoardEnabled,
};

/** Whether a switch on Settings → Features is on. */
export function useFeature(name: Feature): boolean {
  return useStoreSelector((state) => FEATURES[name](state.config));
}
