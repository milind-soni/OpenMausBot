import { describe, expect, it, vi } from "vitest";
import { X_MESSAGES, XResearchError, type XResearchClient } from "../x-research.ts";
import type { ResearchClient } from "../research.ts";
import type { ServiceCredential } from "../included-services.ts";
import { PASS } from "./table.ts";
import { createXResearchInternalRoutes, type XInternalContext } from "./x-research.ts";

function fakeClient(overrides: Partial<XResearchClient> = {}): XResearchClient {
  return {
    search: vi.fn(async () => ({ posts: [], more: false })),
    userPosts: vi.fn(async () => ({ posts: [], more: false })),
    post: vi.fn(async () => ({ post: { id: "1", url: "https://x.com/i/status/1", author: "@a", text: "hi" } })),
    profile: vi.fn(async () => ({ handle: "@a", url: "https://x.com/a" })),
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
  const included: ServiceCredential = { token: "omb_xd_t", api: "https://cloud.example.test/api/cloud/services/x", included: true };
  const enabled = (client = fakeClient(), credential: () => ServiceCredential | null = () => included) =>
    ({ client, handler: createXResearchInternalRoutes({ credential, botEnabled: (id) => id === "bot-1", client: () => client }) });

  it("passes requests that are not its own", async () => {
    const { handler } = enabled();
    expect((await callInternal(handler, { path: "/api/internal/voice-note" })).out).toBe(PASS);
    expect((await callInternal(handler, { path: "/api/internal/x/unknown" })).out).toBe(PASS);
    expect((await callInternal(handler, { method: "GET" })).out).toBe(PASS);
  });

  it("refuses without a Cloud plan's credential, and refuses a bot that is not switched on, before any spend", async () => {
    const client = fakeClient();
    const noToken = createXResearchInternalRoutes({ credential: () => null, botEnabled: () => true, client: () => client });
    expect(await callInternal(noToken, { body: { query: "maus" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.noKey } });
    const { handler } = enabled(client);
    expect(await callInternal(handler, { botId: "bot-2", body: { query: "maus" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("reads the credential on every call, so a plan that lapsed (the desktop cleared it) stops the next one", async () => {
    let credential: ServiceCredential | null = included;
    const { handler } = enabled(fakeClient(), () => credential);
    expect((await callInternal(handler, { body: { query: "maus" } })).status).toBe(200);
    credential = null;
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

  it("tells a Cloud home's bot the relay refused the Cloud's token, never to sign in again", async () => {
    const client = fakeClient({ search: vi.fn(async () => { throw new XResearchError("bad_key", X_MESSAGES.badKey); }) });
    const home = createXResearchInternalRoutes({ credential: () => included, botEnabled: () => true, client: () => client, cloudHome: true });
    const answer = await callInternal(home, { body: { query: "maus" } });
    expect(answer).toMatchObject({ status: 502, body: { error: X_MESSAGES.homeBadKey, code: "bad_key" } });
    expect(answer.body.error).not.toMatch(/sign in again/i);
    const other = createXResearchInternalRoutes({ credential: () => included, botEnabled: () => true, client: () => fakeClient({ search: vi.fn(async () => { throw new XResearchError("rate_limited", X_MESSAGES.rateLimited); }) }), cloudHome: true });
    expect(await callInternal(other, { body: { query: "maus" } })).toMatchObject({ status: 502, body: { error: X_MESSAGES.rateLimited } });
  });

  it("keeps the Cloud home sentence for the plan's token only: a refused own treg key says to check the key", async () => {
    const ownKey: ServiceCredential = { token: "treg_own", api: "https://treg.to", included: false };
    const client = fakeClient({ search: vi.fn(async () => { throw new XResearchError("bad_key", X_MESSAGES.ownBadKey); }) });
    const home = createXResearchInternalRoutes({ credential: () => ownKey, botEnabled: () => true, client: () => client, cloudHome: true });
    expect(await callInternal(home, { body: { query: "maus" } })).toMatchObject({ status: 502, body: { error: X_MESSAGES.ownBadKey } });
  });
});

describe("research internal routes", () => {
  const ownKey: ServiceCredential = { token: "treg_own", api: "https://treg.to", included: false };
  const fakeResearch = (overrides: Partial<ResearchClient> = {}): ResearchClient => ({
    search: vi.fn(async () => ({ query: "q", results: [] })),
    endpoint: vi.fn(async () => ({ endpoint: { id: "apollo.people.search" } })),
    call: vi.fn(async () => ({ result: { people: [] }, costUsd: 0.002, callId: "c1" })),
    ...overrides,
  });
  const routes = (research = fakeResearch(), credential: () => ServiceCredential | null = () => ownKey, botEnabled = (id: string) => id === "bot-1") =>
    ({ research, handler: createXResearchInternalRoutes({ credential, botEnabled, research: () => research }) });

  it("runs search, endpoint and call on the same credential and switch as the X tools, and shows the call's cost", async () => {
    const { research, handler } = routes();
    expect(await callInternal(handler, { path: "/api/internal/research/search", body: { job: "work emails" } })).toMatchObject({ status: 200, body: { query: "q" } });
    expect(research.search).toHaveBeenCalledWith({ job: "work emails", limit: 5 });
    await callInternal(handler, { path: "/api/internal/research/endpoint", body: { id: "apollo.people.search" } });
    expect(research.endpoint).toHaveBeenCalledWith("apollo.people.search");
    expect(await callInternal(handler, { path: "/api/internal/research/call", body: { id: "apollo.people.search", params: { q: "maus" } } }))
      .toMatchObject({ status: 200, body: { result: { people: [] }, cost: "$0.0020", callId: "c1" } });
    expect(research.call).toHaveBeenCalledWith({ id: "apollo.people.search", params: { q: "maus" } });
  });

  it("refuses without a credential or with the bot switched off, before any spend, and refuses ids that are paths or URLs", async () => {
    const research = fakeResearch();
    expect(await callInternal(routes(research, () => null).handler, { path: "/api/internal/research/call", body: { id: "apollo.people.search" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.noKey } });
    expect(await callInternal(routes(research).handler, { botId: "bot-2", path: "/api/internal/research/call", body: { id: "apollo.people.search" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
    for (const id of ["stripe/v1/charges", "https://api.example.com/x", "../catalog", ""]) {
      expect((await callInternal(routes(research).handler, { path: "/api/internal/research/call", body: { id } })).status, id).toBe(400);
    }
    expect(research.call).not.toHaveBeenCalled();
    expect((await callInternal(routes(research).handler, { path: "/api/internal/research/unknown", body: {} })).out).toBe(PASS);
  });
});

