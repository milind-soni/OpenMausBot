import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "../routes/table.ts";
import type { StoreChange } from "../store.ts";
import { startFakeSendblue, type FakeSendblue } from "../testing/fake-sendblue.ts";
import { createSendblueHost, type SendblueHost } from "./sendblue-host.ts";
import { SENDBLUE_START_MARGIN_MS } from "./sendblue.ts";

const SCOUT = { keyId: "key-scout-0001", secret: "secret-scout-aaaa-bbbb", number: "+14155550100" };
const MIRA = { keyId: "key-mira-0002", secret: "secret-mira-cccc-dddd", number: "+14155550200" };
const ADA = "+14155550123";
const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const SERVICE: RequestAuth = { kind: "loopback", scopes: [], trust: "service" } as RequestAuth;

let dir: string;
let fake: FakeSendblue;
let host: SendblueHost;
let listeners: Array<(change: StoreChange) => void>;
let bots: Set<string>;
let delivered: Array<{ botId: string; text: string }>;

function build(teamCloud = false): SendblueHost {
  return createSendblueHost({
    dataDir: dir, teamCloud, apiBase: fake.url, interval: 30, delays: { backoffMin: 20, backoffMax: 50, paused: 20 },
    store: {
      bot: (id) => (bots.has(id) ? { id, name: id } : undefined) as never,
      taskByThread: () => ({}) as never,
      createTask: () => ({ threadId: "t1" }) as never,
      activePath: () => [],
      onChange: (listener) => { listeners.push(listener); return () => undefined; },
    },
    deliver: async (botId, _threadId, text) => { delivered.push({ botId, text }); }, needsInput: () => false,
  });
}

async function route(method: string, path: string, auth: RequestAuth = OWNER, body?: unknown): Promise<{ status: number; body: any }> {
  let answer = { status: 0, body: undefined as any };
  const res = { headersSent: false, writableEnded: false } as RouteContext["res"];
  const out = await host.routes({
    req: {} as RouteContext["req"], res, url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }) as never,
    readBody: (async () => body) as never,
  });
  return typeof out === "symbol" ? { status: -1, body: undefined } : answer;
}

const connect = (bot: string, account: typeof SCOUT) => route("POST", `/api/bots/${bot}/imessage`, OWNER, account);
const linkAs = async (bot: string, account: typeof SCOUT, from: string) => {
  const link = await route("POST", `/api/bots/${bot}/imessage/link`);
  fake.push(account.keyId, from, link.body.command);
  await expect.poll(() => route("GET", `/api/bots/${bot}/imessage`).then((view) => view.body.chats.length), { timeout: 5_000 }).toBeGreaterThan(0);
  return link.body;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-sendblue-host-"));
  fake = await startFakeSendblue({ [SCOUT.keyId]: { secret: SCOUT.secret, number: SCOUT.number }, [MIRA.keyId]: { secret: MIRA.secret, number: MIRA.number } });
  listeners = [];
  bots = new Set(["scout", "mira"]);
  delivered = [];
  host = build();
  host.start();
});
afterEach(async () => {
  host.stop();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the routes", () => {
  it("refuse service-trust loopback, an unknown bot, and a link before a key", async () => {
    expect((await route("GET", "/api/bots/scout/imessage", SERVICE)).status).toBe(403);
    expect((await route("GET", "/api/bots/nobody/imessage")).status).toBe(404);
    expect((await route("POST", "/api/bots/scout/imessage/link")).status).toBe(409);
    expect((await route("GET", "/api/bots/scout/other")).status).toBe(-1);
  });

  it("connect a checked key and number and start reading, and a refused one changes nothing", async () => {
    expect((await route("POST", "/api/bots/scout/imessage", OWNER, { keyId: SCOUT.keyId })).status).toBe(400);
    expect((await connect("scout", { ...SCOUT, number: "4155550100" })).body.error).toMatch(/country code/);
    expect((await connect("scout", { ...SCOUT, secret: "wrong-secret-wrong" })).body.error).toMatch(/doesn't know that API key ID and secret/);
    expect((await connect("scout", { ...SCOUT, number: "+14155550199" })).body.error).toBe("That number isn't on this Sendblue account.");
    expect(fake.polls.size).toBe(0);
    const connected = await connect("scout", { ...SCOUT, number: "+1 (415) 555-0100" });
    expect(connected).toEqual({ status: 200, body: { available: true, connected: true, number: SCOUT.number, chats: [] } });
    const saved = readFileSync(join(dir, "imessage.json"), "utf8");
    for (const secret of [SCOUT.secret, SCOUT.keyId]) expect(saved).not.toContain(secret);
    expect(JSON.stringify(connected.body)).not.toContain(SCOUT.secret);
    await expect.poll(() => fake.polls.get(SCOUT.keyId)?.count ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
  });

  it("start a link that names the command and the sms link, and refuse a number another bot already uses", async () => {
    await connect("scout", SCOUT);
    const link = await route("POST", "/api/bots/scout/imessage/link");
    expect(link.body).toMatchObject({ command: `link ${link.body.code}`, url: `sms:${SCOUT.number}&body=link%20${link.body.code}`, linkExpiresAt: expect.any(Number) });
    expect(link.body.code).toMatch(/^\d{6}$/);
    expect((await connect("mira", SCOUT)).body.error).toMatch(/Another bot already uses that number/);
    expect((await connect("mira", MIRA)).status).toBe(200);
  });

  it("are off on a Team Cloud: a view that says so, 409 on every change, and no reads", async () => {
    host.stop();
    host = build(true);
    host.start();
    expect((await route("GET", "/api/bots/scout/imessage")).body).toEqual({ available: false, connected: false, chats: [] });
    expect((await connect("scout", SCOUT)).status).toBe(409);
    expect((await route("DELETE", "/api/bots/scout/imessage")).status).toBe(409);
    expect(fake.polls.size).toBe(0);
  });
});

describe("hearing the person", () => {
  it("links on the code, hears the number once however often Sendblue lists it, and ignores groups and strangers", async () => {
    await connect("scout", SCOUT);
    await linkAs("scout", SCOUT, ADA);
    expect((await route("GET", "/api/bots/scout/imessage")).body.chats).toEqual([{ id: ADA }]);
    fake.push(SCOUT.keyId, ADA, "hello");
    fake.push(SCOUT.keyId, "+14155550999", "who is this?");
    fake.push(SCOUT.keyId, ADA, "a group message", { group: "g1" });
    await expect.poll(() => delivered, { timeout: 5_000 }).toEqual([{ botId: "scout", text: "hello" }]);
    const polls = fake.polls.get(SCOUT.keyId)!.count;
    await expect.poll(() => fake.polls.get(SCOUT.keyId)!.count, { timeout: 5_000 }).toBeGreaterThan(polls + 2);
    expect(delivered).toHaveLength(1);
    expect(fake.sent.map((entry) => entry.content)).toEqual(["You're connected to scout. Message me here any time."]);
  });

  it("keeps each bot to its own key: a number linked to one is a stranger to the other", async () => {
    await connect("scout", SCOUT);
    await connect("mira", MIRA);
    await linkAs("scout", SCOUT, ADA);
    fake.push(MIRA.keyId, ADA, "mira, are you there?");
    fake.push(SCOUT.keyId, ADA, "scout, are you there?");
    await expect.poll(() => delivered, { timeout: 5_000 }).toEqual([{ botId: "scout", text: "scout, are you there?" }]);
    expect((await route("GET", "/api/bots/mira/imessage")).body.chats).toEqual([]);
    expect(fake.sent.every((entry) => entry.keyId === SCOUT.keyId && entry.from === SCOUT.number)).toBe(true);
  });

  it("starts a little before the connection and not from the beginning, and keeps its place across a restart", async () => {
    const connectedAt = Date.now();
    await connect("scout", SCOUT);
    await expect.poll(() => fake.polls.get(SCOUT.keyId)?.query?.get("created_at_gte"), { timeout: 5_000 }).toBeTruthy();
    const since = Date.parse(fake.polls.get(SCOUT.keyId)!.query!.get("created_at_gte")!);
    expect(since).toBeGreaterThanOrEqual(connectedAt - SENDBLUE_START_MARGIN_MS - 1000);
    expect(since).toBeLessThanOrEqual(Date.now());
    const link = await route("POST", "/api/bots/scout/imessage/link");
    host.stop();
    fake.push(SCOUT.keyId, ADA, link.body.command);
    fake.push(SCOUT.keyId, ADA, "hello");
    host = build();
    host.start();
    await expect.poll(() => delivered, { timeout: 5_000 }).toEqual([{ botId: "scout", text: "hello" }]);
    host.stop();
    host = build();
    host.start();
    const polls = fake.polls.get(SCOUT.keyId)!.count;
    await expect.poll(() => fake.polls.get(SCOUT.keyId)!.count, { timeout: 5_000 }).toBeGreaterThan(polls + 1);
    expect(delivered).toHaveLength(1);
  });

  it("backs off on an error, records it without the key, and goes on when Sendblue recovers", async () => {
    await connect("scout", SCOUT);
    await linkAs("scout", SCOUT, ADA);
    fake.failLists(500);
    await expect.poll(async () => (await route("GET", "/api/bots/scout/imessage")).body.lastError?.message, { timeout: 5_000 }).toMatch(/Couldn't check Sendblue/);
    const view = await route("GET", "/api/bots/scout/imessage");
    expect(JSON.stringify(view.body)).not.toContain(SCOUT.secret);
    expect(readFileSync(join(dir, "imessage.json"), "utf8")).not.toContain(SCOUT.secret);
    fake.push(SCOUT.keyId, ADA, "after the storm");
    fake.failLists(undefined);
    await expect.poll(() => delivered, { timeout: 5_000 }).toEqual([{ botId: "scout", text: "after the storm" }]);
  });
});

describe("the readers", () => {
  it("stop and forget the bot when it is deleted, and on disconnect", async () => {
    await connect("scout", SCOUT);
    await connect("mira", MIRA);
    await expect.poll(() => Math.min(fake.polls.get(SCOUT.keyId)?.count ?? 0, fake.polls.get(MIRA.keyId)?.count ?? 0), { timeout: 5_000 }).toBeGreaterThan(0);
    bots.delete("scout");
    for (const listener of listeners) listener({ type: "bot.deleted", botId: "scout" });
    expect((await route("DELETE", "/api/bots/mira/imessage")).body).toEqual({ available: true, connected: false, chats: [] });
    const counts = [fake.polls.get(SCOUT.keyId)!.count, fake.polls.get(MIRA.keyId)!.count];
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([fake.polls.get(SCOUT.keyId)!.count - counts[0]!, fake.polls.get(MIRA.keyId)!.count - counts[1]!].every((extra) => extra <= 1)).toBe(true);
    expect(readFileSync(join(dir, "imessage.json"), "utf8")).toBe("{}\n");
    expect(host.busy()).toBe(false);
  });

  it("come back after a restart for every connected bot", async () => {
    await connect("scout", SCOUT);
    host.stop();
    host = build();
    host.start();
    const before = fake.polls.get(SCOUT.keyId)?.count ?? 0;
    await expect.poll(() => fake.polls.get(SCOUT.keyId)?.count ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
  });
});
