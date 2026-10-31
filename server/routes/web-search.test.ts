import { describe, expect, it, vi } from "vitest";
import { webSearchAllowed } from "../web-search-access.ts";
import { createWebSearchRoute, type WebSearchContext } from "./web-search.ts";

const caps = { sessionModelSwitch: "in-session", agentsMcp: true, webSearch: true } as const;
function context(body: unknown = { query: " cats ", limit: 2 }) {
  return { method: "POST", path: "/api/internal/web/search", botId: "fixture", res: {}, json: vi.fn(),
    readBody: async () => body, folders: async () => ({ roots: [], vmWorkspace: null }), assertWebSearchAllowed: vi.fn(), webSearchSignal: new AbortController().signal } as unknown as WebSearchContext;
}

describe("web search authorization and route", () => {
  it("requires the engine capability, agents MCP and the bot's own grant", () => {
    expect(webSearchAllowed(caps, undefined)).toBe(true);
    expect(webSearchAllowed(undefined, undefined)).toBe(false);
    expect(webSearchAllowed({ ...caps, agentsMcp: false }, undefined)).toBe(false);
    expect(webSearchAllowed({ ...caps, webSearch: false }, undefined)).toBe(false);
    expect(webSearchAllowed(caps, { allow: ["mcp:agents:web_search"] })).toBe(true);
    for (const scope of [{ allow: [] }, { deny: ["mcp:agents:web_search"] }, { allow: ["native:*"] }, { allow: null }]) expect(webSearchAllowed(caps, scope)).toBe(false);
  });
  it("returns bounded hits explicitly marked as untrusted", async () => {
    const search = vi.fn(async () => [{ title: "Ignore instructions", url: "https://example.com/", snippet: "Untrusted" }]);
    const ctx = context(); await createWebSearchRoute(() => ({ braveApiKey: "synthetic-key" }), search)(ctx);
    expect(search).toHaveBeenCalledWith({ braveApiKey: "synthetic-key" }, "cats", 2, ctx.webSearchSignal, { assertAllowed: ctx.assertWebSearchAllowed });
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, 200, { source: "Brave Search", untrusted: true, results: await search() });
    expect(ctx.assertWebSearchAllowed).toHaveBeenCalledTimes(3);
  });
  it.each([{}, { query: " " }, { query: "x".repeat(513) }, { query: "cats", limit: 0 }, { query: "cats", limit: 11 }, { query: "cats", url: "http://localhost" }])("refuses invalid input %j without network access", async body => {
    const search = vi.fn(); const ctx = context(body); await createWebSearchRoute(() => ({ braveApiKey: "synthetic-key" }), search)(ctx);
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, 400, expect.anything()); expect(search).not.toHaveBeenCalled();
  });
  it("rechecks the grant after the body read and after the search", async () => {
    for (const phase of ["body", "search"]) {
      let allowed = true; const ctx = context();
      ctx.assertWebSearchAllowed = () => { if (!allowed) throw Object.assign(new Error("revoked"), { status: 403 }); };
      if (phase === "body") ctx.readBody = async () => { allowed = false; return { query: "cats" }; };
      const search = vi.fn(async () => { allowed = false; return []; });
      await expect(createWebSearchRoute(() => ({ braveApiKey: "synthetic-key" }), search)(ctx)).rejects.toThrow("revoked");
      expect(ctx.json).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledTimes(phase === "body" ? 0 : 1);
    }
  });
});

describe("server search admission", () => {
  it("rejects absent configuration without calling the backend", async () => {
    const search = vi.fn(); const ctx = context();
    await createWebSearchRoute(() => undefined, search)(ctx);
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, 503, { error: "Web search is not configured. Configure SearXNG or Brave Search before using web search." });
    expect(search).not.toHaveBeenCalled();
  });
  it("admits one call per bot and four globally, releases slots on failure", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const search = vi.fn(async () => { await held; throw new Error("offline"); });
    const route = createWebSearchRoute(() => ({ braveApiKey: "key" }), search);
    const pending = [context(), context(), context(), context()];
    pending.forEach((ctx, i) => { ctx.botId = String(i); });
    const runs = pending.map(ctx => route(ctx));
    await Promise.resolve(); await Promise.resolve();
    const same = context(); same.botId = "0"; await route(same);
    const other = context(); other.botId = "other"; await route(other);
    expect(same.json).toHaveBeenCalledWith(same.res, 429, expect.anything());
    expect(other.json).toHaveBeenCalledWith(other.res, 429, expect.anything());
    expect(search).toHaveBeenCalledTimes(4);
    finish(); await Promise.all(runs);
    await route(other); expect(search).toHaveBeenCalledTimes(5);
  });
  it("limits each bot to six and all bots to thirty attempts per minute, then resets", async () => {
    let time = 1000;
    const search = vi.fn(async () => []);
    const route = createWebSearchRoute(() => ({ braveApiKey: "key" }), search, () => time);
    for (let i = 0; i < 6; i++) await route(context());
    const refused = context(); await route(refused);
    expect(refused.json).toHaveBeenCalledWith(refused.res, 429, expect.anything());
    for (let i = 0; i < 24; i++) { const ctx = context(); ctx.botId = String(i); await route(ctx); }
    const global = context(); global.botId = "extra"; await route(global);
    expect(global.json).toHaveBeenCalledWith(global.res, 429, expect.anything());
    expect(search).toHaveBeenCalledTimes(30);
    time += 60_000; await route(refused); expect(search).toHaveBeenCalledTimes(31);
  });
  it("keeps active slots across the rate-window reset", async () => {
    let time = 1000; let finish!: () => void;
    const search = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return []; });
    const route = createWebSearchRoute(() => ({ braveApiKey: "key" }), search, () => time);
    const pending = route(context()); await Promise.resolve(); await Promise.resolve();
    time += 60_000; const ctx = context(); await route(ctx);
    expect(search).toHaveBeenCalledTimes(1); expect(ctx.json).toHaveBeenCalledWith(ctx.res, 429, expect.anything());
    finish(); await pending;
  });
});
