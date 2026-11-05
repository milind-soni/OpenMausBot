import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { createTelegramApi, createTelegramPoller, inboundOf, telegramApiBase, telegramLink, type TelegramUpdate } from "./telegram.ts";

const TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz0123456789";

let fake: FakeTelegram;
let api: ReturnType<typeof createTelegramApi>;

beforeEach(async () => {
  fake = await startFakeTelegram({ [TOKEN]: "scout_bot" });
  api = createTelegramApi({ base: fake.url });
});
afterEach(() => fake.close());

describe("the Bot API client", () => {
  it("names the bot a token belongs to, and says why a token is refused", async () => {
    expect(await api.getMe(TOKEN)).toEqual({ ok: true, username: "scout_bot" });
    expect(await api.getMe("123456789:AAE-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toEqual({ ok: false, error: "Telegram doesn't know that token. Copy it again from BotFather." });
    expect(await api.getMe("not a token")).toMatchObject({ ok: false, error: expect.stringContaining("doesn't look like a bot token") });
  });

  it("reads updates from an offset, parses messages and skips what carries none", async () => {
    const first = fake.push(TOKEN, 42, "hello", { name: "Ada" });
    fake.push(TOKEN, -100, "group chatter", { type: "supergroup" });
    const all = await api.getUpdates(TOKEN, undefined);
    expect(all.ok && all.updates.map(inboundOf)).toEqual([
      { id: `tg_${first}`, chatId: "42", name: "Ada", text: "hello", private: true },
      { id: `tg_${first + 1}`, chatId: "-100", name: "Ada", text: "group chatter", private: false },
    ]);
    const later = await api.getUpdates(TOKEN, first + 1);
    expect(later.ok && later.updates.map((update) => update.update_id)).toEqual([first + 1]);
    expect(inboundOf({ update_id: 1 } as TelegramUpdate)).toBeNull();
    expect(inboundOf({ update_id: 2, message: { message_id: 1, chat: { id: 7, type: "private" } } })).toMatchObject({ text: "", private: true });
  });

  it("sends plain text and reports Telegram's refusal without the token", async () => {
    expect(await api.sendMessage(TOKEN, "42", "Hi")).toEqual({ ok: true });
    expect(fake.sent).toEqual([{ token: TOKEN, chatId: "42", text: "Hi" }]);
    fake.failSends(true);
    const refused = await api.sendMessage(TOKEN, "42", "Hi");
    expect(refused).toEqual({ ok: false, error: "Bad Request: chat not found" });
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
  });

  it("reports an unreachable server as such", async () => {
    await fake.close();
    const gone = await api.sendMessage(TOKEN, "42", "Hi");
    expect(gone.ok).toBe(false);
    expect(JSON.stringify(gone)).not.toContain(TOKEN);
  });
});

describe("the address and the link", () => {
  it("takes a loopback stand-in from the environment and nothing else", () => {
    expect(telegramApiBase({ OMB_TELEGRAM_API_BASE: "http://127.0.0.1:4321" })).toBe("http://127.0.0.1:4321");
    expect(telegramApiBase({ OMB_TELEGRAM_API_BASE: "https://evil.example" })).toBe("https://api.telegram.org");
    expect(telegramApiBase({ OMB_TELEGRAM_API_BASE: "http://localhost:4321" })).toBe("https://api.telegram.org");
    expect(telegramApiBase({})).toBe("https://api.telegram.org");
  });

  it("is the t.me link Telegram opens with /start and the code", () => {
    expect(telegramLink("scout_bot", "123456")).toBe("https://t.me/scout_bot?start=123456");
  });
});

describe("the poller", () => {
  it("hands updates over in order, moves its offset after each, and keeps the last on a restart", async () => {
    const handled: number[] = [];
    let cursor: number | undefined;
    const poller = createTelegramPoller({ api, token: () => TOKEN, cursor: () => cursor, handle: async (update) => { handled.push(update.update_id); cursor = update.update_id + 1; }, failed: () => undefined });
    const first = fake.push(TOKEN, 42, "one");
    fake.push(TOKEN, 42, "two");
    poller.start();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([first, first + 1]);
    poller.stop();
    const again = createTelegramPoller({ api, token: () => TOKEN, cursor: () => cursor, handle: async (update) => { handled.push(update.update_id); cursor = update.update_id + 1; }, failed: () => undefined });
    fake.push(TOKEN, 42, "three");
    again.start();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([first, first + 1, first + 2]);
    again.stop();
    expect(fake.polls.get(TOKEN)?.offset).toBe(first + 3);
  });

  it("backs off on errors and reports them, then recovers", async () => {
    const errors: string[] = [];
    let calls = 0;
    const failing = { getUpdates: async (token: string, offset: number | undefined, signal?: AbortSignal) => (++calls <= 2 ? { ok: false as const, error: "Conflict: terminated by other getUpdates request" } : api.getUpdates(token, offset, signal)) };
    const handled: number[] = [];
    let cursor: number | undefined;
    const poller = createTelegramPoller({ api: failing, token: () => TOKEN, cursor: () => cursor, handle: async (update) => { handled.push(update.update_id); cursor = update.update_id + 1; }, failed: (error) => errors.push(error), delays: { backoffMin: 20, backoffMax: 50 } });
    const id = fake.push(TOKEN, 42, "after the storm");
    poller.start();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([id]);
    poller.stop();
    expect(errors).toEqual(["Conflict: terminated by other getUpdates request", "Conflict: terminated by other getUpdates request"]);
  });

  it("delivers nothing while paused, even from a check already in flight, and goes on after resume", async () => {
    const handled: number[] = [];
    let cursor: number | undefined;
    const poller = createTelegramPoller({ api, token: () => TOKEN, cursor: () => cursor, handle: async (update) => { handled.push(update.update_id); cursor = update.update_id + 1; }, failed: () => undefined, delays: { paused: 20 } });
    poller.start();
    await expect.poll(() => fake.polls.get(TOKEN)?.count ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
    poller.pause();
    const id = fake.push(TOKEN, 42, "while paused");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(handled).toEqual([]);
    expect(poller.busy()).toBe(false);
    poller.resume();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([id]);
    poller.stop();
  });
});
