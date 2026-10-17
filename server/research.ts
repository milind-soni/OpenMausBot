// Research for bots through treg (treg.to): find an endpoint for a job in treg's catalog, read it, call it. With the
// person's own treg key the calls go straight to treg, billed to their treg balance, with no limits from this side;
// otherwise they go through the MausBot Cloud Admin's research relay (its `/research/*` routes under the plan's X relay
// URL), within the plan's monthly research budget.
import { randomUUID } from "node:crypto";

import type { ServiceCredential } from "./included-services.ts";
import { dollarsText, readCapped, tregAuthHeaders, tregErrorFor, XResearchError } from "./x-research.ts";

/** A catalog id, or a hub tool's versioned id; never a path or a URL (those would reach a team's own tools). */
export const RESEARCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}(?:@[A-Za-z0-9._-]{1,40})?$/;
export const RESEARCH_SEARCH_MAX = 10;
const TIMEOUT_MS = 60_000;
/** Methods whose parameters are a query string, as treg's own MCP `call` reads them; any other sends a JSON body. */
const QUERY_METHODS = new Set(["GET", "HEAD", "DELETE"]);
/** A search answer stays readable: a long parameter list is on the endpoint's own page. */
const PARAMS_IN_SEARCH = 1_500;

export const RESEARCH_MESSAGES = {
  unavailable: "Research is temporarily unavailable. Try again shortly.",
  notOffered: "MausBot Cloud doesn't offer research yet. A treg key in Settings → API keys works now.",
} as const;

export interface ResearchCallInput {
  id: string;
  params?: Record<string, unknown> | unknown[];
  query?: Record<string, unknown>;
}

export interface ResearchCallResult {
  /** The provider's answer, as treg relays it: parsed JSON, or text. */
  result: unknown;
  /** What the call cost, when treg (or the relay) said. */
  costUsd?: number;
  /** The relay holds the charge until treg settles it (an async task, or an answer that named no charge). */
  costPending?: true;
  callId?: string;
  /** A 2xx in which the provider itself reported a failure. */
  upstreamFailed?: string;
}

export interface ResearchClient {
  search(input: { job: string; limit: number }): Promise<unknown>;
  endpoint(id: string): Promise<unknown>;
  call(input: ResearchCallInput, options?: { idempotencyKey?: string }): Promise<ResearchCallResult>;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

/** One catalog endpoint as a bot needs it: enough to call it (params, a known-good example, an async task's poll
 * descriptor) and to weigh it (cost). */
export function endpointView(row: Row, options: { maxParamsChars?: number } = {}): Row | null {
  const id = text(row.id), method = text(row.method);
  if (!id || !method) return null;
  const bounded = (value: unknown) => value === undefined || value === null ? undefined
    : options.maxParamsChars && JSON.stringify(value).length > options.maxParamsChars ? null : value;
  const cost = isRow(row.cost) ? row.cost : {};
  const params = bounded(row.input), example = bounded(row.test_request);
  return {
    id,
    name: text(row.name) ?? text(row.summary) ?? id,
    ...(text(row.summary) && row.summary !== row.name ? { summary: String(row.summary).slice(0, 600) } : {}),
    platform: text(row.platform_label) ?? text(row.platform) ?? "",
    ...(text(row.capability) ? { capability: row.capability } : {}),
    method: method.toUpperCase(),
    cost: {
      estimatedUsd: typeof cost.display_usd === "number" ? cost.display_usd : typeof cost.usd === "number" ? cost.usd : null,
      ...(text(cost.type) ? { type: cost.type } : {}), ...(text(cost.unit) ? { unit: cost.unit } : {}),
      ...(text(cost.note) ? { note: String(cost.note).slice(0, 300) } : {}),
    },
    ...(params === null ? { paramsOmitted: true } : params === undefined ? {} : { params }),
    ...(example === undefined || example === null ? {} : { example }),
    ...(row.async === undefined || row.async === null ? {} : { async: row.async }),
    ...(row.strict_query === true ? { strictQuery: true } : {}),
    ...(text(row.docs_url) ? { docsUrl: row.docs_url } : {}),
  };
}

const scalar = (value: unknown) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
const wire = (value: unknown) => typeof value === "boolean" ? (value ? "true" : "false") : typeof value === "string" ? value : typeof value === "number" ? String(value) : JSON.stringify(value);

/** The query string and body treg is sent for a call to `row`: `params` is a GET (HEAD, DELETE) endpoint's query string
 * or any other endpoint's JSON body; `query` adds a query string to the latter. Arrays in the query follow the
 * endpoint's `queryArrayEncoding` (repeated keys unless it says JSON or comma-separated). */
export function researchRequest(row: Row, input: ResearchCallInput): { search: string; body?: string } {
  const method = String(row.method).toUpperCase(), id = String(row.id);
  const queryMethod = QUERY_METHODS.has(method);
  if (queryMethod && input.query && input.params !== undefined) {
    throw new XResearchError("bad_input", `${id} is a ${method} endpoint: send its parameters as params or as query, not both.`);
  }
  const pairs = queryMethod ? input.params ?? input.query ?? {} : input.query ?? {};
  if (!isRow(pairs) || !Object.values(pairs).every((value) => scalar(value) || (Array.isArray(value) && value.every(scalar)))) {
    throw new XResearchError("bad_input", `${id} takes its ${queryMethod ? "parameters" : "query"} as names with text, number or true/false values (or lists of them).`);
  }
  const encoding = isRow(row.input) ? row.input.queryArrayEncoding : undefined;
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(pairs)) {
    if (!Array.isArray(value)) search.append(name, wire(value));
    else if (encoding === "json") search.append(name, JSON.stringify(value));
    else if (encoding === "comma") search.append(name, value.map(wire).join(","));
    else for (const item of value) search.append(name, wire(item));
  }
  const query = search.size ? `?${search.toString()}` : "";
  return queryMethod ? { search: query } : { search: query, body: JSON.stringify(input.params ?? {}) };
}

function parsed(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

const costOf = (value: string | null, scale: number) => {
  const amount = value === null || !value.trim() ? NaN : Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount / scale : undefined;
};

/** The relay's own refusals carry a sentence in `message`; a 404 on its research routes means research isn't on yet. */
function relayError(status: number, body: unknown): XResearchError {
  const said = isRow(body) && typeof body.message === "string" ? body.message.slice(0, 400) : undefined;
  const code = isRow(body) ? body.error : undefined;
  if (status === 404 && (code === "not_found" || !said)) return new XResearchError("unavailable", RESEARCH_MESSAGES.notOffered);
  if (!said) return new XResearchError("unavailable", RESEARCH_MESSAGES.unavailable);
  const kind = status === 400 || status === 422 ? "bad_input" : status === 404 ? "not_found" : status === 402 ? "no_credit" : status === 409 ? "in_progress" : status === 429 ? "rate_limited" : "unavailable";
  const near = isRow(body) && Array.isArray(body.didYouMean) ? (body.didYouMean as unknown[]).filter((id): id is string => typeof id === "string").slice(0, 5) : [];
  return new XResearchError(kind, near.length ? `${said} Did you mean ${near.join(", ")}?` : said);
}

/** The research client for a credential: treg's own API with the person's key (`included` false), else the plan's
 * relay. One retry, with the same Idempotency-Key, when a call's answer is lost on the way or treg says it is still
 * running; anything else is answered once. */
export function createResearchClient(credential: ServiceCredential, options: { fetcher?: typeof fetch; timeoutMs?: number; retryDelayMs?: number } = {}): ResearchClient {
  const fetcher = options.fetcher ?? fetch;
  const base = credential.api.replace(/\/+$/, "");
  const own = !credential.included;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function send(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: { ...tregAuthHeaders(credential), accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
    const raw = await readCapped(response).catch((error: unknown) => {
      throw error instanceof XResearchError ? new XResearchError("unavailable", "That answer was too large to read. Ask for fewer results.") : error;
    });
    const body = parsed(raw);
    if (!response.ok) throw own ? tregErrorFor(response.status, body, response.headers) : relayError(response.status, body);
    return { body, headers: response.headers };
  }

  const answered = async (method: string, path: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const answer = await send(method, path, init);
    if (!answer) throw new XResearchError("unavailable", own ? "Couldn't reach treg. Try again in a minute." : RESEARCH_MESSAGES.unavailable);
    return answer;
  };

  async function endpointRow(id: string): Promise<Row> {
    const { body } = await answered("GET", `/catalog/endpoints/${encodeURIComponent(id)}`);
    const row = isRow(body) && isRow(body.endpoint) ? body.endpoint : null;
    if (!row || row.id !== id || !text(row.method)) throw new XResearchError("unavailable", `treg's catalog row for ${id} can't be read.`);
    return row;
  }

  return {
    async search({ job, limit }) {
      if (!own) return (await answered("GET", `/research/search?${new URLSearchParams({ q: job, limit: String(limit) })}`)).body;
      const { body } = await answered("GET", `/catalog/search?${new URLSearchParams({ q: job, limit: String(limit) })}`);
      const rows = isRow(body) && Array.isArray(body.results) ? body.results.filter(isRow) : [];
      const results = rows.map((row) => endpointView(row, { maxParamsChars: PARAMS_IN_SEARCH })).filter((view): view is Row => view !== null).slice(0, limit);
      return { query: job, results, ...(isRow(body) && text(body.verdict) ? { verdict: body.verdict } : {}) };
    },
    async endpoint(id) {
      if (!own) return (await answered("GET", `/research/endpoints/${encodeURIComponent(id)}`)).body;
      return { endpoint: endpointView(await endpointRow(id)) };
    },
    async call(input, callOptions = {}) {
      const key = callOptions.idempotencyKey ?? randomUUID();
      let request: { method: string; path: string; body?: string };
      if (own) {
        const row = await endpointRow(input.id);
        const built = researchRequest(row, input);
        request = { method: String(row.method).toUpperCase(), path: `/call/${encodeURIComponent(input.id)}${built.search}`, ...(built.body === undefined ? {} : { body: built.body }) };
      } else {
        request = { method: "POST", path: `/research/call/${encodeURIComponent(input.id)}`, body: JSON.stringify({ ...(input.params === undefined ? {} : { params: input.params }), ...(input.query ? { query: input.query } : {}) }) };
      }
      const once = () => send(request.method, request.path, { ...(request.body === undefined ? {} : { body: request.body }), headers: { "idempotency-key": key } });
      let answer: Awaited<ReturnType<typeof send>>;
      try {
        answer = await once();
      } catch (error) {
        if (!(error instanceof XResearchError) || error.code !== "in_progress") throw error;
        answer = null;
      }
      if (!answer) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 2_000));
        answer = await once();
      }
      if (!answer) throw new XResearchError("unavailable", own ? "Couldn't reach treg. Try again in a minute." : RESEARCH_MESSAGES.unavailable);
      const { body, headers } = answer;
      const costUsd = own ? costOf(headers.get("x-treg-cost-micro"), 1_000_000) : costOf(headers.get("x-omb-research-charged-usd"), 1);
      const failed = headers.get(own ? "x-treg-upstream-failed" : "x-omb-research-upstream-failed")?.slice(0, 200);
      const callId = headers.get("x-treg-call-id")?.trim();
      return {
        result: body,
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(!own && headers.get("x-omb-research-pending") === "true" ? { costPending: true as const } : {}),
        ...(callId ? { callId } : {}),
        ...(failed ? { upstreamFailed: failed } : {}),
      };
    },
  };
}

/** The cost line a bot can relay with a research answer. */
export function costLine(result: Pick<ResearchCallResult, "costUsd" | "costPending">): string | undefined {
  if (result.costUsd === undefined) return undefined;
  return result.costPending ? `about ${dollarsText(result.costUsd)}, settled when treg finishes` : dollarsText(result.costUsd);
}

export interface TregKeyCheck {
  ok: boolean;
  check: "treg";
  balanceUsd?: number;
  reason?: "rejected" | "unreachable" | "unexpected";
  message?: string;
}

/** Settings' check of a treg key: who the key belongs to, then its team's balance. Two free account reads. */
export async function checkTregKey(key: string, options: { api: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<TregKeyCheck> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.api.replace(/\/+$/, "");
  const read = async (path: string) => {
    const response = await fetcher(`${base}${path}`, {
      headers: { "x-treg-token": key, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    return { status: response.status, body: parsed(await readCapped(response).catch(() => "")) };
  };
  let me: Awaited<ReturnType<typeof read>>;
  try {
    me = await read("/auth/me");
  } catch {
    return { ok: false, check: "treg", reason: "unreachable", message: "Couldn't reach treg.to. Check this computer's connection and try again." };
  }
  if (me.status === 401 || me.status === 403) return { ok: false, check: "treg", reason: "rejected", message: "treg rejected this key. Copy it again from treg.to." };
  if (me.status < 200 || me.status >= 300) return { ok: false, check: "treg", reason: "unexpected", message: `treg answered HTTP ${me.status}. Try again shortly.` };
  const org = isRow(me.body) ? me.body.org_id ?? (isRow(me.body.org) ? me.body.org.id : undefined) : undefined;
  if (typeof org !== "string" && typeof org !== "number") return { ok: true, check: "treg" };
  try {
    const balance = await read(`/orgs/${encodeURIComponent(String(org))}/balance?limit=1`);
    const value = isRow(balance.body) ? balance.body.balance_micro : undefined;
    return typeof value === "number" && Number.isFinite(value) ? { ok: true, check: "treg", balanceUsd: value / 1_000_000 } : { ok: true, check: "treg" };
  } catch {
    return { ok: true, check: "treg" };
  }
}
