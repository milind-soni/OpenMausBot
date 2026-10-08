import { describe, expect, it, vi } from "vitest";
import { X_MESSAGES, XResearchError, type XResearchClient } from "../x-research.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createXResearchInternalRoutes, createXResearchKeyTestRoute, type XInternalContext } from "./x-research.ts";

function fakeClient(overrides: Partial<XResearchClient> = {}): XResearchClient {
  return {
    search: vi.fn(async () => ({ posts: [], more: false })),
    userPosts: vi.fn(async () => ({ posts: [], more: false })),
    post: vi.fn(async () => ({ post: { id: "1", url: "https://x.com/i/status/1", author: "@a", text: "hi" } })),
    profile: vi.fn(async () => ({ handle: "@a", url: "https://x.com/a" })),
    accountInfo: vi.fn(async () => ({ balanceUsd: 0.97 })),
    ...overrides,
  };
}

function sink() {
  const sent: { status?: number; body?: any } = {};
  const json = ((_res: unknown, status: number, body: unknown) => {
    sent.status = status;
    sent.body = body;
  }) as XInternalContext["json"];
  const res = { setHeader: vi.fn() } as unknown as XInternalContext["res"];
  return { sent, json, res };
}

async function callInternal(
  handler: ReturnType<typeof createXResearchInternalRoutes>,
  { path = "/api/internal/x/search", method = "POST", body = {} as unknown, botId = "bot-1" } = {},
) {
  const { sent, json, res } = sink();
  const out = await handler({ method, path, res, json, botId, readBody: async () => body });
  return { out, ...sent };
}

describe("X research internal routes", () => {
  const enabled = (client = fakeClient(), token: () => string | undefined = () => "t") =>
    ({ client, handler: createXResearchInternalRoutes({ token, botEnabled: (id) => id === "bot-1", client: () => client }) });

  it("passes requests that are not its own", async () => {
    const { handler } = enabled();
    expect((await callInternal(handler, { path: "/api/internal/voice-note" })).out).toBe(PASS);
    expect((await callInternal(handler, { path: "/api/internal/x/unknown" })).out).toBe(PASS);
    expect((await callInternal(handler, { method: "GET" })).out).toBe(PASS);
  });

  it("refuses without a token, and refuses a bot that is not switched on, before any spend", async () => {
    const client = fakeClient();
    const noToken = createXResearchInternalRoutes({ token: () => undefined, botEnabled: () => true, client: () => client });
    expect(await callInternal(noToken, { body: { query: "maus" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.noKey } });
    const { handler } = enabled(client);
    expect(await callInternal(handler, { botId: "bot-2", body: { query: "maus" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("reads the token on every call, so clearing it stops the next one", async () => {
    let token: string | undefined = "t";
    const { handler } = enabled(fakeClient(), () => token);
    expect((await callInternal(handler, { body: { query: "maus" } })).status).toBe(200);
    token = undefined;
    expect((await callInternal(handler, { body: { query: "maus" } })).status).toBe(403);
  });

  it("validates input with a reason a retry can use", async () => {
    const { handler } = enabled();
    for (const [path, body] of [
      ["/api/internal/x/search", {}],
      ["/api/internal/x/search", { query: "maus", sinceId: "abc" }],
      ["/api/internal/x/search", { query: "maus", limit: 51 }],
      ["/api/internal/x/user-posts", { handle: "not a handle!" }],
      ["/api/internal/x/post", { post: "https://example.com/1" }],
      ["/api/internal/x/profile", { handle: "" }],
    ] as const) {
      const result = await callInternal(handler, { path, body });
      expect(result.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(typeof result.body.error).toBe("string");
    }
  });

  it("hands the client normalized input with defaults filled in", async () => {
    const { client, handler } = enabled();
    await callInternal(handler, { body: { query: "maus" } });
    expect(client.search).toHaveBeenCalledWith({ query: "maus", sort: "latest", limit: 20 });
    await callInternal(handler, { path: "/api/internal/x/user-posts", body: { handle: "@maus", sinceId: "99", limit: 5 } });
    expect(client.userPosts).toHaveBeenCalledWith({ handle: "maus", limit: 5, includeReplies: false, sinceId: "99" });
    await callInternal(handler, { path: "/api/internal/x/post", body: { post: "https://x.com/maus/status/42", replies: true } });
    expect(client.post).toHaveBeenCalledWith({ id: "42", handle: "maus", replies: true });
    await callInternal(handler, { path: "/api/internal/x/profile", body: { handle: "https://x.com/maus" } });
    expect(client.profile).toHaveBeenCalledWith("maus");
  });

  it("returns the client's result as the body", async () => {
    const posts = { posts: [{ id: "5", url: "https://x.com/a/status/5", author: "@a", text: "t" }], newestId: "5", more: false };
    const { handler } = enabled(fakeClient({ search: vi.fn(async () => posts) }));
    expect(await callInternal(handler, { body: { query: "maus" } })).toMatchObject({ status: 200, body: posts });
  });

  it("turns provider failures into 404 or 502 with the plain sentence, never 401", async () => {
    const gone = enabled(fakeClient({ post: vi.fn(async () => { throw new XResearchError("not_found", X_MESSAGES.postNotFound); }) }));
    expect(await callInternal(gone.handler, { path: "/api/internal/x/post", body: { post: "42" } }))
      .toMatchObject({ status: 404, body: { error: X_MESSAGES.postNotFound, code: "not_found" } });
    const badToken = enabled(fakeClient({ search: vi.fn(async () => { throw new XResearchError("bad_key", X_MESSAGES.badKey); }) }));
    expect(await callInternal(badToken.handler, { body: { query: "maus" } }))
      .toMatchObject({ status: 502, body: { error: X_MESSAGES.badKey, code: "bad_key" } });
  });
});

describe("X research token test route", () => {
  async function callTest(handler: ReturnType<typeof createXResearchKeyTestRoute>, path = "/api/x-research/test", method = "POST") {
    const { sent, json, res } = sink();
    const out = await handler({ method, path, res, json } as unknown as RouteContext);
    return { out, ...sent };
  }

  it("passes other requests", async () => {
    const handler = createXResearchKeyTestRoute({ token: () => "t", client: () => fakeClient() });
    expect((await callTest(handler, "/api/keys/test")).out).toBe(PASS);
    expect((await callTest(handler, "/api/x-research/test", "GET")).out).toBe(PASS);
  });

  it("asks for a token first", async () => {
    const handler = createXResearchKeyTestRoute({ token: () => "  ", client: () => fakeClient() });
    expect(await callTest(handler)).toMatchObject({ status: 400 });
  });

  it("reports the balance in dollars", async () => {
    const handler = createXResearchKeyTestRoute({ token: () => "t", client: () => fakeClient() });
    expect(await callTest(handler)).toMatchObject({ status: 200, body: { ok: true, dollars: 0.97 } });
  });

  it("names a rejected token", async () => {
    const client = fakeClient({ accountInfo: vi.fn(async () => { throw new XResearchError("bad_key", X_MESSAGES.badKey); }) });
    const handler = createXResearchKeyTestRoute({ token: () => "t", client: () => client });
    expect(await callTest(handler)).toMatchObject({ status: 200, body: { ok: false, reason: "rejected", message: X_MESSAGES.badKey } });
  });
});
