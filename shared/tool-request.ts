/**
 * The first two rungs of the tool ladder: use what is connected, or connect
 * what the catalog has. See `docs/plans/tool-ladder.md`.
 *
 * A bot that needs a tool it does not have says so in a CAPABILITY — "calendar",
 * "email", "spreadsheet" — never a vendor and never a slug. The harness turns
 * that into the apps it can actually connect, because a model-authored list can
 * name a provider that does not exist or that we have no way to authorize, and
 * a person cannot tell those apart from a real one until they have clicked it.
 *
 * So: the model owns the capability, the harness owns the slugs.
 */

/** Nobody reads past six, and a long list makes the choice feel like work. */
export const MAX_CANDIDATES = 6;
/** Free text on the naming step. Long enough for "Work (billing)". */
export const MAX_ACCOUNT_NAME = 60;

/** One app the user could pick, as the card shows it. */
export interface ToolCandidate {
  slug: string;
  label: string;
  blurb: string;
  logo?: string | null;
  domain?: string | null;
  /** Already connected. Shown as such, and picking it needs no sign-in. */
  connected?: boolean;
}

/** What the card is waiting on. */
export type ToolRequestStep = "choose" | "name";

/** How it ended, once it has. */
export type ToolRequestOutcome =
  /** handed to the connector card — sign-in is running */
  | "connecting"
  /** the chosen app was already connected; the job just carried on */
  | "ready"
  /** "I'll connect it later" */
  | "later"
  /** the catalog had nothing for this capability */
  | "none"
  /** …and the user asked the bot to go and look for one (rung 3) */
  | "searching"
  /** …or to build one, because nothing exists to find (rung 4) */
  | "building";

export interface ToolRequestCardData {
  version: 1;
  /** The bot's own words for what it needs. Never a slug. */
  capability: string;
  /** Why it needs it, if it said. */
  reason?: string;
  candidates: ToolCandidate[];
  step: ToolRequestStep;
  /** The slug picked on the choose step. */
  chosen?: string;
  settled?: ToolRequestOutcome;
}

/**
 * Words that mean the same capability to a person and different things to a
 * catalog. Deliberately small and hand-written: a big generated ontology would
 * be worse, because every wrong entry here shows up as an app the user is
 * offered for a job it cannot do.
 *
 * Keys are SINGULAR, because that is what they are looked up with — a plural
 * key is simply never reached, which is how "analytics" silently had no
 * synonyms at all.
 */
const SYNONYMS: Record<string, readonly string[]> = {
  calendar: ["calendar", "event", "scheduling", "meeting"],
  event: ["calendar", "event"],
  meeting: ["calendar", "meeting", "conferencing"],
  email: ["email", "mail", "inbox"],
  mail: ["email", "mail", "inbox"],
  inbox: ["email", "mail", "inbox"],
  spreadsheet: ["spreadsheet", "sheet", "excel"],
  sheet: ["spreadsheet", "sheet", "excel"],
  document: ["document", "doc", "word"],
  doc: ["document", "doc"],
  note: ["note", "page", "wiki"],
  chat: ["chat", "message", "channel"],
  message: ["chat", "message", "channel"],
  messaging: ["chat", "message", "channel"],
  issue: ["issue", "ticket", "project", "task"],
  ticket: ["issue", "ticket", "support"],
  project: ["project", "issue", "task"],
  crm: ["crm", "contact", "deal", "lead"],
  file: ["file", "drive", "storage"],
  storage: ["file", "drive", "storage"],
  payment: ["payment", "invoice", "billing"],
  invoice: ["invoice", "billing", "payment"],
  design: ["design", "prototype"],
  code: ["code", "repository", "git"],
  repository: ["code", "repository", "git"],
  analytic: ["analytic", "metric"],
};

/** Split into lowercase word tokens; punctuation and case are noise here. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Naive de-pluralization. "calendars" and "calendar" are the same ask. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es") && !word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** How well one app answers the capability, split by what kind of evidence
 * it is. A word the bot actually said and a word we inferred for it are not
 * interchangeable, and collapsing them into one number is how an app that
 * merely contains a synonym outranks one that contains the real thing. */
interface Evidence {
  direct: number;
  inferred: number;
}

/** A word to search for, and whether the bot actually said it.
 *
 * A synonym is a guess on the user's behalf and is scored as one: "metric"
 * is a fair expansion of "analytics", but Baremetrics — whose slug contains
 * "metric" — should not outrank Google Analytics, whose NAME is the word
 * that was asked for. */
interface SearchTerm {
  term: string;
  /** 1 for the bot's own word, less for something we inferred from it. */
  weight: number;
}

const SYNONYM_WEIGHT = 0.6;

function weightedTerms(capability: string): SearchTerm[] {
  const out = new Map<string, number>();
  for (const raw of tokens(capability)) {
    const word = singular(raw);
    // Single letters and "the"-class words match everything and mean nothing.
    if (word.length < 3) continue;
    out.set(word, 1);
    for (const term of SYNONYMS[word] ?? []) {
      if (!out.has(term)) out.set(term, SYNONYM_WEIGHT);
    }
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

/** Every term worth searching for, from what the bot actually said. */
export function searchTerms(capability: string): string[] {
  return weightedTerms(capability).map((entry) => entry.term);
}

/**
 * How well one app answers the capability.
 *
 * The tiers matter more than the numbers: a name match is evidence, a blurb
 * match is a hint. Ranking them the same is how "calendar" ends up offering
 * six apps that merely mention calendars in their description.
 */
function score(candidate: ToolCandidate, terms: readonly SearchTerm[]): Evidence {
  const label = tokens(candidate.label).map(singular);
  const slug = candidate.slug.toLowerCase();
  const blurb = tokens(candidate.blurb ?? "").map(singular);
  const evidence: Evidence = { direct: 0, inferred: 0 };
  for (const { term, weight } of terms) {
    const bucket = weight === 1 ? "direct" : "inferred";
    const add = (points: number) => {
      evidence[bucket] += points * weight;
    };
    if (label.includes(term) || slug === term) add(6);
    else if (slug.includes(term)) add(4);
    else if (candidate.label.toLowerCase().includes(term)) add(3);
    else {
      // A mention in the blurb counts, wherever it is. Position is a ranking
      // hint, never a gate: it looked like a real signal against the terse
      // curated blurbs ("Email, calendar and contacts") and turned out to be
      // an artefact of them. The live catalog writes sentences — "PostHog is
      // an open-source product analytics platform" puts the word seventh —
      // and gating on position dropped exactly the app the user asked for
      // while keeping ones nobody wanted.
      const at = blurb.indexOf(term);
      if (at >= 0) add(at < 4 ? 3 : 2);
    }
  }
  return evidence;
}

/** What the catalog's own order is worth.
 *
 * The catalog comes back sorted by usage, and ignoring that was how "email"
 * offered Benchmark Email, BlueFox Email and Bulk Email Checker — three apps
 * whose NAME contains the category — while Gmail, whose name does not, fell
 * off the end. Being the one everybody actually uses is evidence, and it is
 * evidence we were handed for free.
 *
 * It is weighted heavily enough to beat a name match, on purpose: for a
 * CATEGORY word, having it in your name is weak evidence ("Bulk Email
 * Checker" is not an email client) while for a brand word it is strong, and
 * nothing here can tell those apart. Usage can. The filter has already
 * thrown out everything that does not match at all, so this only ever
 * reorders apps that genuinely answer the capability.
 */
function popularity(index: number): number {
  if (index < 25) return 6;
  if (index < 100) return 3;
  if (index < 250) return 1;
  return 0;
}

/**
 * The weakest evidence worth offering someone: one real mention of the
 * capability, anywhere.
 *
 * This deliberately favours RECALL over precision, which is the opposite of
 * where it started. The person is choosing from a visible, ranked list of at
 * most six, so a mediocre option in fourth place costs them a glance —
 * whereas omitting the right one costs them the feature. Asked for analytics,
 * the strict version offered Google Analytics and Baremetrics and left out
 * PostHog, which is what they actually use.
 *
 * In practice the bar is: one mention of the bot's OWN word anywhere, or one
 * inferred synonym up front. A synonym mentioned in passing is not enough.
 */
const MIN_SCORE = 1.5;

/**
 * The apps to offer for a capability, best first.
 *
 * Already-connected apps are surfaced ahead of the rest at equal evidence:
 * the best answer to "I need a calendar" is usually the calendar you already
 * connected, and offering to connect a second one first reads as a bug.
 */
export function matchToolkits(
  capability: string,
  catalog: readonly ToolCandidate[],
  options: { connected?: ReadonlySet<string>; limit?: number } = {},
): ToolCandidate[] {
  const terms = weightedTerms(capability);
  const connected = options.connected ?? new Set<string>();
  const limit = options.limit ?? MAX_CANDIDATES;
  if (!terms.length) return [];
  const scored = catalog
    .map((candidate, index) => ({
      candidate: connected.has(candidate.slug) ? { ...candidate, connected: true } : candidate,
      evidence: score(candidate, terms),
      rank: popularity(index),
    }))
    // A direct mention of the bot's own word, or a strong inferred one. A
    // synonym glimpsed in passing is not enough on its own.
    .filter((row) => row.evidence.direct >= MIN_SCORE || row.evidence.inferred >= MIN_SCORE);
  scored.sort((a, b) => {
    const connectedGap = Number(b.candidate.connected ?? false) - Number(a.candidate.connected ?? false);
    if (connectedGap) return connectedGap;
    // Direct evidence first, so a synonym can break a tie but never win one.
    const direct = (b.evidence.direct + b.rank) - (a.evidence.direct + a.rank);
    if (Math.abs(direct) > 0.001) return direct;
    const inferred = b.evidence.inferred - a.evidence.inferred;
    if (Math.abs(inferred) > 0.001) return inferred;
    // A stable last resort, so the same catalog always offers the same order.
    return a.candidate.label.localeCompare(b.candidate.label);
  });
  return scored.slice(0, limit).map((row) => row.candidate);
}

/** The name the account is saved under when the user accepts the suggestion. */
export function defaultAccountName(candidates: readonly ToolCandidate[], chosen: string): string {
  return candidates.find((candidate) => candidate.slug === chosen)?.label ?? "";
}
