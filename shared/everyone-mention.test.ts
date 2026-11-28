import { describe, expect, it } from "vitest";

import { everyoneTagAt } from "./everyone-mention.ts";

describe("everyoneTagAt", () => {
  it("reads @everyone and @all, in any case, as whole words", () => {
    expect(everyoneTagAt("everyone hello")).toBe(8);
    expect(everyoneTagAt("All, please")).toBe(3);
    expect(everyoneTagAt("ALL")).toBe(3);
  });

  it("does not read a longer word that starts the same", () => {
    expect(everyoneTagAt("allie hello")).toBeUndefined();
    expect(everyoneTagAt("all_hands")).toBeUndefined();
    expect(everyoneTagAt("everyone2")).toBeUndefined();
  });

  it("leaves a bot whose name starts with the tag to that bot", () => {
    expect(everyoneTagAt("All-Star look", ["All-Star"])).toBeUndefined();
    expect(everyoneTagAt("all hands look", ["All Hands"])).toBeUndefined();
    expect(everyoneTagAt("All look", ["All"])).toBeUndefined();
    expect(everyoneTagAt("all look", ["All-Star"])).toBe(3);
  });

  it("keeps @everyone for everyone, as before, whatever the bots are called", () => {
    expect(everyoneTagAt("Everyone Helper, hi", ["Everyone Helper"])).toBe(8);
  });
});
