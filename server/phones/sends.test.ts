import { describe, expect, it } from "vitest";

import { createPhoneSends } from "./sends.ts";

describe("createPhoneSends", () => {
  it("knows the sends it noted and nothing else", () => {
    const sends = createPhoneSends();
    sends.note("send-from-phone-0001");
    expect(sends.has("send-from-phone-0001")).toBe(true);
    expect(sends.has("send-from-desk-00001")).toBe(false);
    expect(sends.has(undefined)).toBe(false);
  });

  it("forgets the oldest past its limit, and a send noted again counts as new", () => {
    const sends = createPhoneSends(3);
    for (const id of ["a", "b", "c"]) sends.note(id);
    sends.note("a");
    sends.note("d");
    expect(["a", "b", "c", "d"].filter((id) => sends.has(id))).toEqual(["a", "c", "d"]);
    sends.note("e");
    expect(["a", "b", "c", "d", "e"].filter((id) => sends.has(id))).toEqual(["a", "d", "e"]);
  });
});
