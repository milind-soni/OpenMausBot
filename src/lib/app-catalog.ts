// How the Apps pop-up groups the marketplace: category pills ranked by how
// many apps carry them, and the sections the unfiltered view stacks
// (connected first, a few categories, then everything). Pure, so the
// component stays a renderer and these rules are tested on their own.

export interface CatalogCard {
  slug: string;
  categories?: string[];
}

/** Category pills shown inline before the rest fold under "More". */
export const INLINE_CATEGORY_COUNT = 5;
/** Categories previewed as their own section in the unfiltered view. */
export const CATEGORY_SECTION_COUNT = 3;
/** Apps a category section previews (two rows of two). */
export const CATEGORY_SECTION_SIZE = 4;

/** Every category, most used first (ties alphabetically), split into the
 * pills shown inline and the ones under More. */
export function rankCategories(cards: readonly CatalogCard[], inline = INLINE_CATEGORY_COUNT): { inline: string[]; more: string[] } {
  const counts = new Map<string, number>();
  for (const card of cards) for (const category of new Set(card.categories ?? [])) counts.set(category, (counts.get(category) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  return { inline: ranked.slice(0, inline), more: ranked.slice(inline) };
}

export function inCategory(card: CatalogCard, category: string | null): boolean {
  return category === null || (card.categories ?? []).includes(category);
}

export type CatalogSection<Card> =
  | { kind: "connected"; cards: Card[] }
  | { kind: "category"; category: string; cards: Card[]; more: boolean }
  | { kind: "all"; cards: Card[] };

/** The unfiltered, unsearched view: your connected apps, then a short
 * preview of the busiest categories (apps you have not connected yet), then
 * the whole catalog. A section with nothing in it is left out, except the
 * catalog itself, which still carries its loading and empty states. */
export function catalogSections<Card extends CatalogCard>(
  cards: readonly Card[],
  isConnected: (slug: string) => boolean,
  categories: readonly string[],
): CatalogSection<Card>[] {
  const sections: CatalogSection<Card>[] = [];
  const connected = cards.filter((card) => isConnected(card.slug));
  if (connected.length) sections.push({ kind: "connected", cards: connected });
  for (const category of categories.slice(0, CATEGORY_SECTION_COUNT)) {
    const open = cards.filter((card) => !isConnected(card.slug) && inCategory(card, category));
    if (open.length) sections.push({ kind: "category", category, cards: open.slice(0, CATEGORY_SECTION_SIZE), more: open.length > CATEGORY_SECTION_SIZE });
  }
  sections.push({ kind: "all", cards: cards.filter((card) => !isConnected(card.slug)) });
  return sections;
}
