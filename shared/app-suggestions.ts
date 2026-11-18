/** Common pairings, strongest first. A slug the catalog doesn't list is skipped. */
export const GOES_WELL_WITH: Readonly<Record<string, readonly string[]>> = {
  gmail: ["googlecalendar", "googledrive", "slack"],
  googlecalendar: ["gmail", "googlemeet", "slack"],
  googledrive: ["googledocs", "googlesheets", "gmail"],
  googledocs: ["googledrive", "googlesheets", "notion"],
  googlesheets: ["googledrive", "airtable", "gmail"],
  outlook: ["one_drive", "microsoft_teams", "slack"],
  slack: ["gmail", "notion", "linear"],
  discord: ["github", "notion", "googlecalendar"],
  github: ["linear", "slack", "notion"],
  gitlab: ["linear", "slack", "jira"],
  linear: ["github", "slack", "notion"],
  jira: ["confluence", "github", "slack"],
  sentry: ["github", "linear", "slack"],
  posthog: ["github", "linear", "slack"],
  notion: ["slack", "googledrive", "linear"],
  airtable: ["slack", "googlesheets", "notion"],
  asana: ["slack", "googlecalendar", "gmail"],
  trello: ["slack", "googlecalendar", "gmail"],
  hubspot: ["gmail", "slack", "googlecalendar"],
  salesforce: ["gmail", "slack", "googlesheets"],
  stripe: ["hubspot", "slack", "googlesheets"],
  shopify: ["stripe", "mailchimp", "googlesheets"],
  dropbox: ["gmail", "slack", "notion"],
  figma: ["linear", "slack", "notion"],
  zoom: ["googlecalendar", "slack", "gmail"],
};

/** What someone with nothing connected is offered, in this order. */
export const STARTER_APPS: readonly string[] = [
  "gmail", "googlecalendar", "slack", "notion", "googledrive", "github", "googlesheets", "linear", "hubspot", "airtable", "jira", "asana", "trello", "dropbox", "zoom", "stripe",
];

/** GET /api/connectors/suggestions: whether the Suggested section's button can ask the decision model. */
export type AppPickState = "available" | "picked" | "needs-key";

export const SUGGESTED_SECTION_SIZE = 6;
export const SUGGESTED_CARD_SIZE = 3;
/** Recently wanted apps lead, but never fill the list. */
const WANTED_FIRST_MAX = 3;
const NOISE_WORDS = new Set(["a", "an", "app", "apps", "and", "connect", "for", "i", "in", "my", "need", "of", "on", "or", "something", "that", "the", "to", "tool", "tools", "want", "with"]);

export interface RankInput<Card> {
  catalog: readonly Card[];
  /** Apps with a working account: what the pairings go by. */
  connected: readonly string[];
  /** Every app with an account in any state: never offered. */
  held: readonly string[];
  /** Apps a bot looked for and didn't have, newest first. */
  wanted?: readonly string[];
  /** The decision model's order, when one was asked. */
  picks?: readonly string[];
  /** The app a connect card is for: its pairings lead, and it is never offered. */
  about?: string;
  allowed?: (slug: string) => boolean;
  limit: number;
}

const partnersOf = (slug: string): readonly string[] => (Object.hasOwn(GOES_WELL_WITH, slug) ? GOES_WELL_WITH[slug]! : []);

function pairings(connected: readonly string[]): string[] {
  const votes = new Map<string, number>();
  for (const app of connected) {
    partnersOf(app).forEach((partner, position) => votes.set(partner, (votes.get(partner) ?? 0) + 3 - position));
  }
  return [...votes].sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
}

export function rankAppSuggestions<Card extends { slug: string; noAuth?: boolean }>(input: RankInput<Card>): Card[] {
  const bySlug = new Map(input.catalog.map((card) => [card.slug, card]));
  const held = new Set([...input.held, ...input.connected, ...(input.about ? [input.about] : [])]);
  const offerable = (slug: string) => {
    const card = bySlug.get(slug);
    return Boolean(card) && !card!.noAuth && !held.has(slug) && (input.allowed?.(slug) ?? true);
  };
  const ordered = [
    ...(input.wanted ?? []).filter(offerable).slice(0, WANTED_FIRST_MAX),
    ...(input.picks ?? []),
    ...(input.about ? partnersOf(input.about) : []),
    ...pairings(input.connected),
    ...STARTER_APPS,
  ];
  return [...new Set(ordered.filter(offerable))].slice(0, input.limit).map((slug) => bySlug.get(slug)!);
}

/** What a search is looking for: lower case, plurals singular, filler words gone unless that leaves nothing. */
export function searchWords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  const meaningful = words.filter((word) => !NOISE_WORDS.has(word));
  return meaningful.length ? meaningful : words;
}

/** The Apps search box: every word of `query` appears in `text`. */
export function matchesCatalogSearch(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return searchWords(query).every((word) => haystack.includes(word));
}

/** A bot's search: the apps matching any word, best first, and in catalog order (most used first) among equals. */
export function searchCatalog<Card extends { slug: string; label: string; blurb: string; categories?: string[] }>(cards: readonly Card[], query: string, limit: number): Card[] {
  const words = searchWords(query);
  const score = (card: Card) => words.reduce((total, word) => {
    const label = card.label.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    if (label.some((part) => part.startsWith(word))) return total + 4;
    if (card.slug.includes(word)) return total + 3;
    if (card.categories?.some((category) => category.toLowerCase().includes(word))) return total + 2;
    return card.blurb.toLowerCase().includes(word) ? total + 1 : total;
  }, 0);
  return cards.map((card, index) => ({ card, index, points: score(card) })).filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points || a.index - b.index).slice(0, limit).map(({ card }) => card);
}
