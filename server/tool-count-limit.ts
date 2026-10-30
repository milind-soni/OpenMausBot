// A provider's limit on how many tools one request may carry: OpenAI-compatible endpoints refuse a request with more than
// 128 ("Invalid value for 'tools': maximum number of items is 128."). Under a limit every MCP server of a turn lists at
// most its share; the engine's own tools are never trimmed, and a server still answers a call to a tool it left out.

/** The most tools one MCP server lists for this turn, in the environment of each server the turn hands an engine. */
export const TOOL_LIMIT_ENV = "OMB_TOOL_LIMIT";
/** The same on OpenMausBot's own MCP endpoints, reached over HTTP. */
export const TOOL_LIMIT_HEADER = "x-omb-tool-limit";

export function parseToolLimit(value: unknown): number | undefined {
  return typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : undefined;
}

export function toolLimitFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  return parseToolLimit(env[TOOL_LIMIT_ENV]);
}

/** The first `limit` tools in the server's own order, which puts its main tools first. */
export function capToolList<T>(tools: readonly T[], limit: number | undefined): T[] {
  return limit === undefined || tools.length <= limit ? [...tools] : tools.slice(0, limit);
}

/** A `tools/list` result under `limit`, one line to `log` with the counts when tools are left out. A capped server lists
 * one page: a later page would pass its share. */
export function capToolListResult(result: unknown, limit: number | undefined, log?: (line: string) => void): unknown {
  if (limit === undefined || !result || typeof result !== "object" || Array.isArray(result)) return result;
  const { tools, nextCursor: _next, ...rest } = result as { tools?: unknown; nextCursor?: unknown };
  if (!Array.isArray(tools)) return result;
  if (tools.length > limit) log?.(`listed ${limit} of ${tools.length} tools to fit the model's tool limit`);
  return { ...rest, tools: capToolList(tools, limit) };
}

/**
 * Each server's share of `budget` tools. A server whose count is known keeps that many while the budget lasts, in turn
 * order; the rest split what is left evenly, the earlier ones taking the remainder. Deterministic for the same servers.
 */
export function shareToolBudget(servers: ReadonlyArray<{ name: string; tools?: number }>, budget: number): Map<string, number> {
  const shares = new Map<string, number>();
  let left = Math.max(0, Math.floor(budget));
  for (const server of servers) {
    if (server.tools === undefined) continue;
    const share = Math.min(Math.max(0, server.tools), left);
    shares.set(server.name, share);
    left -= share;
  }
  const unknown = servers.filter((server) => server.tools === undefined);
  unknown.forEach((server, index) => {
    shares.set(server.name, Math.floor(left / unknown.length) + (index < left % unknown.length ? 1 : 0));
  });
  return shares;
}

/** "Invalid value for 'tools': maximum number of items is 128." (OpenCode Zen), "Invalid 'tools': array too long. Expected an
 * array with maximum length 128" (OpenAI), "Too many tools provided. Maximum allowed is 128". `tools[3]...` names one
 * tool's own field, never the count. */
const TOOL_COUNT_REFUSALS: readonly RegExp[] = [
  /\btools\b(?![[.])[^\n]{0,80}?\bmaximum (?:number of items|length|allowed|number of tools)\D{0,12}?(\d{1,5})\b/i,
  /\btools\b(?![[.])[^\n]{0,40}?\bat most (\d{1,5}) items\b/i,
  /\b(?:maximum|max|at most|no more than|up to|limit of)\s+(?:of\s+)?(\d{1,5})\s+tools\b/i,
  /\btoo many tools\b[^\n]{0,80}?\b(?:maximum|max|limit)\b\D{0,24}?(\d{1,5})\b/i,
];

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const value = error as { message?: unknown; data?: unknown };
  const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : {};
  return [value.message, data.message, data.details, typeof value.data === "string" ? value.data : undefined]
    .filter((part): part is string => typeof part === "string").join("\n");
}

/** The tool-count limit a provider's refusal names, or undefined when the error is something else. */
export function toolCountLimitFromError(error: unknown): number | undefined {
  const text = errorText(error);
  const match = TOOL_COUNT_REFUSALS.map((pattern) => pattern.exec(text)).find(Boolean);
  const limit = match ? Number(match[1]) : NaN;
  return limit >= 1 && limit <= 10_000 ? limit : undefined;
}

const LEARNED_MAX = 500;
const learned = new Map<string, number>();

/** Remembers a model's limit until the server restarts; the oldest entry goes first past LEARNED_MAX. */
export function learnToolCountLimit(key: string, limit: number): void {
  learned.delete(key);
  learned.set(key, limit);
  if (learned.size > LEARNED_MAX) learned.delete(learned.keys().next().value!);
}

export function learnedToolCountLimit(key: string): number | undefined {
  return learned.get(key);
}

export function forgetToolCountLimits(): void {
  learned.clear();
}

/** A turn the provider refused for carrying too many tools, before the model ran: learns the limit and starts `retry` once,
 * which lists the turn's tools within it; `failed` reports a retry that could not start. True when it retried. */
export function retryUnderToolLimit(error: unknown, turn: {
  key: string;
  model?: string;
  engine: string;
  retry: () => Promise<unknown>;
  failed: (error: unknown) => void;
}): boolean {
  const limit = toolCountLimitFromError(error);
  if (limit === undefined) return false;
  learnToolCountLimit(turn.key, limit);
  console.warn(`[${turn.engine}] ${turn.model ?? "this model"} takes at most ${limit} tools; retrying the turn once with its MCP tool lists trimmed to fit`);
  turn.retry().catch(turn.failed);
  return true;
}

/** What a limit leaves the MCP servers once the engine's own tools are counted. */
export function mcpToolBudget(limit: number | undefined, engineTools: number): number | undefined {
  return limit === undefined ? undefined : Math.max(0, limit - engineTools);
}
