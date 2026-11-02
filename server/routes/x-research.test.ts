import { describe, expect, it, vi } from "vitest";
import { createXClient, X_MESSAGES, XResearchError, type XResearchClient } from "../x-research.ts";
import { createResearchClient, type ResearchClient } from "../research.ts";
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
  { path = "/api/internal/x/search", method = "POST", body = {} as unknown, botId = "bot-1", readBody = async () => body } = {},
) {
  const { sent, json, res } = sink();
  const out = await handler({ method, path, res, json, botId, readBody });
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe.each([false, true])("live research access (included: %s)", (included) => {
  const credential: ServiceCredential = { token: "fixture", api: "https://synthetic.invalid", included };
  const endpoint = { id: "fixture.lookup", method: "POST" };
  const page = { output: { data: { items: [{ id: "50", text: "Fixture", authorUsername: "fixture" }], nextCursor: "page2" } } };

  function routes(fetcher: typeof fetch) {
    let enabled = true;
    return {
      revoke: () => { enabled = false; },
      handler: createXResearchInternalRoutes({
        credential: () => credential, botEnabled: () => enabled,
        client: (c, assertAllowed) => createXClient(c, { fetcher, assertAllowed }),
        research: (c, assertAllowed) => createResearchClient(c, { fetcher, assertAllowed, retryDelayMs: 0 }),
      }),
    };
  }

  it.each([
    { action: "x/search", body: { query: "fixture" } },
    { action: "x/user-posts", body: { handle: "fixture" } },
    { action: "x/post", body: { post: "50", replies: true } },
    { action: "x/profile", body: { handle: "fixture" } },
    { action: "research/search", body: { job: "fixture" } },
    { action: "research/endpoint", body: { id: "fixture.lookup" } },
    { action: "research/call", body: { id: "fixture.lookup" } },
  ])("refuses $action revoked during the body read without dispatch", async ({ action, body }) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ endpoint }));
    const h = routes(fetcher);
    const reading = deferred(), release = deferred();
    const input = { path: `/api/internal/${action}`, body };
    const pending = callInternal(h.handler, { ...input, readBody: async () => {
      reading.resolve();
      await release.promise;
      return body;
    } });
    await reading.promise;
    h.revoke();
    release.resolve();
    expect(await pending).toEqual(await callInternal(h.handler, input));
    expect(await callInternal(h.handler, input)).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["fallback", "page", "replies", "catalog", "retry", "in_progress"].filter((kind) => kind !== "catalog" || !included))(
    "refuses a revoked %s continuation without another dispatch", async (kind) => {
      const sent = deferred(), release = deferred();
      const calls: string[] = [];
      const isX = ["fallback", "page", "replies"].includes(kind);
      const fetcher: typeof fetch = async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (!included && !isX && kind !== "catalog" && calls.length === 1) return Response.json({ endpoint });
        const heldCall = !included && !isX && kind !== "catalog" ? 2 : 1;
        if (calls.length === heldCall) {
          sent.resolve();
          await release.promise;
          if (kind === "fallback") return Response.json({}, { status: 500 });
          if (kind === "page") return Response.json(page);
          if (kind === "replies") return Response.json({ output: { data: { id: "50", text: "Fixture", authorUsername: "fixture" } } });
          if (kind === "catalog") return Response.json({ endpoint });
          if (kind === "in_progress") return Response.json({ detail: "in progress", message: "in progress" }, { status: 409 });
          throw new Error("Fixture lost response");
        }
        return Response.json({ result: "unexpected continuation", output: { data: { items: [] } } });
      };
      const h = routes(fetcher);
      const input = kind === "replies" ? { path: "/api/internal/x/post", body: { post: "50", replies: true } }
        : isX ? { path: "/api/internal/x/search", body: { query: "fixture" } }
          : { path: "/api/internal/research/call", body: { id: "fixture.lookup" } };
      const pending = callInternal(h.handler, input);
      await sent.promise;
      const before = [...calls];
      h.revoke();
      release.resolve();
      expect(await pending).toEqual(await callInternal(h.handler, input));
      expect(await callInternal(h.handler, input)).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
      expect(calls).toEqual(before);
    },
  );

  it.each(["x", "research"].flatMap((client) => [200, 422].map((status) => ({ client, status }))))(
    "preserves the completed $client $status outcome after revocation", async ({ client, status }) => {
      const sent = deferred(), release = deferred();
      let calls = 0;
      const h = routes(async (url) => {
        calls++;
        if (String(url).includes("/catalog/endpoints/")) return Response.json({ endpoint });
        sent.resolve();
        await release.promise;
        return Response.json(status === 422 ? { message: "Fixture rejection" } : client === "x" ? { output: { data: { items: [] } } } : { saved: true }, { status });
      });
      const input = client === "x" ? { path: "/api/internal/x/search", body: { query: "fixture" } }
        : { path: "/api/internal/research/call", body: { id: "fixture.lookup" } };
      const pending = callInternal(h.handler, input);
      await sent.promise;
      h.revoke();
      release.resolve();
      const result = await pending;
      expect(result.status).toBe(status === 200 ? 200 : 400);
      if (status === 200) expect(result.body).toEqual(client === "x" ? { posts: [], more: false } : { result: { saved: true } });
      else expect(result.body).toHaveProperty("code", "bad_input");
      expect(await callInternal(h.handler, input)).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
      expect(calls).toBe(client === "research" && !included ? 2 : 1);
    },
  );
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


describe("research credential replaced mid-operation", () => {
  const own: ServiceCredential = { token: "treg_own_fixture", api: "https://synthetic-own.invalid", included: false };
  const plan: ServiceCredential = { token: "omb_xd_plan_fixture", api: "https://synthetic-plan.invalid", included: true };
  const endpoint = { id: "fixture.lookup", method: "POST" };
  const page = { output: { data: { items: [{ id: "50", text: "Fixture", authorUsername: "fixture" }], nextCursor: "page2" } } };

  function routes(fetcher: typeof fetch) {
    let current = own;
    return {
      removeOwnKey: () => { current = plan; },
      handler: createXResearchInternalRoutes({
        credential: () => current, botEnabled: () => true,
        client: (c, assertAllowed) => createXClient(c, { fetcher, assertAllowed }),
        research: (c, assertAllowed) => createResearchClient(c, { fetcher, assertAllowed, retryDelayMs: 0 }),
      }),
    };
  }

  const usedOwnKey = (init: RequestInit | undefined) => JSON.stringify(init?.headers ?? {}).includes(own.token);

  it("refuses when the own key is removed during the body read, and sends nothing with it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ endpoint }));
    const h = routes(fetcher);
    const reading = deferred(), release = deferred();
    const pending = callInternal(h.handler, { path: "/api/internal/research/call", body: { id: "fixture.lookup" }, readBody: async () => {
      reading.resolve();
      await release.promise;
      return { id: "fixture.lookup" };
    } });
    await reading.promise;
    h.removeOwnKey();
    release.resolve();
    expect(await pending).toMatchObject({ status: 403, body: { error: X_MESSAGES.keyChanged } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["catalog", "page"])("stops a %s continuation once the own key is removed, without another request on it", async (kind) => {
    const sent = deferred(), release = deferred();
    const after: Array<RequestInit | undefined> = [];
    let removed = false;
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      if (removed) after.push(init);
      if (calls === 1) {
        sent.resolve();
        await release.promise;
        return kind === "catalog" ? Response.json({ endpoint }) : Response.json(page);
      }
      return Response.json({ result: "unexpected continuation", output: { data: { items: [] } } });
    };
    const h = routes(fetcher);
    const input = kind === "catalog" ? { path: "/api/internal/research/call", body: { id: "fixture.lookup" } }
      : { path: "/api/internal/x/search", body: { query: "fixture" } };
    const pending = callInternal(h.handler, input);
    await sent.promise;
    h.removeOwnKey();
    removed = true;
    release.resolve();
    expect(await pending).toMatchObject({ status: 403, body: { error: X_MESSAGES.keyChanged } });
    expect(after.filter(usedOwnKey)).toEqual([]);
    expect(calls).toBe(1);
  });
});
