// Search tools: bounded transcript search across or within tasks.

import { idArg, parsePositiveLimit, stringArg, type Json, type ToolContext, type ToolHandler } from "./context.ts";
import { records } from "./shared.ts";

export const handlers = {
  async search_messages(args: Json, ctx: ToolContext): Promise<unknown> {
    const query = stringArg(args, "query", { max: 500 });
    const limit = parsePositiveLimit(args.limit, 40, 100);
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (args.task_id !== undefined) params.set("threadId", idArg(args, "task_id"));
    const result = await ctx.fetch(`/api/search?${params.toString()}`);
    return { hits: records(result.hits) };
  },
} satisfies Record<string, ToolHandler>;
