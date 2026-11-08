import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { createPoller, type ReadResult } from "./poller.ts";
import { createTelegramApi, type TelegramUpdate } from "./telegram.ts";

const TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz0123456789";

let fake: FakeTelegram;
let api: ReturnType<typeof createTelegramApi>;

beforeEach(async () => {
  fake = await startFakeTelegram({ [TOKEN]: "scout_bot" });
  api = createTelegramApi({ base: fake.url });
});
afterEach(() => fake.close());

function telegramPoller(read = api.getUpdates, extra: { failed?: (error: string) => void; delays?: { backoffMin?: number; backoffMax?: number; paused?: number } } = {}) {
  const handled: number[] = [];
  let cursor: number | undefined;
  const make = () => createPoller<TelegramUpdate>({
    source: "Telegram", token: () => TOKEN, cursor: () => cursor, read, failed: extra.failed ?? (() => undefined), delays: extra.delays,
    handle: async (update) => { handled.push(update.update_id); cursor = update.update_id + 1; },
  });
  return { handled, make };
}

describe("the poller", () => {
  it("hands items over in order, moves its cursor after each, and keeps the last on a restart", async () => {
    const { handled, make } = telegramPoller();
    const first = fake.push(TOKEN, 42, "one");
    fake.push(TOKEN, 42, "two");
    const poller = make();
    poller.start();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([first, first + 1]);
    poller.stop();
    const again = make();
    fake.push(TOKEN, 42, "three");
    again.start();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([first, first + 1, first + 2]);
    again.stop();
    expect(fake.polls.get(TOKEN)?.offset).toBe(first + 3);
  });

  it("backs off on errors and reports them, then recovers", async () => {
    const errors: string[] = [];
    let calls = 0;
    const failing = async (token: string, offset: number | undefined, signal?: AbortSignal): Promise<ReadResult<TelegramUpdate>> =>
      ++calls <= 2 ? { ok: false, error: "Conflict: terminated by other getUpdates request" } : api.getUpdates(token, offset, signal);
    const { handled, make } = telegramPoller(failing, { failed: (error) => errors.push(error), delays: { backoffMin: 20, backoffMax: 50 } });
    const id = fake.push(TOKEN, 42, "after the storm");
    const poller = make();
    poller.start();
    await expect.poll(() => handled, { timeout: 5_000 }).toEqual([id]);
    poller.stop();
    expect(errors).toEqual(["Conflict: terminated by other getUpdates request", "Conflict: terminated by other getUpdates request"]);
  });

  it("delivers nothing while paused, even from a check already in flight, and goes on after resume", async () => {
    const { handled, make } = telegramPoller(api.getUpdates, { delays: { paused: 20 } });
    const poller = make();
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

  it("waits its interval between reads, and reads again at once when a read says there is more", async () => {
    const stamps: number[] = [];
    let more = true;
    const poller = createPoller<number>({
      source: "test", token: () => "t", cursor: () => undefined, failed: () => undefined, handle: async () => undefined, interval: 120,
      read: async () => { stamps.push(Date.now()); const result = { ok: true as const, items: [], more }; more = false; return result; },
    });
    poller.start();
    await expect.poll(() => stamps.length, { timeout: 3_000 }).toBeGreaterThanOrEqual(3);
    poller.stop();
    expect(stamps[1]! - stamps[0]!).toBeLessThan(100);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(100);
  });
});
