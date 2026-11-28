import { describe, expect, it } from "vitest";
import { everyoneTagAt, tagsEveryone } from "./everyone-mention";

describe("everyone tag", () => {
  it("reads @everyone and @all, in any case", () => {
    expect(everyoneTagAt("everyone hello")).toBe(8);
    expect(everyoneTagAt("All, hello")).toBe(3);
    expect(everyoneTagAt("ALL")).toBe(3);
  });

  it("rejects a longer word", () => {
    expect(everyoneTagAt("allow this")).toBeUndefined();
    expect(everyoneTagAt("all_done")).toBeUndefined();
    expect(everyoneTagAt("everyone2")).toBeUndefined();
    expect(everyoneTagAt("all調査")).toBeUndefined();
  });

  it("gives way to a bot or department with that name or a longer one", () => {
    expect(everyoneTagAt("All Hands report", ["All Hands"])).toBeUndefined();
    expect(everyoneTagAt("all", ["All"])).toBeUndefined();
    expect(everyoneTagAt("all report", ["All Hands"])).toBe(3);
    expect(everyoneTagAt("all report", ["Al"])).toBe(3);
  });

  it("finds the tag only at a mention boundary", () => {
    expect(tagsEveryone("status please @all")).toBe(true);
    expect(tagsEveryone("【@all】 hello")).toBe(true);
    expect(tagsEveryone("user@all /@all")).toBe(false);
    expect(tagsEveryone("@All Hands report", ["All Hands"])).toBe(false);
    expect(tagsEveryone("@All Hands and @all", ["All Hands"])).toBe(true);
  });
});
