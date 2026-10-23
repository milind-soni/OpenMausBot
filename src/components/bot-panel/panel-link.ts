import { useSyncExternalStore } from "react";

import type { Action, BotSettingsSection } from "@/state/store";
import { isSimplePage, PAGES, sectionTarget, type PageId, type PanelTarget } from "./page-registry";

/**
 * A named open of a bot's settings. The store keeps only the section, which the Simple bot panel maps to one tab or
 * page; a link may name a closer page (Access spans the Computer tab and several pages), and every link is a new
 * object, so following the same one again lands there again after the panel has moved on.
 */
export interface PanelLink {
  section: BotSettingsSection;
  page?: PageId;
  /** A card on the section's tab to scroll to, such as "conversations". */
  anchor?: string;
  nonce: number;
}

let latest: PanelLink | null = null;
const watchers = new Set<() => void>();

/**
 * Opens the bot's settings at a section, exactly as `toggleSettings` does, and tells the bot panel where to land:
 * `page`, when given, is the panel page that holds what the caller is about (it must belong to the section); `anchor`
 * is a card on the section's tab.
 */
export function openBotSettings(
  dispatch: (action: Action) => void,
  section: BotSettingsSection,
  options: { botId?: string; page?: PageId; anchor?: string } = {},
): void {
  latest = { section, ...(options.page ? { page: options.page } : {}), ...(options.anchor ? { anchor: options.anchor } : {}), nonce: (latest?.nonce ?? 0) + 1 };
  dispatch({ type: "toggleSettings", open: true, section, ...(options.botId !== undefined ? { botId: options.botId } : {}) });
  for (const watch of Array.from(watchers)) watch();
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

const snapshot = () => latest;

/** The latest named open, for the panel to follow (and follow again when the same link comes twice). */
export function usePanelLink(): PanelLink | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Where a named open of `section` lands: the link's page when it came with one for that section and Simple mode draws
 * that page, else the section's place, at the link's card when it named one. */
export function linkTarget(section: BotSettingsSection, link: PanelLink | null): PanelTarget {
  const ours = link?.section === section ? link : null;
  if (ours?.page && isSimplePage(ours.page)) return { tab: PAGES[ours.page].home, page: ours.page };
  return ours?.anchor ? { ...sectionTarget(section), anchor: ours.anchor } : sectionTarget(section);
}
