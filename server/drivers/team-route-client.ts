import type { Json } from "./agents-client.ts";

export const TEAM_ROUTE_CATEGORIES = [
  "engineering",
  "product_ux",
  "operations",
  "sales_marketing",
  "finance_owners",
  "booking_guests",
  "qa_audit",
  "coordination",
  "other",
] as const;

export type TeamRouteCategory = (typeof TEAM_ROUTE_CATEGORIES)[number];

export interface TeamRouteHarness {
  api(path: string, init?: RequestInit): Promise<Json>;
}

export interface TeamRouteConfig {
  endpoint: string;
  token: string;
  botId: string;
  harness: TeamRouteHarness;
  fetchImpl?: typeof fetch;
}

interface EligibleOwner {
  id: string;
  role: TeamRouteCategory;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseArgs(args: Json): { taskType: TeamRouteCategory; owners: EligibleOwner[] } | string {
  if (!record(args) || Object.keys(args).length !== 2 ||
      typeof args.task_type !== "string" || !TEAM_ROUTE_CATEGORIES.includes(args.task_type as TeamRouteCategory) ||
      !Array.isArray(args.eligible_owners) || args.eligible_owners.length < 1 || args.eligible_owners.length > 12) {
    return "Use task_type and 1–12 eligible_owners with only id and role fields.";
  }
  const seen = new Set<string>();
  const owners: EligibleOwner[] = [];
  for (const owner of args.eligible_owners) {
    if (!record(owner) || Object.keys(owner).length !== 2 ||
        typeof owner.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(owner.id) || seen.has(owner.id) ||
        typeof owner.role !== "string" || !TEAM_ROUTE_CATEGORIES.includes(owner.role as TeamRouteCategory)) {
      return "Each eligible owner needs a unique reachable id and one supported role category.";
    }
    seen.add(owner.id);
    owners.push({ id: owner.id, role: owner.role as TeamRouteCategory });
  }
  return { taskType: args.task_type as TeamRouteCategory, owners };
}

function endpointUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/v1/team-route/suggest") return null;
    return url;
  } catch {
    return null;
  }
}

/** Request a bounded Jev recommendation. The handler verifies live reachability
 * before sending anything to Jack Control Plane and never sends task prose. */
export async function suggestTeamTaskOwner(args: Json, config: TeamRouteConfig): Promise<{ text: string; isError?: boolean }> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return { text: parsed, isError: true };
  const endpoint = endpointUrl(config.endpoint);
  if (!endpoint || !config.token.trim()) {
    return { text: "Jev team routing is not configured with a valid HTTPS endpoint and scoped credential.", isError: true };
  }

  let roster: Json;
  try {
    roster = await config.harness.api(`/api/internal/agents?self=${encodeURIComponent(config.botId)}`, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return { text: "Could not verify the current reachable OpenMausBot team. No Jev request was sent.", isError: true };
  }
  const bots = Array.isArray(roster.bots) ? roster.bots.filter(record) : [];
  const names = new Map<string, string>();
  for (const bot of bots) {
    if (typeof bot.id === "string") names.set(bot.id, typeof bot.name === "string" ? bot.name : bot.id);
  }
  if (parsed.owners.some((owner) => !names.has(owner.id))) {
    return { text: "An eligible owner is no longer in your reachable roster. Refresh it with list_bots, then try again. No Jev request was sent.", isError: true };
  }

  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ task_type: parsed.taskType, eligible_owners: parsed.owners }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { text: "Jack Control Plane / Jev is unavailable. No teammate was assigned; tell Jack and wait for direction.", isError: true };
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    return {
      text: `Jev is rate-limited${retryAfter ? `; Retry-After: ${retryAfter}` : "; the service supplied no Retry-After"}. Do not retry automatically or assign a teammate; report this to Jack.`,
      isError: true,
    };
  }
  if (!response.ok) {
    return { text: `Jack Control Plane / Jev returned HTTP ${response.status}. No teammate was assigned; tell Jack and wait for direction.`, isError: true };
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return { text: "Jack Control Plane returned an unreadable Jev result. No teammate was assigned; tell Jack.", isError: true };
  }
  if (!record(result) || result.human_review_required !== true ||
      (result.suggested_owner_id !== null && typeof result.suggested_owner_id !== "string") ||
      (typeof result.suggested_owner_id === "string" && !parsed.owners.some((owner) => owner.id === result.suggested_owner_id)) ||
      typeof result.confidence !== "number" || !Number.isFinite(result.confidence)) {
    return { text: "Jack Control Plane returned an invalid Jev recommendation. No teammate was assigned; tell Jack.", isError: true };
  }

  const suggestedId = result.suggested_owner_id as string | null;
  return {
    text: JSON.stringify({
      suggested_owner_id: suggestedId,
      suggested_owner_name: suggestedId ? names.get(suggestedId) ?? suggestedId : null,
      confidence: result.confidence,
      human_review_required: true,
      input_state_ref: typeof result.input_state_ref === "string" ? result.input_state_ref : undefined,
      next_step: "Show this recommendation to Jack and wait for explicit confirmation before using the normal OpenMausBot team-assignment tool.",
    }),
  };
}
