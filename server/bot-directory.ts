import { parseJson } from "./schema.ts";
import type { ProjectProfile } from "./project-scout.ts";

export const BOT_DIRECTORY_URL = "https://botdirectory.ai";
export const BOT_DIRECTORY_API_URL = "https://api.botdirectory.ai/api/bots";

const MAX_DIRECTORY_BYTES = 1_000_000;
const MAX_DIRECTORY_BOTS = 200;

export interface DirectoryBot {
  slug: string;
  name: string;
  category: string;
  integrations: string[];
  /** the community-written setup prompt — shown to the human, and only ever
   * imported as a bot description through the same persona-only boundary as
   * any shared team file */
  prompt: string;
  detailUrl: string;
}

export interface MatchedDirectoryBot extends DirectoryBot {
  /** the profile terms this bot matched on, for the human reviewing it */
  matched: string[];
}

type Fetcher = typeof fetch;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  return normalized.length > max ? null : normalized;
}

/** Validate the community-maintained index before any of it reaches the
 * renderer. Entries that do not parse are dropped, not fatal — one bad
 * community submission must not blank the whole directory. */
export function parseBotDirectory(value: unknown): DirectoryBot[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bots)) {
    throw new Error("The bot directory response is not supported");
  }
  const bots: DirectoryBot[] = [];
  const seen = new Set<string>();
  for (const raw of value.bots.slice(0, MAX_DIRECTORY_BOTS)) {
    if (!isRecord(raw)) continue;
    const slug = text(raw.slug, 100);
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || seen.has(slug)) continue;
    const name = text(raw.name, 100);
    const prompt = text(raw.prompt, 4_000);
    if (!name || !prompt) continue;
    const detailUrl = text(raw.detailUrl, 300);
    if (!detailUrl || !detailUrl.startsWith(`${BOT_DIRECTORY_URL}/`)) continue;
    seen.add(slug);
    bots.push({
      slug,
      name,
      category: text(raw.category, 80) ?? "",
      integrations: Array.isArray(raw.integrations)
        ? raw.integrations.flatMap((item) => text(item, 80) ?? []).slice(0, 20)
        : [],
      prompt,
      detailUrl,
    });
  }
  return bots;
}

/** Read the body in bounded chunks: an oversized or endless response is
 * rejected the moment it crosses the cap, never buffered whole first. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const oversized = () => new Error("The bot directory response is too large");
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw oversized();
  if (!response.body) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw oversized();
    return raw;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw oversized();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchBotDirectory(fetcher: Fetcher = fetch): Promise<DirectoryBot[]> {
  const response = await fetcher(BOT_DIRECTORY_API_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The bot directory returned HTTP ${response.status}`);
  return parseBotDirectory(parseJson(await readBounded(response, MAX_DIRECTORY_BYTES)));
}

/** Rank directory bots against a scouted project: overlap between the
 * project's stacks/summary words and a bot's name, category and
 * integrations. Purely lexical on purpose — deterministic, explainable,
 * and honest about being a hint rather than a verdict. */
// Words that appear in nearly every project blurb and would match nearly
// every directory entry. A match on one of these is noise, not affinity —
// measured live: "Your own team of AI bots" matched a home-value tracker
// purely on "your".
const STOPWORDS = new Set([
  "your", "with", "that", "this", "from", "have", "what", "when", "where", "will",
  "them", "then", "than", "only", "also", "into", "over", "about", "after", "before",
  "every", "some", "most", "much", "many", "very", "just", "like", "each", "other",
  "their", "there", "these", "those", "using", "based", "open", "free", "fast",
  "simple", "easy", "apps", "tool", "tools", "project", "team", "chat", "bots",
]);

export function matchDirectoryBots(
  profile: ProjectProfile,
  bots: DirectoryBot[],
  limit = 5,
): MatchedDirectoryBot[] {
  const terms = new Set<string>();
  for (const stack of profile.stacks) {
    const term = stack.toLowerCase();
    // a two- or three-letter stack ("go", "php") substring-matches half the
    // directory — "google", "django", "logo" are not Go affinity
    if (term.length >= 4) terms.add(term);
  }
  for (const signal of profile.signals) terms.add(signal.role);
  // "." and "#" stay word-internal for the likes of next.js and C#, but a
  // sentence-final "payments." must still match "Payments"
  for (const raw of `${profile.name} ${profile.summary}`.toLowerCase().split(/[^a-z0-9+.#-]+/)) {
    const word = raw.replace(/^[.#+-]+|[.#+-]+$/g, "");
    if (word.length >= 4 && !STOPWORDS.has(word)) terms.add(word);
  }

  const scored = bots.flatMap((bot) => {
    const haystackParts = [bot.name, bot.category, ...bot.integrations].map((part) => part.toLowerCase());
    const matched = [...terms].filter((term) => haystackParts.some((part) => part.includes(term)));
    return matched.length > 0 ? [{ ...bot, matched }] : [];
  });
  return scored.sort((a, b) => b.matched.length - a.matched.length).slice(0, limit);
}
