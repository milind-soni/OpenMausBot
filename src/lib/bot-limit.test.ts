import { afterEach, describe, expect, it } from "vitest";
import { botLimitShown, botRoom, closeBotLimit, isBotLimitRefusal, showBotLimit, stoppedAtBotLimit } from "./bot-limit";

afterEach(closeBotLimit);
const state = (botLimit: number | undefined, bots: Array<{ defaultBot?: object; hidden?: boolean; movedTo?: unknown }>) => ({ config: { botLimit }, bots });
const made = (count: number) => Array.from({ length: count }, () => ({}));

describe("how many more bots this plan makes", () => {
  it("has no answer on a plan without a limit, or before config has loaded", () => {
    expect(botRoom(state(undefined, made(50)))).toBeNull();
    expect(botRoom({ config: null, bots: made(50) })).toBeNull();
  });

  it("counts as the server does: not the MausBot, an archived bot, or one that moved away", () => {
    expect(botRoom(state(5, [{ defaultBot: {} }, { hidden: true }, { movedTo: { state: "moved" } }, {}]))).toBe(4);
  });

  it("is never below nothing on a Cloud over the limit", () => {
    expect(botRoom(state(5, made(9)))).toBe(0);
  });
});

describe("pressing a create button", () => {
  it("opens the popup instead when there is no room", () => {
    expect(stoppedAtBotLimit(state(5, made(5)))).toBe(true);
    expect(botLimitShown()).toBe(true);
  });

  it.each([[state(5, made(4))], [state(undefined, made(9))], [{ config: null, bots: [] }]])("goes on otherwise", (facts) => {
    expect(stoppedAtBotLimit(facts)).toBe(false);
    expect(botLimitShown()).toBe(false);
  });
});

describe("a refused request", () => {
  it("is known by its code, not its words", () => {
    expect(isBotLimitRefusal({ body: { code: "bot_limit", error: "anything" } })).toBe(true);
    for (const other of [{ body: { code: "thread_limit" } }, { body: {} }, new Error("bot_limit"), null, undefined]) expect(isBotLimitRefusal(other)).toBe(false);
  });

  it("opening twice and closing once closes it", () => {
    showBotLimit();
    showBotLimit();
    closeBotLimit();
    expect(botLimitShown()).toBe(false);
  });
});
