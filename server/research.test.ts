import { describe, expect, it, vi } from "vitest";
import { checkTregKey, costLine, createResearchClient, RESEARCH_MESSAGES, researchRequest } from "./research.ts";
import { X_MESSAGES, XResearchError } from "./x-research.ts";

type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(...responses: Reply[]) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json", ...next.headers } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const OWN = { token: "treg_own_key", api: "https://treg.example.test", included: false };
const PLAN = { token: "omb_xd_plan", api: "https://cloud.example.test/api/cloud/services/x", included: true };
const PEOPLE = { id: "apollo.people.search", name: "Find people", method: "GET", platform: "people", cost: { usd: 0.002, type: "per_call" }, input: { type: "object" }, test_request: { q: "maus" } };
const COMPANIES = { id: "dataforseo.domains.bulk", name: "Domains", method: "POST", platform: "seo", input: { queryArrayEncoding: "comma" } };

async function failure(promise: Promise<unknown>): Promise<XResearchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(XResearchError);
    return error as XResearchError;
  }
  throw new Error("expected the call to fail");
}

describe("research with the person's own treg key", () => {
  it("searches treg's catalog with the key and shows each endpoint's params, example and cost", async () => {
    const { fetcher, calls } = fakeFetch({ body: { verdict: "strong", results: [PEOPLE, { id: "broken" }] } });
    const answer = await createResearchClient(OWN, { fetcher }).search({ job: "work email of a person", limit: 5 });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://treg.example.test/catalog/search?q=work+email+of+a+person&limit=5" });
    expect(calls[0]!.headers.get("x-treg-token")).toBe("treg_own_key");
    expect(answer).toEqual({ query: "work email of a person", verdict: "strong", results: [{
      id: "apollo.people.search", name: "Find people", platform: "people", method: "GET", cost: { estimatedUsd: 0.002, type: "per_call" },
      params: { type: "object" }, example: { q: "maus" },
    }] });
  });

  it("reads the endpoint's method from the catalog, sends params as its query string, a fresh Idempotency-Key and the key, and reports treg's cost", async () => {
    const { fetcher, calls } = fakeFetch({ body: { endpoint: PEOPLE } }, { body: { people: [] }, headers: { "x-treg-cost-micro": "2000", "x-treg-call-id": "call-1" } });
    const answer = await createResearchClient(OWN, { fetcher }).call({ id: "apollo.people.search", params: { q: "maus", titles: ["CEO", "CTO"] } });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://treg.example.test/catalog/endpoints/apollo.people.search"],
      ["GET", "https://treg.example.test/call/apollo.people.search?q=maus&titles=CEO&titles=CTO"],
    ]);
    expect(calls[1]!.headers.get("x-treg-token")).toBe("treg_own_key");
    expect(calls[1]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.headers.get("x-treg-route-max-cost")).toBeNull();
    expect(answer).toEqual({ result: { people: [] }, costUsd: 0.002, callId: "call-1" });
    expect(costLine(answer)).toBe("$0.0020");
  });

  it("sends a body endpoint's params as JSON and its query as the query string, arrays as the endpoint encodes them", async () => {
    const { fetcher, calls } = fakeFetch({ body: { endpoint: COMPANIES } }, { body: { tasks: [] } });
    await createResearchClient(OWN, { fetcher }).call({ id: "dataforseo.domains.bulk", params: [{ target: "openmausbot.com" }], query: { fields: ["rank", "traffic"] } });
    expect(calls[1]).toMatchObject({ method: "POST", url: "https://treg.example.test/call/dataforseo.domains.bulk?fields=rank%2Ctraffic", body: [{ target: "openmausbot.com" }] });
    expect(researchRequest(COMPANIES, { id: COMPANIES.id })).toEqual({ search: "", body: "{}" });
    expect(() => researchRequest(PEOPLE, { id: PEOPLE.id, params: { q: "a" }, query: { q: "b" } })).toThrow(/params or as query, not both/);
  });

  it("retries once with the same Idempotency-Key when the answer is lost on the way or treg says the call is still running", async () => {
    for (const first of [new Error("socket hang up"), { status: 409, body: { detail: "in progress" } }]) {
      const { fetcher, calls } = fakeFetch({ body: { endpoint: PEOPLE } }, first, { body: { people: [] } });
      await createResearchClient(OWN, { fetcher, retryDelayMs: 0 }).call({ id: "apollo.people.search" });
      expect(calls).toHaveLength(3);
      expect(calls[2]!.headers.get("idempotency-key")).toBe(calls[1]!.headers.get("idempotency-key"));
    }
    const { fetcher, calls } = fakeFetch({ body: { endpoint: PEOPLE } }, { body: {} }, { body: { endpoint: PEOPLE } }, { body: {} });
    const client = createResearchClient(OWN, { fetcher });
    await client.call({ id: "apollo.people.search" });
    await client.call({ id: "apollo.people.search" });
    expect(calls[3]!.headers.get("idempotency-key")).not.toBe(calls[1]!.headers.get("idempotency-key"));
  });

  it("passes treg's own refusals on: an empty balance with its top-up link, a rate limit, an unknown endpoint", async () => {
    const balance = fakeFetch({ body: { endpoint: PEOPLE } }, { status: 402, body: { balance_micro: 0, estimated_cost_micro: 2000, topup_url: "https://treg.to/billing" } });
    expect((await failure(createResearchClient(OWN, balance).call({ id: "apollo.people.search" }))).message)
      .toBe("Your treg balance is too low for this call (balance $0.00, this call needs about $0.0020). Top up at https://treg.to/billing, then try again.");
    const limited = fakeFetch({ body: { endpoint: PEOPLE } }, { status: 429, body: { detail: { error: "share_busy", retry_after_s: 3 } } });
    expect(await failure(createResearchClient(OWN, limited).call({ id: "apollo.people.search" }))).toMatchObject({ code: "rate_limited", message: expect.stringContaining("Try again in 3 seconds.") });
    const unknown = fakeFetch({ status: 404, body: { detail: { error: "unknown_endpoint", did_you_mean: ["apollo.people.search"] } } });
    expect((await failure(createResearchClient(OWN, unknown).endpoint("apollo.person.search"))).message).toContain("Did you mean apollo.people.search?");
    const rejected = fakeFetch({ status: 401, body: { detail: "invalid token" } });
    expect(await failure(createResearchClient(OWN, rejected).search({ job: "x", limit: 5 }))).toMatchObject({ code: "bad_key", message: X_MESSAGES.ownBadKey });
  });
});

describe("research through the plan's relay", () => {
  it("maps the three tools onto the Admin's research routes with the plan's bearer, never treg directly", async () => {
    const { fetcher, calls } = fakeFetch(
      { body: { query: "people", results: [], budget: { leftUsd: 14 } } },
      { body: { endpoint: { id: "apollo.people.search" } } },
      { body: { people: [] }, headers: { "x-omb-research-charged-usd": "0.0045", "x-omb-research-pending": "true" } },
    );
    const client = createResearchClient(PLAN, { fetcher });
    expect(await client.search({ job: "people", limit: 3 })).toEqual({ query: "people", results: [], budget: { leftUsd: 14 } });
    await client.endpoint("apollo.people.search");
    const answer = await client.call({ id: "apollo.people.search", params: { q: "maus" }, query: { page: 2 } });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${PLAN.api}/research/search?q=people&limit=3`],
      ["GET", `${PLAN.api}/research/endpoints/apollo.people.search`],
      ["POST", `${PLAN.api}/research/call/apollo.people.search`],
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer omb_xd_plan");
      expect(call.headers.get("x-treg-token")).toBeNull();
    }
    expect(calls[2]!.body).toEqual({ params: { q: "maus" }, query: { page: 2 } });
    expect(calls[2]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer).toEqual({ result: { people: [] }, costUsd: 0.0045, costPending: true });
    expect(costLine(answer)).toBe("about $0.0045, settled when treg finishes");
  });

  it("relays the Admin's own sentence, with what keeps research going once the month's is used up, and says research isn't offered yet while its routes are off", async () => {
    const used = fakeFetch({ status: 429, body: { error: "quota_exceeded", message: "This month's $15 of research is used up. It resets on 1 November." } });
    expect((await failure(createResearchClient(PLAN, used).call({ id: "apollo.people.search" }))).message).toBe("This month's $15 of research is used up. It resets on 1 November. Add your own treg key to keep going.");
    const off = fakeFetch({ status: 404, body: { error: "not_found", message: "Not found." } });
    expect((await failure(createResearchClient(PLAN, off).search({ job: "x", limit: 5 }))).message).toBe(RESEARCH_MESSAGES.notOffered);
  });
});

describe("Settings' treg key check", () => {
  it("says treg is working with the team's balance, from two account reads with the key", async () => {
    const { fetcher, calls } = fakeFetch({ body: { org_id: "org-1" } }, { body: { balance_micro: 4_250_000 } });
    expect(await checkTregKey("treg_own_key", { api: "https://treg.example.test", fetcher })).toEqual({ ok: true, check: "treg", balanceUsd: 4.25 });
    expect(calls.map((call) => call.url)).toEqual(["https://treg.example.test/auth/me", "https://treg.example.test/orgs/org-1/balance?limit=1"]);
    for (const call of calls) expect(call.headers.get("x-treg-token")).toBe("treg_own_key");
  });

  it("names the exact problem: a rejected key, an unreachable treg, an unexpected answer", async () => {
    expect(await checkTregKey("bad", { api: "https://treg.example.test", fetcher: fakeFetch({ status: 401, body: {} }).fetcher }))
      .toEqual({ ok: false, check: "treg", reason: "rejected", message: "treg rejected this key. Copy it again from treg.to." });
    expect((await checkTregKey("k", { api: "https://treg.example.test", fetcher: fakeFetch(new Error("ENOTFOUND")).fetcher })).reason).toBe("unreachable");
    expect(await checkTregKey("k", { api: "https://treg.example.test", fetcher: fakeFetch({ status: 500, body: {} }).fetcher }))
      .toMatchObject({ ok: false, reason: "unexpected", message: "treg answered HTTP 500. Try again shortly." });
  });
});
