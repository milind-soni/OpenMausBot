import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "../routes/table.ts";
import type { StoreChange } from "../store.ts";
import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { createTelegramHost, type TelegramHost } from "./telegram-host.ts";

const TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz0123456789";
const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const SERVICE: RequestAuth = { kind: "loopback", scopes: [], trust: "service" } as RequestAuth;

let dir: string;
let fake: FakeTelegram;
let host: TelegramHost;
let listeners: Array<(change: StoreChange) => void>;
let bots: Set<string>;

function build(teamCloud = false): TelegramHost {
  return createTelegramHost({
    dataDir: dir, teamCloud, apiBase: fake.url, delays: { backoffMin: 20, backoffMax: 50, paused: 20 },
    store: {
      bot: (id) => (bots.has(id) ? { id, name: id } : undefined) as never,
      taskByThread: () => undefined,
      createTask: () => ({ threadId: "t1" }) as never,
      activePath: () => [],
      onChange: (listener) => { listeners.push(listener); return () => undefined; },
    },
    deliver: async () => undefined, needsInput: () => false,
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-telegram-host-"));
  fake = await startFakeTelegram({ [TOKEN]: "scout_bot" });
  listeners = [];
  bots = new Set(["scout"]);
  host = build();
  host.start();
});
afterEach(async () => {
  host.stop();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the routes", () => {
  it("refuse service-trust loopback, an unknown bot, and a link before a token", async () => {
    expect((await route("GET", "/api/bots/scout/telegram", SERVICE)).status).toBe(403);
    expect((await route("GET", "/api/bots/nobody/telegram")).status).toBe(404);
    expect((await route("POST", "/api/bots/scout/telegram/link")).status).toBe(409);
    expect((await route("GET", "/api/bots/scout/other")).status).toBe(-1);
  });

  it("connect a checked token and start reading, and a refused token changes nothing", async () => {
    expect((await route("POST", "/api/bots/scout/telegram", OWNER, { token: "nope" })).status).toBe(400);
    expect(fake.polls.size).toBe(0);
    const connected = await route("POST", "/api/bots/scout/telegram", OWNER, { token: TOKEN });
    expect(connected).toEqual({ status: 200, body: { available: true, connected: true, username: "scout_bot", chats: [] } });
    expect(readFileSync(join(dir, "telegram.json"), "utf8")).not.toContain(TOKEN.split(":")[1]);
    await expect.poll(() => fake.polls.get(TOKEN)?.count ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
    const link = await route("POST", "/api/bots/scout/telegram/link");
    expect(link.body).toMatchObject({ url: `https://t.me/scout_bot?start=${link.body.code}`, linkExpiresAt: expect.any(Number) });
  });

  it("are off on a Team Cloud: a view that says so, 409 on every change, and no reads", async () => {
    host.stop();
    host = build(true);
    host.start();
    expect((await route("GET", "/api/bots/scout/telegram")).body).toEqual({ available: false, connected: false, chats: [] });
    expect((await route("POST", "/api/bots/scout/telegram", OWNER, { token: TOKEN })).status).toBe(409);
    expect((await route("DELETE", "/api/bots/scout/telegram")).status).toBe(409);
    expect(fake.polls.size).toBe(0);
  });
});

describe("the readers", () => {
  it("stop and forget the bot when it is deleted", async () => {
    await route("POST", "/api/bots/scout/telegram", OWNER, { token: TOKEN });
    await expect.poll(() => fake.polls.get(TOKEN)?.count ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
    bots.delete("scout");
    for (const listener of listeners) listener({ type: "bot.deleted", botId: "scout" });
    const count = fake.polls.get(TOKEN)!.count;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.polls.get(TOKEN)!.count - count).toBeLessThanOrEqual(1);
    expect(readFileSync(join(dir, "telegram.json"), "utf8")).toBe("{}\n");
    expect(host.busy()).toBe(false);
  });

  it("come back after a restart for every connected bot", async () => {
    await route("POST", "/api/bots/scout/telegram", OWNER, { token: TOKEN });
    host.stop();
    host = build();
    host.start();
    const before = fake.polls.get(TOKEN)?.count ?? 0;
    await expect.poll(() => fake.polls.get(TOKEN)?.count ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
  });
});
