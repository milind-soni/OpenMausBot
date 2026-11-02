// A bot's Sign in card for an MCP server, end to end against a stand-in OAuth provider: the bot's mcp_server sign_in
// posts the card, the card's routes start the provider's sign-in, the provider's callback settles the card and resumes
// the bot, and the next turn mounts the server with the new token.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WireMessage as Message } from "../shared/wire.ts";
import type { AppConfig } from "./config.ts";
import type { McpServerSpec } from "./contracts.ts";
import { createMcpSignInCards, isCardOwnerLive } from "./host/mcp-sign-in-cards.ts";
import { resumableCards } from "./host/resumable-cards.ts";
import { createTeamConnectionsHost } from "./host/team-connections-host.ts";
import { McpOAuthManager, type McpSignInPhase } from "./mcp-oauth.ts";
import { personKey } from "./person-key.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createInternalMcpRoutes, type InternalMcpDeps } from "./routes/internal-mcp.ts";
import type { RouteContext } from "./routes/table.ts";
import type { Scope, SessionRecord } from "./sessions.ts";
import { startFakePostiz, type FakePostiz } from "./testing/fake-postiz.ts";

const SIGN_IN_PAGE = "https://postiz.example";
const OLIVE = personKey({ id: "", email: "olive@acme.test" });
const ADA = personKey({ id: "", email: "ada@acme.test" });
const CLEO = personKey({ id: "", email: "cleo@acme.test" });
/** Olive owns the team; Ada and Cleo are Users. */
const ROSTER = [
  { person: OLIVE, email: "olive@acme.test", role: "owner" as const },
  { person: ADA, email: "ada@acme.test", role: "member" as const },
  { person: CLEO, email: "cleo@acme.test", role: "member" as const },
];
/** Ada's private chat, where her turns act for her, and the bot's main chat, where Olive's do. */
const AUDIENCES: Record<string, string> = { "ada-chat": `member:${ADA}` };
const REQUESTER: Record<string, string> = { "ada-chat": ADA, "main-chat": OLIVE };
const DESKTOP: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const ON_THE_MAC = { host: "127.0.0.1:8799" };
const NOT_SIGNED_IN = "The person didn't sign in. The server stays on but signed out.";

const session = (email: string, scopes: Scope[] = ["client"]): RequestAuth =>
  ({ kind: "session", session: { id: `session-${email}`, email, scopes } as unknown as SessionRecord, via: "bearer", scopes });

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function setup(options: { team?: boolean; origins?: string[]; lifetimeMs?: number } = {}) {
  const provider: FakePostiz = await startFakePostiz({ signInPage: SIGN_IN_PAGE });
  const dataDir = mkdtempSync(join(tmpdir(), "omb-mcp-sign-in-card-"));
  const url = `${provider.url}/mcp-oauth-dynamic`;
  const cfg = { mcpServers: { linear: { type: "http", url, headers: {}, enabled: true } } } as unknown as AppConfig;

  const threads = new Map<string, Message[]>();
  let made = 0;
  const store = {
    messagesFor: (threadId: string): Message[] => threads.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">): Message => {
      const row = { ...message, id: `msg-${++made}`, at: Date.now() } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), row]);
      return row;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>): Message | null => {
      const rows = threads.get(threadId) ?? [];
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index]!, ...patch };
      return rows[index]!;
    },
  };

  /** What the parked turn heard; `parked` false: the turn hasn't parked on its card yet, so nothing can answer it. */
  const answers: Array<{ messageId: string; text: string }> = [];
  const turn = { parked: true };
  const isOwnerLive = (owner: string) => owner === "loopback" || isCardOwnerLive(store, owner);
  const onSettled = (name: string, phase: McpSignInPhase, owner: string) => cards.settled(name, phase, owner);
  const mcpOAuth = new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json"), isOwnerLive, onSettled, ...(options.lifetimeMs ? { lifetimeMs: options.lifetimeMs } : {}) });
  const team = createTeamConnectionsHost({
    team: options.team ? { id: "team-acme-1", name: "Acme" } : null,
    dataDir, cfg: () => cfg, adminOrigin: null, harnessUrl: "http://127.0.0.1:1",
    audienceOf: (threadId) => (AUDIENCES[threadId] ?? "team") as never,
    requester: (threadId) => REQUESTER[threadId] ?? null,
    roster: () => ROSTER,
    mint: () => "capability",
    mcpOAuth,
    botMcp: () => Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).map(([name, raw]) => {
      const server = raw as { url: string; headers: Record<string, string> };
      return [name, { type: "http", url: server.url, headers: server.headers } as McpServerSpec];
    })),
    isOwnerLive, onSettled,
    brokerUrl: () => null,
    composio: { configured: () => false } as never,
  });
  const cards = createMcpSignInCards({
    store, cfg: () => cfg, mcpOAuth,
    personal: () => team.personMcp(),
    turnPerson: (threadId) => team.turnPerson(threadId),
    oauthFor: (person) => team.people.oauth(person),
    personName: (person) => team.nameOf(person),
    publicOrigins: () => options.origins ?? [],
    language: () => undefined,
    answer: (_threadId, messageId, text) => {
      if (!turn.parked) return false;
      answers.push({ messageId, text });
      return true;
    },
    threadVisible: () => true,
    changed: () => {},
  });

  /** Kiwi's mcp_server sign_in, as its turn in this chat calls it. */
  async function signIn(threadId = "main-chat", name = "linear") {
    const deps = {
      readBody: async () => ({ action: "sign_in", name }),
      sender: { id: "kiwi" }, threadId,
      fullAccess: () => true, guestDriven: () => false,
      teamAdmin: () => team.actsForAdmin(threadId),
      canUse: () => true, cfg: () => cfg,
      personal: () => team.personMcp(),
      authState: (server: string, at: string) => mcpOAuth.authState(server, at),
      activity: () => {}, language: () => undefined,
      requestSignIn: (server: string, stored: Parameters<InternalMcpDeps["requestSignIn"]>[1]) =>
        cards.request({ bot: { name: "Kiwi" }, threadId }, server, stored),
    } as unknown as InternalMcpDeps;
    const json = vi.fn();
    const res = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse;
    await createInternalMcpRoutes(deps)({
      req: {} as IncomingMessage, res, path: "/api/internal/mcp-servers", method: "POST",
      url: new URL("http://fixture.invalid/api/internal/mcp-servers"), auth: DESKTOP, readBody: vi.fn(), json,
    } as RouteContext);
    const [, status, body] = json.mock.calls[0]!;
    return { status: status as number, body: body as { text?: string; error?: string }, card: store.messagesFor(threadId).at(-1)! };
  }

  const current = (card: Message, threadId = "main-chat") => store.messagesFor(threadId).find((row) => row.id === card.id)!;
  const route = (action: string, card: Message, auth: RequestAuth = DESKTOP, headers: Record<string, string> = ON_THE_MAC, threadId = "main-chat") =>
    cards.route(action, action === "status" ? "GET" : "POST", { auth, req: { headers } as unknown as IncomingMessage, threadId, message: current(card, threadId) });
  const authorize = (card: Message, auth?: RequestAuth, headers?: Record<string, string>, threadId?: string) => route("authorize", card, auth, headers, threadId);

  /** The person's browser on the provider's sign-in page: the provider approves at once and sends it back. */
  async function approve(link: string): Promise<number> {
    const page = new URL(link);
    expect(page.origin).toBe(SIGN_IN_PAGE);
    const sent = await fetch(`${provider.url}${page.pathname}${page.search}`, { redirect: "manual" });
    const back = new URL(sent.headers.get("location")!);
    if (back.protocol === "http:") return (await fetch(back)).status;
    return (await team.mcpCallback(back.host, back.search)).status;
  }

  const fixture = {
    provider, url, cfg, store, mcpOAuth, team, cards, answers, turn, signIn, current, route, authorize, approve,
    close: async () => {
      mcpOAuth.dispose();
      for (const manager of team.people.liveManagers()) manager.dispose();
      await provider.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

describe("the Sign in card", () => {
  it("sign_in posts a connector card with source mcp and no URL in text or card", async () => {
    const f = await setup();
    const posted = await f.signIn();
    expect(posted.status).toBe(202);
    expect(posted.body.text).toBe("A Sign in card for linear is now visible to the person. End this turn and wait; OpenMausBot resumes you when they finish.");
    expect(posted.card).toMatchObject({
      role: "bot", kind: "connector",
      text: "Linear's MCP server needs a sign-in. Open this conversation in OpenMausBot to sign in.",
      connector: {
        source: "mcp", slug: "linear", label: "Linear", status: "required",
        description: `Kiwi added Linear's MCP server (${new URL(f.url).host}). Sign in so Kiwi can use it.`,
      },
    });
    expect(posted.card.connector!.resumeKey).toMatch(/^[\w-]{8,100}$/);

    const link = (await f.authorize(posted.card)).body.url as string;
    expect(link).toContain("state=");
    const stored = JSON.stringify(f.store.messagesFor("main-chat"));
    expect(stored).not.toContain(link);
    expect(stored).not.toContain(SIGN_IN_PAGE);
    expect(stored).not.toContain(new URL(link).searchParams.get("state"));
  });

  it("authorize on the card returns an https url and status moves to authorizing", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const authorized = await f.authorize(card);
    expect(authorized.status).toBe(200);
    const link = new URL(authorized.body.url as string);
    expect(link.protocol).toBe("https:");
    expect(link.origin + link.pathname).toBe(`${SIGN_IN_PAGE}/oauth/authorize`);
    expect(link.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-oauth\/callback$/);
    expect(f.current(card).connector).toMatchObject({ status: "authorizing" });
    expect(await f.route("status", card)).toEqual({ status: 200, body: { connected: false, pending: true, status: "authorizing" } });
  });

  it("completing the fake provider callback resumes the bot through onSettled without any status poll", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const link = (await f.authorize(card)).body.url as string;
    expect(await f.approve(link)).toBe(200);
    expect(f.mcpOAuth.authState("linear", f.url)).toBe("signed-in");
    expect(f.current(card).connector).toMatchObject({ status: "connected", resumed: true });
    expect(f.answers).toEqual([{ messageId: card.id, text: expect.stringContaining("the person signed in to linear") }]);
  });

  it("a server switched off while its card waited: the bot hears it signed in but the server is off, and to call enable", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const link = (await f.authorize(card)).body.url as string;
    (f.cfg.mcpServers!.linear as { enabled: boolean }).enabled = false;
    expect(await f.approve(link)).toBe(200);
    expect(f.current(card).connector).toMatchObject({ status: "connected", resumed: true });
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]!.text).toContain("the person signed in to linear, but it is off, so its tools aren't yours yet. Call mcp_server with action enable");
    expect(f.answers[0]!.text).not.toContain("Its tools are yours from this turn.");
  });

  it("a server removed while its card waited: the bot hears the server is gone, not that it is off", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const link = (await f.authorize(card)).body.url as string;
    delete f.cfg.mcpServers!.linear;
    expect(await f.approve(link)).toBe(200);
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]!.text).toContain("linear no longer exists.");
    expect(f.answers[0]!.text).not.toContain("it is off");
    expect(f.answers[0]!.text).not.toContain("action enable");
  });

  it("the status poll path also resumes, and a second resume is a no-op", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    f.turn.parked = false;
    expect(await f.approve((await f.authorize(card)).body.url as string)).toBe(200);
    expect(f.current(card).connector).toMatchObject({ status: "connected" });
    expect(f.current(card).connector!.resumed).toBeFalsy();
    expect(f.answers).toEqual([]);

    f.turn.parked = true;
    expect(await f.route("status", card)).toEqual({ status: 200, body: { connected: true, pending: false, status: "connected" } });
    expect(f.current(card).connector!.resumed).toBe(true);
    expect(await f.route("resume", card)).toEqual({ status: 200, body: { resumed: true } });
    expect(await f.route("status", card)).toEqual({ status: 200, body: { connected: true, pending: false, status: "connected" } });
    expect(f.answers).toHaveLength(1);
  });

  it("a second authorize on the same card reuses the waiting flow", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const first = await f.authorize(card);
    const second = await f.authorize(card);
    expect(second).toEqual(first);
    expect(f.provider.counts.register).toBe(1);
  });

  it("a companion phone on a local home gets \"Open this chat on your Mac to sign in to Linear.\"", async () => {
    const phone: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "iphone-1" };
    const local = await setup();
    const { card } = await local.signIn();
    expect(await local.authorize(card, phone)).toEqual({ status: 409, body: { error: "Open this chat on your Mac to sign in to Linear." } });
    expect(local.provider.counts.register).toBe(0);
    expect(local.current(card).connector).toMatchObject({ status: "required" });
    expect(local.current(card).connector!.error).toBeUndefined();

    const reachable = await setup({ origins: ["https://omb.example.com"] });
    const other = (await reachable.signIn()).card;
    const link = new URL((await reachable.authorize(other, phone)).body.url as string);
    expect(link.searchParams.get("redirect_uri")).toBe("https://omb.example.com/mcp-oauth/callback");
  });

  it("a remote session uses the public callback origin", async () => {
    const f = await setup({ origins: ["https://omb.example.com"] });
    const { card } = await f.signIn();
    const away = { host: "omb.example.com", origin: "https://omb.example.com", "x-forwarded-proto": "https" };
    const authorized = await f.authorize(card, session("olive@acme.test", ["admin", "client"]), away);
    const link = new URL(authorized.body.url as string);
    expect(link.searchParams.get("redirect_uri")).toBe("https://omb.example.com/mcp-oauth/callback");
    expect(await f.approve(link.href)).toBe(200);
    expect(f.current(card).connector).toMatchObject({ status: "connected", resumed: true });
  });

  it("a flow that would need paste-back is refused with \"Finish this sign-in in Settings → MCP servers.\"", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const olive = session("olive@acme.test", ["admin", "client"]);
    const noVouchedOrigin = { host: "omb.example.com", "x-forwarded-proto": "https" };
    expect(await f.authorize(card, olive, noVouchedOrigin)).toEqual({ status: 409, body: { error: "Finish this sign-in in Settings → MCP servers." } });
    expect(f.provider.counts.register, "decided before any client is registered").toBe(0);
    expect(f.current(card).connector).toMatchObject({ status: "required" });
    const onTheMac = await f.authorize(card);
    expect(onTheMac.status).toBe(200);
    expect(await f.approve(onTheMac.body.url as string)).toBe(200);

    const preRegistered = await setup({ origins: ["https://omb.example.com"] });
    (preRegistered.cfg.mcpServers!.linear as { oauth?: unknown }).oauth = { clientId: "omb-app" };
    const other = (await preRegistered.signIn()).card;
    const away = { host: "omb.example.com", origin: "https://omb.example.com", "x-forwarded-proto": "https" };
    expect(await preRegistered.authorize(other, olive, away)).toEqual({ status: 409, body: { error: "Finish this sign-in in Settings → MCP servers." } });
    expect(preRegistered.mcpOAuth.authState("linear", preRegistered.url)).toBe("none");
    expect(preRegistered.current(other).connector).toMatchObject({ status: "required" });
  });

  it("a second tap from a browser elsewhere replaces a sign-in that would come back to this computer", async () => {
    const f = await setup({ origins: ["https://omb.example.com"] });
    const { card } = await f.signIn();
    const onTheMac = new URL((await f.authorize(card)).body.url as string);
    expect(onTheMac.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    const away = { host: "omb.example.com", origin: "https://omb.example.com", "x-forwarded-proto": "https" };
    const fromThePhone = new URL((await f.authorize(card, session("olive@acme.test", ["admin", "client"]), away)).body.url as string);
    expect(fromThePhone.searchParams.get("redirect_uri")).toBe("https://omb.example.com/mcp-oauth/callback");
    expect(f.current(card).connector).toMatchObject({ status: "authorizing" });
    expect(await f.approve(onTheMac.href).catch(() => "listener closed")).toBe("listener closed");
    expect(await f.approve(fromThePhone.href)).toBe(200);
    expect(f.current(card).connector).toMatchObject({ status: "connected", resumed: true });
  });

  it("a card left waiting when the server restarted goes back to Sign in when polled", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    expect((await f.authorize(card)).status).toBe(200);
    f.mcpOAuth.dispose();
    expect(f.current(card).connector).toMatchObject({ status: "authorizing" });
    expect(await f.route("status", card)).toEqual({ status: 200, body: { connected: false, pending: false, status: "required" } });
    expect(f.current(card).connector).toMatchObject({ status: "required", error: "The sign-in window closed. Try again." });
  });

  it("a viewer who may not sign in can't settle a removed server's card", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    delete f.cfg.mcpServers!.linear;
    expect(await f.authorize(card, session("ada@acme.test"))).toEqual({ status: 409, body: { error: "Only an admin of this installation can sign in to Linear." } });
    expect(f.current(card).connector).toMatchObject({ status: "required" });
    expect(f.current(card).connector!.resumed).toBeFalsy();
    expect(f.answers).toEqual([]);
  });

  it("Not now before the turn parks still reaches the bot once it parks, and a replaced card waits on nothing", async () => {
    const f = await setup();
    const first = (await f.signIn()).card;
    const { card } = await f.signIn();
    expect(f.current(first).connector).toMatchObject({ dismissed: true, superseded: true });
    f.turn.parked = false;
    expect(await f.route("dismiss", card)).toEqual({ status: 200, body: { dismissed: true } });
    expect(f.answers).toEqual([]);
    expect(f.current(card).connector!.resumed).toBeFalsy();
    const waited = resumableCards({ activePath: (threadId: string) => f.store.messagesFor(threadId) } as never, "main-chat", 0);
    expect(waited.map((entry) => entry.id)).toEqual([card.id]);
    expect(f.cards.parkedAnswer(f.current(card).connector!)).toContain(NOT_SIGNED_IN);
    expect(f.cards.parkedAnswer(f.current(first).connector!)).toBeNull();
  });

  it("a sign-in window that closes sends the card back to Sign in with the reason, and the next tap starts a fresh sign-in", async () => {
    const f = await setup({ lifetimeMs: 150 });
    const { card } = await f.signIn();
    const first = (await f.authorize(card)).body.url as string;
    await expect.poll(() => f.current(card).connector).toMatchObject({ status: "required", error: "The sign-in window closed. Try again." });
    expect(f.answers).toEqual([]);
    const again = await f.authorize(card);
    expect(again.body.url).not.toBe(first);
    expect(f.current(card).connector).toMatchObject({ status: "authorizing" });
    expect(f.current(card).connector!.error).toBeUndefined();
  });

  it("sign_in on a removed server refuses with \"linear no longer exists\"", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    delete f.cfg.mcpServers!.linear;
    const again = await f.signIn();
    expect(again.status).toBe(404);
    expect(again.body.error).toContain("linear no longer exists");
    expect(await f.authorize(card)).toEqual({ status: 409, body: { error: "linear no longer exists." } });
    expect(f.current(card).connector).toMatchObject({ status: "failed", error: "linear no longer exists.", resumed: true });
    expect(f.answers).toEqual([{ messageId: card.id, text: expect.stringContaining("linear no longer exists.") }]);
    expect(await f.authorize(card)).toEqual({ status: 409, body: { error: "linear no longer exists." } });
    expect(f.answers).toHaveLength(1);
    expect(f.provider.counts.register).toBe(0);
  });

  it("dismiss cancels the flow and resumes with the not-signed-in text", async () => {
    const f = await setup();
    const { card } = await f.signIn();
    const link = (await f.authorize(card)).body.url as string;
    expect(await f.route("dismiss", card)).toEqual({ status: 200, body: { dismissed: true } });
    expect(f.current(card).connector).toMatchObject({ dismissed: true, resumed: true });
    expect(f.answers).toEqual([{ messageId: card.id, text: expect.stringContaining(NOT_SIGNED_IN) }]);
    expect(await f.approve(link).catch(() => "listener closed")).toBe("listener closed");
    expect(f.mcpOAuth.authState("linear", f.url)).not.toBe("signed-in");
  });

  it("on a Team Cloud a non-admin member cannot authorize a shared server's card; the turn's person can authorize their personal server's card and another member cannot", async () => {
    const f = await setup({ team: true });
    const shared = (await f.signIn("main-chat")).card;
    expect(await f.authorize(shared, session("ada@acme.test"))).toEqual({ status: 409, body: { error: "Only an admin of this installation can sign in to Linear." } });
    expect(f.provider.counts.register).toBe(0);

    f.team.scopes.set("mcp", "linear", "person");
    const own = await f.signIn("ada-chat");
    expect(own.status).toBe(202);
    expect(await f.authorize(own.card, session("cleo@acme.test"), ON_THE_MAC, "ada-chat")).toEqual({ status: 409, body: { error: "Only ada@acme.test can sign in to this." } });
    const hers = await f.authorize(own.card, session("ada@acme.test"), ON_THE_MAC, "ada-chat");
    expect(hers.status).toBe(200);
    expect(await f.approve(hers.body.url as string)).toBe(200);
    expect(f.team.people.oauth(ADA).authState("linear", f.url)).toBe("signed-in");
    expect(f.mcpOAuth.authState("linear", f.url)).toBe("none");
    expect(f.current(own.card, "ada-chat").connector).toMatchObject({ status: "connected", resumed: true });
  });

  it("the next turn after sign-in has the server's tools", async () => {
    const f = await setup();
    const kiwi = { id: "kiwi", name: "Kiwi" };
    f.mcpOAuth.markNeedsSignIn("linear", f.url);
    expect(await f.team.turnMcp(kiwi, "main-chat", "turn-1")).not.toHaveProperty("linear");
    const { card } = await f.signIn();
    expect(await f.approve((await f.authorize(card)).body.url as string)).toBe(200);
    const mounted = await f.team.turnMcp(kiwi, "main-chat", "turn-2");
    expect(mounted.linear).toMatchObject({ url: f.url, headers: { Authorization: `Bearer ${f.provider.issued[0]}` } });
  });
});
