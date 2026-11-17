// What to offer a person to connect next: apps their bots recently looked for and didn't have, the decision model's pick
// when they asked for one, then the apps that go well with what they have. Works from the catalog and connections the
// Apps page reads. The file holds app slugs only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { rankAppSuggestions, searchCatalog, type AppPickState } from "../../shared/app-suggestions.ts";
import { FIRST_HOUR_OFFER_KEY } from "../../shared/person-wait.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { ToolkitCard } from "../composio.ts";
import { pickApps } from "../decider/app-picks.ts";
import type { Decider } from "../decider/index.ts";
import { BOT_DECIDE_LIMITS } from "../decider/relay.ts";
import { clean } from "../records-block.ts";
import type { BotRecord, Store } from "../store.ts";

export const SUGGESTIONS_FILE = "app-suggestions.json";
export const WANTED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const WANTED_MAX = 20;
const FIND_LIMIT = 8;
const FIND_NOTED = 2;

const slug = z.string().min(1).max(100);
const stateSchema = z.object({
  version: z.literal(1),
  wanted: z.array(z.object({ slug, at: z.number().finite().nonnegative() })).max(WANTED_MAX),
  /** The decision model's order, for exactly these connected apps and bots. */
  pick: z.object({ key: z.string().max(80), slugs: z.array(slug).max(BOT_DECIDE_LIMITS.options) }).optional(),
});
type SuggestionState = z.infer<typeof stateSchema>;

export interface AppSuggestionDeps {
  dataDir: string;
  store: Pick<Store, "bots" | "bot" | "onChange">;
  configured(): boolean;
  catalog(): Promise<{ cards: ToolkitCard[] }>;
  services(): Promise<Record<string, { connected: boolean }>>;
  /** False for an app the organization, the team or this kind of connection doesn't let anyone connect here. */
  offerable(slug: string): boolean;
  pickAvailable(): boolean;
  decider: Pick<Decider, "choose">;
  now?: () => number;
}

export interface Suggestions {
  cards: ToolkitCard[];
  pick: AppPickState;
}

export function createAppSuggestions(deps: AppSuggestionDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, SUGGESTIONS_FILE);
  let state: SuggestionState = { version: 1, wanted: [] };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
  } catch {
    // No file yet: nothing looked for, nothing picked.
  }
  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`app suggestions: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  function noteWanted(app: string): void {
    state = { ...state, wanted: [{ slug: app, at: now() }, ...state.wanted.filter((entry) => entry.slug !== app)].slice(0, WANTED_MAX) };
    save();
  }

  deps.store.onChange((change) => {
    if (change.type !== "message") return;
    const card = change.message.connector;
    if (card && card.source !== "mcp" && card.status !== "connected" && !card.resumeKey.startsWith(FIRST_HOUR_OFFER_KEY)) noteWanted(card.slug);
  });

  const everyoneBots = () => deps.store.bots.filter((bot) => !bot.hidden && !bot.movedTo);
  const roles = () => everyoneBots().map((bot) => ({ name: bot.name, ...(bot.title?.trim() || bot.section?.trim() ? { role: bot.title?.trim() || bot.section!.trim() } : {}) }));
  const wantedNow = () => state.wanted.filter((entry) => now() - entry.at <= WANTED_TTL_MS).map((entry) => entry.slug);
  /** A bot's own limits, or with no bot in view, whether any bot could use it. */
  const scopedTo = (botId: string | undefined) => {
    const bot = botId ? deps.store.bot(botId) : null;
    const bots: readonly BotRecord[] = bot ? [bot] : everyoneBots().filter((one) => one.composio !== false);
    return (app: string) => deps.offerable(app) && (!bots.length || bots.some((one) => !one.connectorScopes || one.connectorScopes.apps[app]));
  };

  async function reading() {
    if (!deps.configured()) return null;
    try {
      const [{ cards }, services] = await Promise.all([deps.catalog(), deps.services()]);
      const connected = Object.entries(services).filter(([, service]) => service.connected).map(([app]) => app).sort();
      return { cards, connected, held: Object.keys(services), key: pickKey(connected, roles()) };
    } catch {
      return null;
    }
  }

  async function suggest(input: { botId?: string; about?: string; limit: number }): Promise<Suggestions> {
    const here = await reading();
    if (!here) return { cards: [], pick: "available" };
    const picked = state.pick?.key === here.key ? state.pick.slugs : undefined;
    const cards = rankAppSuggestions({
      catalog: here.cards, connected: here.connected, held: here.held, wanted: wantedNow(), allowed: scopedTo(input.botId), limit: input.limit,
      ...(picked ? { picks: picked } : {}), ...(input.about ? { about: input.about } : {}),
    });
    return { cards, pick: picked ? "picked" : deps.pickAvailable() ? "available" : "needs-key" };
  }

  let picking: Promise<void> | null = null;

  async function askDecisionModel(): Promise<void> {
    const here = await reading();
    if (!here || state.pick?.key === here.key || !deps.pickAvailable()) return;
    const candidates = rankAppSuggestions({ catalog: here.cards, connected: here.connected, held: here.held, wanted: wantedNow(), allowed: scopedTo(undefined), limit: BOT_DECIDE_LIMITS.options });
    const label = (app: string) => here.cards.find((card) => card.slug === app)?.label ?? app;
    const picked = await pickApps(deps.decider, { connected: here.connected.map(label), bots: roles(), candidates });
    if (!picked.ok) return;
    state = { ...state, pick: { key: here.key, slugs: picked.slugs } };
    save();
  }

  return {
    suggest,
    /** Runs the decision model at most once at a time, and not again for the same apps and bots. */
    async pick(limit: number): Promise<Suggestions> {
      picking ??= askDecisionModel().catch(() => {}).finally(() => { picking = null; });
      await picking;
      return suggest({ limit });
    },

    /** A bot's catalog search, as the lines it reads. `refusal`: why this conversation can't connect an app, if it can't. */
    async find(input: { query: string; bot: BotRecord; refusal(app: string): string | null | undefined }): Promise<string> {
      const here = await reading();
      if (!here) return "The list of apps can't be read right now. Try again in a minute.";
      const matches = searchCatalog(here.cards, input.query, FIND_LIMIT * 3);
      const scope = input.bot.connectorScopes;
      const usable = matches.filter((card) => (!scope || scope.apps[card.slug]) && !input.refusal(card.slug)).slice(0, FIND_LIMIT);
      if (!usable.length) return (matches[0] ? input.refusal(matches[0].slug) : null) ?? `No app that can be connected here matches "${clean(input.query, 120)}". Try other words.`;
      const connected = new Set(here.connected);
      const missing = usable.filter((card) => !connected.has(card.slug) && !card.noAuth);
      for (const card of missing.slice(0, FIND_NOTED).reverse()) noteWanted(card.slug);
      const standing = (card: ToolkitCard) => (connected.has(card.slug) ? "connected" : card.noAuth ? "no sign-in needed" : "not connected");
      return [
        `Apps matching "${clean(input.query, 120)}":`,
        ...usable.map((card) => `- ${card.slug}: ${clean(card.label, 80)} (${standing(card)}). ${clean(card.blurb, 120)}`),
        'To show the person a card that connects one, call this tool again with toolkits: ["<slug>"], using a slug listed here.',
      ].join("\n");
    },
  };
}

export type AppSuggestions = ReturnType<typeof createAppSuggestions>;

function pickKey(connected: readonly string[], bots: ReadonlyArray<{ name: string; role?: string }>): string {
  const people = bots.map((bot) => [bot.name, bot.role ?? ""]).sort((a, b) => a.join().localeCompare(b.join()));
  return createHash("sha256").update(JSON.stringify([connected, people])).digest("hex");
}
