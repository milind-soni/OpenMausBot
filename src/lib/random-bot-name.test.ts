import { afterEach, describe, expect, it, vi } from "vitest";
import female from "../data/given-names/female.json";
import male from "../data/given-names/male.json";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { randomBotName } from "./random-bot-name";

afterEach(() => vi.restoreAllMocks());

describe.each([['female', female], ['male', male]] as const)("%s name suggestions", (kind, names) => {
  it("ships at least 1,000 distinct usable names", () => {
    expect(new Set(names.map(name => name.trim().toLowerCase())).size).toBeGreaterThanOrEqual(1000);
    expect(names.every(name => name.trim().length > 0 && name.length <= BOT_PROFILE_LIMITS.name && !/[\r\n]/.test(name))).toBe(true);
  });

  it("avoids the current and existing bot names regardless of casing or spacing", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const existing = [` ${names[0].toUpperCase()} `];
    const current = names[1].toUpperCase();
    const result = randomBotName(kind, current, existing);
    expect(names).toContain(result);
    expect(result.toLowerCase()).not.toBe(names[0].toLowerCase());
    expect(result.toLowerCase()).not.toBe(names[1].toLowerCase());
    expect(existing).toEqual([` ${names[0].toUpperCase()} `]);
  });

  it("can sample the final entry", () => {
    vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
    expect(randomBotName(kind, "", [])).toBe(names.at(-1));
  });

  it("keeps changing suggestions when all names are already in use", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = randomBotName(kind, names[0], names);
    const second = randomBotName(kind, first, names);
    expect(first).not.toBe(names[0]);
    expect(second).not.toBe(first);
    expect(names).toContain(first);
    expect(names).toContain(second);
  });
});
