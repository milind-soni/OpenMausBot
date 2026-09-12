import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderGateway } from "../server/gateway.ts";
import { PortalStore, digest } from "../server/store.ts";
import { launchFixture } from "./fixture.ts";

describe("membership mutation authority boundaries", () => {
  let fixture: Awaited<ReturnType<typeof launchFixture>>;
  let operator: ReturnType<typeof fixture.client>;
  beforeEach(async () => {
    fixture = await launchFixture(); operator = fixture.client();
    await operator.login("operator@example.test");
    expect((await operator.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha" })).status).toBe(201);
  });
  afterEach(async () => { fixture.portal.gateway.close(); await fixture.close(); });
  async function invite(email: string, role = "member") {
    const result = await operator.request("/api/workspaces/alpha/invitations", "POST", { email, role });
    const id = (await result.json()).invitation.id;
    const client = fixture.client(); await client.login(email);
    return { id, client };
  }
  async function member(email = "member@example.test", role = "member") {
    const { id, client } = await invite(email, role);
    expect((await client.request(`/api/invitations/${id}/accept`, "POST", {})).status).toBe(200);
    return client;
  }
  it("does not publish a pending or failed promotion; commits only after runtime acknowledgement", async () => {
    const person = await member();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => entered = resolve);
    const blocked = new Promise<void>((resolve) => release = resolve);
    fixture.behavior.beforeFleet = async (_method, path) => { if (path.endsWith("/users")) { entered(); await blocked; } };
    const promoting = operator.request("/api/workspaces/alpha/members", "POST", { email: "member@example.test", role: "admin" });
    await waiting;
    expect(fixture.store.member("alpha", "member@example.test")?.role).toBe("member");
    expect((await person.request("/api/workspaces/alpha/people")).status).toBe(403);
    fixture.faults.fleet = true; release();
    expect((await promoting).status).toBe(502);
    expect(fixture.store.member("alpha", "member@example.test")?.role).toBe("member");
    expect((await person.request("/api/workspaces/alpha/people")).status).toBe(403);
    fixture.faults.fleet = false; fixture.behavior.beforeFleet = undefined;
    expect((await operator.request("/api/workspaces/alpha/members", "POST", { email: "member@example.test", role: "admin" })).status).toBe(200);
    expect((await person.request("/api/workspaces/alpha/people")).status).toBe(200);
  });
  it("keeps an invitation unaccepted if runtime synchronization fails", async () => {
    const { id, client } = await invite("member@example.test", "admin");
    fixture.faults.fleet = true;
    expect((await client.request(`/api/invitations/${id}/accept`, "POST", {})).status).toBe(502);
    expect(fixture.store.member("alpha", "member@example.test")).toBeUndefined();
    expect(fixture.store.invitation(id)?.status).toBe("pending");
    expect((await client.request("/api/workspaces/alpha/people")).status).toBe(403);
  });
  it("validates role changes before revoking grants, but removal remains effective when fleet sync fails", async () => {
    await member();
    const verifier = randomBytes(32).toString("base64url");
    const session = fixture.db.prepare('SELECT s.id FROM "session" s JOIN "user" u ON u.id = s.userId WHERE u.email = ?').get("member@example.test") as { id: string };
    const code = fixture.store.handoff("alpha", "member@example.test", digest(verifier), session.id);
    const issued = fixture.store.consume(code, "alpha", verifier)!;
    expect((await operator.request("/api/workspaces/alpha/members", "POST", { email: "member@example.test" })).status).toBe(400);
    expect(fixture.store.grant(issued.grant, "alpha")).not.toBeNull();
    fixture.faults.fleet = true;
    expect((await operator.request("/api/workspaces/alpha/members", "DELETE", { email: "member@example.test" })).status).toBe(502);
    expect(fixture.store.member("alpha", "member@example.test")).toBeUndefined();
    expect(fixture.store.grant(issued.grant, "alpha")).toBeNull();
  });
  it("retains central demotion even when the fleet is unavailable", async () => {
    const person = await member("member@example.test", "admin");
    await member("other@example.test", "admin");
    fixture.faults.fleet = true;
    expect((await operator.request("/api/workspaces/alpha/members", "POST", { email: "member@example.test", role: "member" })).status).toBe(502);
    expect(fixture.store.member("alpha", "member@example.test")?.role).toBe("member");
    expect((await person.request("/api/workspaces/alpha/people")).status).toBe(403);
  });
  it("aborts a provider stream synchronously before a suspended workspace's fleet request finishes", async () => {
    await operator.request("/api/providers", "POST", { key: "synthetic-secret", models: ["fixture-model"] });
    fixture.portal.gateway.assign("alpha", ["fixture-model"]);
    const seed = fixture.calls.find((call) => call.method === "POST" && call.path === "/workspaces")!.body as { anthropicKey: string };
    const response = await fixture.portal.gateway.handle(new Request(`${fixture.url}/gateway`, { method: "POST", headers: { "x-api-key": seed.anthropicKey }, body: JSON.stringify({ model: "fixture-model" }) }), "alpha", "/v1/messages");
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => entered = resolve);
    const blocked = new Promise<void>((resolve) => release = resolve);
    fixture.behavior.beforeFleet = async (_method, path) => { if (path.endsWith("/suspend")) { entered(); await blocked; } };
    const suspending = operator.request("/api/workspaces/alpha/suspend", "POST", {});
    await waiting;
    expect(fixture.upstream[0].signal.aborted).toBe(true);
    await expect(response.text()).rejects.toThrow("access ended");
    fixture.faults.fleet = true; release();
    expect((await suspending).status).toBe(502);
    expect(fixture.store.workspace("alpha")?.status).toBe("suspended");
  });
});

describe("managed provider in-flight revocation", () => {
  let db: DatabaseSync;
  let store: PortalStore;
  let gateway: ProviderGateway;
  let keys: Record<string, string>;
  let licensed: boolean;
  let controllers: ReadableStreamDefaultController<Uint8Array>[];
  const upstream = vi.fn<typeof fetch>();
  const cancelled = vi.fn();
  const message = (workspace: string, model = "fixture-model", signal?: AbortSignal) => new Request("https://portal.example.test/gateway", {
    method: "POST", headers: { "x-api-key": keys[workspace] }, body: JSON.stringify({ model, stream: true }), signal,
  });
  beforeEach(() => {
    db = new DatabaseSync(":memory:"); store = new PortalStore(db); keys = {}; controllers = []; licensed = true;
    cancelled.mockReset();
    upstream.mockReset().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); }, cancel: cancelled }), { headers: { "content-type": "text/event-stream" } }));
    gateway = new ProviderGateway(store, "synthetic-key", upstream, () => licensed);
    gateway.save({ key: "synthetic-provider-secret", models: ["fixture-model"] });
    for (const slug of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      db.prepare("INSERT INTO portal_workspace VALUES (?,?,?,?,?,NULL)").run(slug, slug, `${slug}.example.test`, "running", Date.now());
      keys[slug] = gateway.issue(slug, ["fixture-model"]);
    }
  });
  afterEach(() => { gateway.close(); db.close(); vi.useRealTimers(); });
  it.each(["null", "[]", "false", "42", '"text"', "{"])("rejects a malformed or non-object JSON body: %s", async (body) => {
    const request = new Request("https://portal.example.test/gateway", { method: "POST", headers: { "x-api-key": keys.alpha }, body });
    expect((await gateway.handle(request, "alpha", "/v1/messages")).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["tenant models", "workspace state", "provider models", "license"])("aborts active streams when %s is revoked", async (change) => {
    const response = await gateway.handle(message("alpha"), "alpha", "/v1/messages");
    const reading = response.text(); const rejected = expect(reading).rejects.toThrow("access ended");
    if (change === "tenant models") gateway.assign("alpha", []);
    if (change === "provider models") gateway.save({ models: [] });
    if (change === "workspace state") { db.prepare("UPDATE portal_workspace SET status = 'suspended' WHERE slug = 'alpha'").run(); gateway.revalidate(); }
    if (change === "license") { licensed = false; gateway.revalidate(); }
    await rejected;
    expect(upstream.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("does not close another workspace's stream when one workspace loses model access", async () => {
    const a = await gateway.handle(message("alpha"), "alpha", "/v1/messages");
    const b = await gateway.handle(message("beta"), "beta", "/v1/messages");
    gateway.assign("alpha", []);
    await expect(a.text()).rejects.toThrow();
    expect(upstream.mock.calls[1][1]!.signal!.aborted).toBe(false);
    controllers[1].enqueue(new TextEncoder().encode("beta-only")); controllers[1].close();
    expect(await b.text()).toBe("beta-only");
  });
  it("rechecks authority after request-body parsing, before any upstream call", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const request = new Request("https://portal.example.test/gateway", { method: "POST", headers: { "x-api-key": keys.alpha }, body: new ReadableStream({ start(value) { body = value; } }), duplex: "half" } as RequestInit);
    const pending = gateway.handle(request, "alpha", "/v1/messages");
    gateway.assign("alpha", []);
    body.enqueue(new TextEncoder().encode(JSON.stringify({ model: "fixture-model" }))); body.close();
    expect((await pending).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects late upstream headers after revocation without publishing a response body or retrying", async () => {
    let finish!: (value: Response) => void;
    upstream.mockImplementationOnce(() => new Promise((resolve) => finish = resolve));
    const pending = gateway.handle(message("alpha"), "alpha", "/v1/messages");
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    gateway.assign("alpha", []);
    finish(new Response(new ReadableStream({ cancel: cancelled })));
    expect((await pending).status).toBe(403);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("caps active requests per workspace and globally, releasing capacity on cancellation", async () => {
    for (const workspace of ["alpha", "beta", "gamma", "delta"]) {
      for (let i = 0; i < 8; i++) expect((await gateway.handle(message(workspace), workspace, "/v1/messages")).status).toBe(200);
      expect((await gateway.handle(message(workspace), workspace, "/v1/messages")).status).toBe(429);
    }
    expect((await gateway.handle(message("epsilon"), "epsilon", "/v1/messages")).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(32);
    gateway.assign("alpha", []);
    expect((await gateway.handle(message("epsilon"), "epsilon", "/v1/messages")).status).toBe(200);
  });
  it("bounds quiet response lifetime and responds to client disconnects", async () => {
    vi.useFakeTimers();
    const response = await gateway.handle(message("alpha"), "alpha", "/v1/messages");
    const rejected = expect(response.text()).rejects.toThrow("access ended");
    await vi.advanceTimersByTimeAsync(300_000); await rejected;
    expect(upstream.mock.calls[0][1]!.signal!.aborted).toBe(true);
    const client = new AbortController();
    const next = await gateway.handle(message("beta", "fixture-model", client.signal), "beta", "/v1/messages");
    const disconnected = expect(next.text()).rejects.toThrow("access ended");
    client.abort(); await disconnected;
    expect(upstream.mock.calls[1][1]!.signal!.aborted).toBe(true);
  });
});
