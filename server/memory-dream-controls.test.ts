import { expect, it } from "vitest";
import { createMemoryUpkeep } from "./memory-upkeep.ts";

it("refuses busy bots, backup pauses and overlapping dreams, then permits retry", async () => {
  let busy = true;
  let release!: (text: string) => void;
  const response = new Promise<string>((resolve) => { release = resolve; });
  const bot = { id: "controlled", name: "Scout" };
  const loop = createMemoryUpkeep({ bots: () => [bot], bot: () => bot, engine: () => ({ generateText: () => response }), busy: () => busy,
    addToAboutMe: () => 0, sourceLabel: () => "chat", quietMs: () => 60_000, tidyHour: () => 3,
    conversations: () => ["one", "two"].map((threadId) => ({ threadId, lines: [{ by: "person", text: "Keep answers short." }] })),
  });
  try {
    expect(() => loop.dreamNow(bot.id)).toThrow("busy");
    expect(() => loop.restoreDream(bot.id, {})).toThrow("busy");
    busy = false;
    loop.pause();
    expect(() => loop.dreamNow(bot.id)).toThrow("paused");
    expect(() => loop.restoreDream(bot.id, {})).toThrow("paused");
    loop.resume();
    const running = loop.dreamNow(bot.id);
    expect(() => loop.dreamNow(bot.id)).toThrow("busy");
    expect(() => loop.restoreDream(bot.id, {})).toThrow("busy");
    release("{}");
    await running;
    await expect(loop.dreamNow(bot.id)).resolves.toMatchObject({ conversations: 2 });
  } finally { release("{}"); loop.stop(); await loop.idle(); }
});
