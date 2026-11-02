import { X_CARD_SEARCH } from "@/components/XCard";
import { t } from "@/lib/i18n";

import { inCategory } from "./app-catalog";
import { POSTIZ_CATALOG_CARD, POSTIZ_SEARCH } from "./postiz";

type AppsFilter = "all" | "connected" | "mcp";

export const NATIVE_CARD_IDS = ["whop", "famulor", "highlevel", "x", "postiz"] as const;
export type NativeCardId = (typeof NATIVE_CARD_IDS)[number];

function searchText(id: NativeCardId): string {
  switch (id) {
    case "whop":
      return `whop ${t("whop.description")}`;
    case "famulor":
      return `famulor ${t("famulor.description")}`;
    case "highlevel":
      return `highlevel high level growably crm ${t("highlevel.description")}`;
    case "x":
      return `${X_CARD_SEARCH} ${t("apps.x.description")}`;
    case "postiz":
      return `${POSTIZ_SEARCH} ${t("postiz.description")}`;
    default: {
      const unknown: never = id;
      return unknown;
    }
  }
}

/** A native card stays visible while its connection is still unknown, and on Connected once it is on.
 * Postiz also stays inside its catalog category; the other cards leave a category view. */
export function nativeCardVisible(id: NativeCardId, search: string, filter: AppsFilter, connected: boolean | null, category: string | null): boolean {
  const matches = !search || searchText(id).toLowerCase().includes(search.toLowerCase().trim());
  const inCategoryView = filter === "all" && category !== null;
  const inThisView = !inCategoryView || (id === "postiz" && inCategory(POSTIZ_CATALOG_CARD, category));
  return matches && inThisView && (filter === "all" || (filter === "connected" && connected !== false));
}

export function nativeCardsState(input: {
  search: string;
  filter: AppsFilter;
  category: string | null;
  connected: Record<NativeCardId, boolean | null>;
}): { show: Record<NativeCardId, boolean>; connectedCount: number; anyShown: boolean } {
  const show = Object.fromEntries(NATIVE_CARD_IDS.map((id) => [
    id,
    nativeCardVisible(id, input.search, input.filter, input.connected[id], input.category),
  ])) as Record<NativeCardId, boolean>;
  return {
    show,
    connectedCount: NATIVE_CARD_IDS.filter((id) => input.connected[id] === true).length,
    anyShown: NATIVE_CARD_IDS.some((id) => show[id]),
  };
}
