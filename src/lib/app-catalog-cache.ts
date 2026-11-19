import type { ToolkitCard } from "@/components/ServiceIcon";
import { onAppCatalogAnnounced } from "@/lib/app-catalog-signal";
import { api } from "@/state/store";

// The Apps catalog as this page last read it. The Apps panel and a bot's apps share the one copy and the one request, so a
// re-opened panel paints from it at once and reads again behind.

export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

export interface CatalogPagination {
  items: number;
  totalItems?: number;
  stalled: boolean;
  reason?: string;
}

export interface AppCatalog {
  cards: ToolkitCard[];
  source: "api" | "curated";
  pagination: CatalogPagination | null;
  configured: boolean;
  mode: "managed" | "self-hosted" | "unavailable";
  setup: ConnectorSetup | undefined;
}

let catalog: AppCatalog | null = null;
let cardsText = "";
let request: Promise<AppCatalog> | null = null;
let bySlug: { of: ToolkitCard[]; map: Map<string, ToolkitCard> } | null = null;
const listeners = new Set<(catalog: AppCatalog) => void>();

export function appCatalogMemory(): AppCatalog | null {
  return catalog;
}

/** The new list, with each card that is as it was kept as the same object, so only what changed is painted again. */
function keepingKnownCards(next: ToolkitCard[], known: ToolkitCard[]): ToolkitCard[] {
  const before = new Map(known.map((card) => [card.slug, card]));
  return next.map((card) => {
    const same = before.get(card.slug);
    return same && JSON.stringify(same) === JSON.stringify(card) ? same : card;
  });
}

/** Reads the catalog, one request however many ask at once. Cards that came back unchanged stay the same array. */
export function loadAppCatalog(): Promise<AppCatalog> {
  request ??= api("/api/connectors/catalog")
    .then((r: Partial<AppCatalog>) => {
      const cards = r.cards ?? [];
      const text = JSON.stringify(cards);
      const next: AppCatalog = {
        cards: !catalog ? cards : text === cardsText ? catalog.cards : keepingKnownCards(cards, catalog.cards),
        source: r.source ?? "curated",
        pagination: r.pagination ?? null,
        configured: Boolean(r.configured),
        mode: r.mode ?? "unavailable",
        setup: r.setup,
      };
      cardsText = text;
      catalog = next;
      for (const listener of listeners) listener(next);
      return next;
    })
    .finally(() => {
      request = null;
    });
  return request;
}

/** Called with each catalog read from now on. */
export function onAppCatalog(listener: (catalog: AppCatalog) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

onAppCatalogAnnounced(() => {
  if (catalog || listeners.size) void loadAppCatalog().catch(() => {});
});

/** The held cards by slug, read first when nothing is held; empty when that read fails. */
export function loadAppCards(): Promise<Map<string, ToolkitCard>> {
  return (catalog ? Promise.resolve(catalog) : loadAppCatalog()).then(cardsBySlug, () => new Map<string, ToolkitCard>());
}

export function cardsBySlug({ cards }: Pick<AppCatalog, "cards">): Map<string, ToolkitCard> {
  if (bySlug?.of !== cards) bySlug = { of: cards, map: new Map(cards.map((card) => [card.slug, card])) };
  return bySlug.map;
}
