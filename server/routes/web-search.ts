import { z } from "zod";
import { searchWeb } from "../web-search.ts";
import { configuredWebSearch, type WebSearchConfig } from "../web-search-config.ts";
import type { HelperToolContext } from "./helper-tools.ts";
import { PASS } from "./table.ts";

export interface WebSearchContext extends HelperToolContext {
  assertWebSearchAllowed(): void;
  webSearchSignal: AbortSignal;
}

const input = z.object({ query: z.string().trim().min(1).max(512), limit: z.number().int().min(1).max(10).default(5) }).strict();
const WINDOW_MS = 60_000;

export function createWebSearchRoute(config: () => WebSearchConfig | undefined, search: typeof searchWeb = searchWeb, now = Date.now) {
  let windowEnd = 0;
  let used = 0;
  let active = 0;
  const bots = new Map<string, { used: number; active: number }>();
  return async (ctx: WebSearchContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== "/api/internal/web/search") return PASS;
    ctx.assertWebSearchAllowed();
    const parsed = input.safeParse(await ctx.readBody());
    if (!parsed.success) return ctx.json(ctx.res, 400, { error: "Web search needs a public query of 1–512 characters and a limit of 1–10." });
    ctx.assertWebSearchAllowed();
    const settings = config();
    const backend = configuredWebSearch(settings);
    if (!backend) return ctx.json(ctx.res, 503, { error: "Web search is not configured. Configure SearXNG or Brave Search before using web search." });
    if (now() >= windowEnd) {
      windowEnd = now() + WINDOW_MS; used = 0;
      for (const [id, bot] of bots) { if (!bot.active) bots.delete(id); else bot.used = 0; }
    }
    const bot = bots.get(ctx.botId) ?? { used: 0, active: 0 };
    if (active >= 4 || bot.active >= 1 || used >= 30 || bot.used >= 6) {
      return ctx.json(ctx.res, 429, { error: "Web search budget reached. Wait before searching again." });
    }
    bots.set(ctx.botId, bot); bot.used++; bot.active++; used++; active++;
    try {
      const results = await search(settings, parsed.data.query, parsed.data.limit, ctx.webSearchSignal, { assertAllowed: ctx.assertWebSearchAllowed });
      ctx.assertWebSearchAllowed();
      ctx.json(ctx.res, 200, { source: backend === "searxng" ? "SearXNG" : "Brave Search", untrusted: true, results });
    } catch (error) {
      ctx.assertWebSearchAllowed();
      ctx.json(ctx.res, 502, { error: error instanceof Error ? error.message : "Web search failed." });
    } finally { active--; bot.active--; }
  };
}
