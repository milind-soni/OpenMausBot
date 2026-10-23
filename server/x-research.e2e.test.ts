// End-to-end coverage for research through treg on a real server and a real agents proxy: which bots are shown the X
// and research tools, and where their calls go. One loopback stub stands in for both treg (OMB_TREG_URL, for a person's
// own treg key) and the Admin's relay (OMB_CLOUD_X_URL and OMB_CLOUD_X_TOKEN, as a Cloud home is wired). No external
// service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

interface Seen { method: string; path: string; authorization: string | undefined; tregToken: string | undefined; idempotencyKey: string | undefined; body: unknown }
const RELAY_PATH = "/api/cloud/services/x", PLAN_TOKEN = "omb_x_e2e_fixture", OWN_KEY = "treg_e2e_own_key";
const RESEARCH_TOOLS = ["x_search", "x_user_posts", "x_post", "x_profile", "research_search", "research_endpoint", "research_call"];
const POSTS = { output: { data: { items: [
  { id: "2107987482155561188", authorUsername: "maus", authorName: "Maus", createdUtc: 1791418354, text: "MausBot searched X", likeCount: 4, viewCount: 120 },
], nextCursor: "" } } };
const USAGE = { calls: 312, max: 5_000, resetsAt: "2026-11-01T00:00:00.000Z" };
const USED_UP = "Your Pro plan's 5,000 X research calls for October are used up. They reset on 1 November.";
const PEOPLE_ROW = { id: "apollo.people.search", name: "Find people", method: "GET", platform: "people", cost: { usd: 0.002, type: "per_call" }, input: { type: "object" } };

/** treg at the root (own key, X-Treg-Token) and the relay under RELAY_PATH (plan token, bearer). Anything else is a 404. */
async function serveStub(seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk; });
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({ method: req.method ?? "", path, authorization: req.headers.authorization, tregToken: req.headers["x-treg-token"] as string | undefined,
        idempotencyKey: req.headers["idempotency-key"] as string | undefined, body: raw ? JSON.parse(raw) : undefined });
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const own = req.headers["x-treg-token"] === OWN_KEY, plan = req.headers.authorization === `Bearer ${PLAN_TOKEN}`;
      if (own && path === "/auth/me") return send(200, { org_id: "org-e2e" });
      if (own && path === "/orgs/org-e2e/balance?limit=1") return send(200, { balance_micro: 4_250_000 });
      if (own && path === "/call/anyapi.x.search.posts") return send(200, POSTS, { "x-treg-cost-micro": "750" });
      if (own && path === "/catalog/endpoints/apollo.people.search") return send(200, { endpoint: PEOPLE_ROW });
      if (own && path === "/call/apollo.people.search?q_organization_domains=openmausbot.com") return send(200, { people: [{ name: "Maus" }] }, { "x-treg-cost-micro": "2000", "x-treg-call-id": "call-e2e" });
      if (plan && req.method === "GET" && path === `${RELAY_PATH}/usage`) return send(200, USAGE);
      if (plan && path === `${RELAY_PATH}/call/anyapi.x.search.posts` && raw.includes("used up")) return send(429, { error: "quota_exceeded", message: USED_UP });
      if (plan && path === `${RELAY_PATH}/call/anyapi.x.search.posts`) return send(200, POSTS);
      if (plan && path === `${RELAY_PATH}/research/call/apollo.people.search`) return send(200, { people: [{ name: "Maus" }] }, { "x-omb-research-charged-usd": "0.002" });
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function withFixture(test: (f: any) => Promise<void>, options: { plan: boolean; ownKey: boolean }) {
  const seen: Seen[] = [];
  const stub = await serveStub(seen);
  const env = { OMB_TREG_URL: stub.url, ...(options.plan ? { OMB_CLOUD_X_URL: `${stub.url}${RELAY_PATH}`, OMB_CLOUD_X_TOKEN: PLAN_TOKEN } : {}) };
  const session = await launchVerificationServer({ ...process.env, ...env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const turnFor = (botId: string) => {
    const lines = existsSync(planPath + ".evidence.jsonl") ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean) : [];
    return lines.map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === botId).at(-1);
  };
  try {
    if (options.ownKey) await api("/api/config", { treg: { key: OWN_KEY } }, "PUT");
    await test({
      api,
      seen,
      status: () => api("/api/x/status?refresh=1", undefined, "GET"),
      /** Everything the bot's engine was started with in its latest turn: argv, environment, prompt, system prompt, tool servers. */
      engineLaunch: () => readFileSync(session.fixtureDumpPath, "utf8"),
      newBot: async (name: string) => (await cli("new-bot", "--name", name)).bot,
      /** Runs one turn of `bot` with these tool steps; answers its listed tools and each step's tool result. */
      turn: async (bot: any, steps: Array<{ tool: string; arguments: unknown }>, options: { failing?: boolean } = {}) => {
        writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply: "Done." } }));
        await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Research this.");
        const settled = (await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status;
        if (!options.failing) expect(settled).toBe("settled");
        const evidence = turnFor(bot.id).evidence;
        return {
          evidence: JSON.stringify(evidence),
          tools: evidence[0].result.tools.map((tool: any) => tool.name) as string[],
          results: evidence.filter((entry: any) => entry.step).map((entry: any) => {
            if (options.failing) return entry.response.result.content[0].text;
            expect(entry.response.result.isError, entry.response.result.content?.[0]?.text).toBeFalsy();
            return JSON.parse(entry.response.result.content[0].text);
          }),
        };
      },
    });
  } finally {
    stub.server.close();
    await session.close();
  }
}

const SEARCH = { tool: "x_search", arguments: { query: "mausbot" } };
const PEOPLE = { tool: "research_call", arguments: { id: "apollo.people.search", params: { q_organization_domains: "openmausbot.com" } } };

it("shows no research tools without a treg key or a Cloud plan, even to a bot switched on", async () => withFixture(async (f) => {
  const config = await f.api("/api/config", undefined, "GET");
  expect(await f.status()).toEqual({ using: null, ownKey: false, included: false });
  expect(config.xResearch).toEqual({ included: false });
  expect(config.treg).toEqual({ configured: false });
  const bot = await f.newBot("No research");
  await f.api("/api/bots/" + bot.id, { xResearch: true }, "PATCH");
  const { tools } = await f.turn(bot, []);
  for (const tool of RESEARCH_TOOLS) expect(tools).not.toContain(tool);
  expect(f.seen).toEqual([]);
}, { plan: false, ownKey: false }), 90_000);

it("with the person's own treg key, every bot has the tools by default and calls go straight to treg, never the relay", async () => withFixture(async (f) => {
  expect((await f.api("/api/config", undefined, "GET")).treg).toEqual({ configured: true });
  expect(await f.status()).toEqual({ using: "own", ownKey: true, included: false });
  expect(await f.api("/api/keys/test", { provider: "treg" })).toEqual({ ok: true, check: "treg", balanceUsd: 4.25 });
  const bot = await f.newBot("Own key");
  expect(bot.xResearch).toBeUndefined();
  const { tools, results } = await f.turn(bot, [SEARCH, PEOPLE]);
  expect(tools).toEqual(expect.arrayContaining(RESEARCH_TOOLS));
  expect(results[0].posts).toEqual([expect.objectContaining({ id: "2107987482155561188", author: "@maus", text: "MausBot searched X" })]);
  expect(results[1]).toEqual({ result: { people: [{ name: "Maus" }] }, cost: "$0.0020", callId: "call-e2e" });
  const calls = f.seen.filter((seen: Seen) => !seen.path.startsWith("/auth/") && !seen.path.startsWith("/orgs/"));
  expect(calls.map((seen: Seen) => [seen.method, seen.path, seen.tregToken, seen.authorization])).toEqual([
    ["POST", "/call/anyapi.x.search.posts", OWN_KEY, undefined],
    ["GET", "/catalog/endpoints/apollo.people.search", OWN_KEY, undefined],
    ["GET", "/call/apollo.people.search?q_organization_domains=openmausbot.com", OWN_KEY, undefined],
  ]);
  expect(calls[2].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.seen.some((seen: Seen) => seen.path.startsWith(RELAY_PATH))).toBe(false);
}, { plan: false, ownKey: true }), 90_000);

it("with only a Cloud plan, calls go through the relay with the plan's token, and a bot switched off has no tools", async () => withFixture(async (f) => {
  expect((await f.api("/api/config", undefined, "GET")).xResearch).toEqual({ included: true });
  const on = await f.newBot("Plan on");
  const off = await f.newBot("Plan off");
  await f.api("/api/bots/" + off.id, { xResearch: false }, "PATCH");
  await expect(f.api("/api/bots/" + off.id, { xResearch: "yes" }, "PATCH")).rejects.toThrow(/xResearch must be true or false/);
  expect((await f.turn(off, [])).tools).not.toContain("x_search");
  const { tools, results } = await f.turn(on, [SEARCH, PEOPLE]);
  expect(tools).toEqual(expect.arrayContaining(RESEARCH_TOOLS));
  expect(results[0].newestId).toBe("2107987482155561188");
  expect(results[1]).toEqual({ result: { people: [{ name: "Maus" }] }, cost: "$0.0020" });
  expect(f.seen.map((seen: Seen) => [seen.method, seen.path, seen.authorization, seen.tregToken])).toEqual([
    ["POST", `${RELAY_PATH}/call/anyapi.x.search.posts`, `Bearer ${PLAN_TOKEN}`, undefined],
    ["POST", `${RELAY_PATH}/research/call/apollo.people.search`, `Bearer ${PLAN_TOKEN}`, undefined],
  ]);
  expect(f.seen[1].body).toEqual({ params: { q_organization_domains: "openmausbot.com" } });
  expect(f.seen[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await f.status()).toEqual({ using: "included", ownKey: false, included: true, usage: USAGE });
  expect(f.seen.at(-1)).toMatchObject({ method: "GET", path: `${RELAY_PATH}/usage`, authorization: `Bearer ${PLAN_TOKEN}`, tregToken: undefined });
  const usedUp = await f.turn(on, [{ tool: "x_search", arguments: { query: "used up" } }], { failing: true });
  expect(usedUp.results).toEqual([`${USED_UP} Add your own treg key to keep going.`]);
}, { plan: true, ownKey: false }), 90_000);

it("with both a treg key and a Cloud plan, the person's own key wins and the card says so; removing it falls back to the plan", async () => withFixture(async (f) => {
  const bot = await f.newBot("Both");
  const { tools, evidence } = await f.turn(bot, [SEARCH]);
  expect(tools).toEqual(expect.arrayContaining(RESEARCH_TOOLS));
  expect(f.seen.map((seen: Seen) => [seen.path, seen.tregToken, seen.authorization])).toEqual([["/call/anyapi.x.search.posts", OWN_KEY, undefined]]);
  expect(await f.status()).toEqual({ using: "own", ownKey: true, included: true, usage: USAGE });
  // Security: neither the person's key nor the plan's token reaches the bot: not its engine's arguments, environment,
  // prompt or tool servers, and not its tool list or results.
  for (const secret of [OWN_KEY, PLAN_TOKEN]) {
    expect(f.engineLaunch()).not.toContain(secret);
    expect(evidence).not.toContain(secret);
  }
  await f.api("/api/config", { treg: { key: "" } }, "PUT");
  expect(await f.status()).toEqual({ using: "included", ownKey: false, included: true, usage: USAGE });
  const after = f.seen.length;
  expect((await f.turn(bot, [SEARCH])).tools).toEqual(expect.arrayContaining(RESEARCH_TOOLS));
  expect(f.seen.slice(after).map((seen: Seen) => [seen.path, seen.tregToken, seen.authorization])).toEqual([[`${RELAY_PATH}/call/anyapi.x.search.posts`, undefined, `Bearer ${PLAN_TOKEN}`]]);
}, { plan: true, ownKey: true }), 90_000);
