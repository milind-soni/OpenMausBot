import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { createTelegramApi, inboundOf, telegramApiBase, telegramLink, type TelegramUpdate } from "./telegram.ts";

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
    expect(all.ok && all.items.map(inboundOf)).toEqual([
      { id: `tg_${first}`, chatId: "42", name: "Ada", text: "hello", private: true },
      { id: `tg_${first + 1}`, chatId: "-100", name: "Ada", text: "group chatter", private: false },
    ]);
    const later = await api.getUpdates(TOKEN, first + 1);
    expect(later.ok && later.items.map((update) => update.update_id)).toEqual([first + 1]);
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
