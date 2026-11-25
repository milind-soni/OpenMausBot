import { memoryUpkeepEnabled, roomFeedEnabled, skillBurgerEnabled, teamBoardEnabled, threadTabsEnabled } from "@/lib/feature-flags";
import type { ConfigStatus } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

/** Switches on Settings → Features, kept in the place's config.json (`features.<name>`), so its server reads them too. */
export type Feature = "memoryUpkeep" | "skillBurger" | "threadTabs" | "roomFeed" | "teamBoard";

const FEATURES: Record<Feature, (config: ConfigStatus | null | undefined) => boolean> = {
  memoryUpkeep: memoryUpkeepEnabled,
  skillBurger: skillBurgerEnabled,
  threadTabs: threadTabsEnabled,
  roomFeed: roomFeedEnabled,
  teamBoard: teamBoardEnabled,
};

/** Whether a switch on Settings → Features is on. */
export function useFeature(name: Feature): boolean {
  return useStoreSelector((state) => FEATURES[name](state.config));
}
