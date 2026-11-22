import { describe, expect, it } from "vitest";

import { eduCloudUrlProblem } from "../shared/edu-brain.ts";
import { cloudBase, createEduCloud, EDU_CLOUD_NO_TOKEN, usableCloudToken } from "./edu-cloud.ts";

const TOKEN = "s".repeat(48);
const bot = (token = "EDU_CLOUD_BI") => ({ id: "b1", eduBrain: { mode: "cloud" as const, url: "https://brain.example/team/mcp", token: { secret: token } } });

function fakeServer(routes: Record<string, (init: RequestInit) => Response>) {
  const seen: Array<{ url: string; method: string; authorization: string | null; redirect?: RequestInit["redirect"] }> = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    seen.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization"), redirect: init.redirect });
    const route = routes[`${init.method ?? "GET"} ${new URL(url).pathname}`];
    return route ? route(init) : Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, seen };
}

describe("edu-cloud brains", () => {
  it("finds the review routes beside /mcp and sends a token only when one is saved", () => {
    expect(cloudBase("https://brain.example/team/mcp")).toBe("https://brain.example/team");
    expect(cloudBase("https://brain.example/mcp/")).toBe("https://brain.example");
    expect(usableCloudToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(usableCloudToken("short")).toBeNull();
    expect(usableCloudToken("has space in it, which no token does")).toBeNull();
  });

  it("reads an older edu-cloud as one without review: no proposals, approved on the server", async () => {
    const { fetcher, seen } = fakeServer({});
    const cloud = createEduCloud({ token: () => TOKEN, fetch: fetcher });
    expect(await cloud.view(bot())).toEqual({ url: "https://brain.example/team/mcp", token: "EDU_CLOUD_BI", review: false });
    expect(await cloud.list(bot())).toEqual([]);
    expect(await cloud.steward(bot())).toBe(false);
    expect(seen.every((call) => call.authorization === `Bearer ${TOKEN}` && call.redirect === "error")).toBe(true);
    expect(seen.map((call) => call.url)).toContain("https://brain.example/team/api/v1/whoami");
  });

  it("lists a member's proposals read-only and lets a steward decide them", async () => {
    let scope = "member";
    const decided: string[] = [];
    const { fetcher } = fakeServer({
      "GET /team/api/v1/whoami": () => Response.json({ label: "ana@example.com", teamId: "bi", scope, review: true }),
      "GET /team/api/v1/proposals": () => Response.json({ proposals: [
        { id: "C-20261122-revenue", title: "Revenue means net revenue", kind: "domain", band: "inferred", why: "interpretation", body: "Net of returns." },
        { id: "--flag", title: "Not an id" },
      ], mayDecide: scope === "steward" }),
      "POST /team/api/v1/proposals/C-20261122-revenue/approve": () => scope === "steward"
        ? (decided.push("approve"), Response.json({ id: "C-20261122-revenue", outcome: "accepted" }))
        : Response.json({ error: "Only a steward token can approve or reject proposals" }, { status: 403 }),
      "POST /team/api/v1/proposals/C-20261122-revenue/reject": (init) => (decided.push(`reject ${String(init.body)}`), Response.json({ outcome: "rejected" })),
    });
    let now = 0;
    const cloud = createEduCloud({ token: () => TOKEN, fetch: fetcher, now: () => now });
    expect(await cloud.view(bot())).toMatchObject({ review: true, label: "ana@example.com", scope: "member" });
    expect(await cloud.list(bot())).toEqual([{
      id: "C-20261122-revenue", title: "Revenue means net revenue", kind: "domain", band: "inferred", why: "interpretation",
      brain: "https://brain.example/team/mcp", global: false, location: "https://brain.example/team/mcp", shared: true, cloud: true, body: "Net of returns.",
    }]);
    expect(await cloud.decide(bot(), "C-20261122-revenue", true)).toEqual({ status: 403, error: "Only a steward of this edu-cloud brain can approve or reject its proposals." });
    scope = "steward";
    now += 61_000;
    expect(await cloud.steward(bot())).toBe(true);
    expect(await cloud.decide(bot(), "C-20261122-revenue", true)).toBe("accepted");
    expect(await cloud.decide(bot(), "C-20261122-revenue", false, "Rejected in Edu Bot")).toBe("rejected");
    expect(await cloud.decide(bot(), "C-20261122-other", true)).toBe("gone");
    expect(await cloud.decide(bot(), "--flag", true)).toEqual({ status: 400, error: "That isn't an Edu proposal id." });
    expect(decided).toEqual(["approve", 'reject {"reason":"Rejected in Edu Bot"}']);
  });

  it("asks for the token before anything leaves this computer", async () => {
    const { fetcher, seen } = fakeServer({});
    const cloud = createEduCloud({ token: () => null, fetch: fetcher });
    expect(await cloud.view(bot())).toEqual({ url: "https://brain.example/team/mcp", token: "EDU_CLOUD_BI", tokenMissing: true, review: false });
    await expect(cloud.list(bot())).rejects.toThrow(EDU_CLOUD_NO_TOKEN);
    await expect(cloud.brief(bot())).rejects.toThrow(EDU_CLOUD_NO_TOKEN);
    expect(await cloud.decide(bot(), "C-1", true)).toEqual({ status: 409, error: EDU_CLOUD_NO_TOKEN });
    expect(cloud.server(bot(), { threadId: "t1", generation: "g1" })).toBeNull();
    expect(seen).toEqual([]);
  });

  it("relays only MCP JSON-RPC to the brain's own /mcp, adding the person's token here", async () => {
    const forwarded: Array<{ url: string; method: string; headers: Headers; body?: string; redirect?: RequestInit["redirect"] }> = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      forwarded.push({ url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body as string | undefined, redirect: init.redirect });
      return new Response("event: message\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1", "set-cookie": "x=1" } });
    }) as typeof fetch;
    const cloud = createEduCloud({ token: () => TOKEN, fetch: fetcher });
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edu_recall", arguments: { query: "x" } } };
    const relayed = await cloud.relay(bot(), { method: "POST", headers: { accept: "application/json, text/event-stream", "mcp-session-id": "s-1", authorization: "Bearer capability", cookie: "c=1" }, body: call });
    expect(relayed.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ url: "https://brain.example/team/mcp", method: "POST", body: JSON.stringify(call), redirect: "error" });
    expect(Object.fromEntries(forwarded[0]!.headers)).toEqual({ accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "mcp-session-id": "s-1" });
    expect((await cloud.relay(bot(), { method: "DELETE", headers: { "mcp-session-id": "s-1" } })).status).toBe(200);
    expect(forwarded[1]).toMatchObject({ method: "DELETE", body: undefined });

    for (const [request, status] of [
      [{ method: "GET", headers: {} }, 405],
      [{ method: "POST", headers: {}, body: { action: "approve", id: "C-1" } }, 400],
      [{ method: "POST", headers: {}, body: [] }, 400],
    ] as const) expect((await cloud.relay(bot(), request)).status).toBe(status);
    expect((await createEduCloud({ token: () => null, fetch: fetcher }).relay(bot(), { method: "POST", headers: {}, body: call })).status).toBe(409);
    expect((await cloud.relay(bot(), { method: "GET", headers: {} })).headers.get("allow")).toBe("POST, DELETE");
    const reviewRoute = { id: "b1", eduBrain: { mode: "cloud" as const, url: "https://brain.example/team/api/v1/proposals/K-1/approve", token: { secret: "EDU_CLOUD_BI" } } };
    expect((await cloud.relay(reviewRoute, { method: "POST", headers: {}, body: call })).status).toBe(409);
    expect(forwarded).toHaveLength(2);
  });

  it("only accepts the brain's /mcp address", () => {
    expect(eduCloudUrlProblem("https://brain.example/team/mcp")).toBeNull();
    expect(eduCloudUrlProblem("https://brain.example/mcp/")).toBeNull();
    expect(eduCloudUrlProblem("http://127.0.0.1:8787/api/v1/proposals/K-1/approve")).toBe("must be the brain's /mcp address");
    expect(eduCloudUrlProblem("https://brain.example/")).toBe("must be the brain's /mcp address");
  });

  it("never follows a redirect with the person's token when it reads the brief", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(String(input));
      if (init.redirect === "error") throw new TypeError("redirect refused");
      return new Response(null, { status: 307, headers: { location: "https://brain.example/team/api/v1/proposals/C-1/approve" } });
    }) as typeof fetch;
    await expect(createEduCloud({ token: () => TOKEN, fetch: fetcher }).brief(bot())).rejects.toThrow();
    expect(seen.every((url) => url.endsWith("/mcp"))).toBe(true);
  });
});
