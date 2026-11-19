import { describe, expect, it } from "vitest";
import { appMentionMatches, appMentionQueryAt, insertAppMention } from "./appMentions";

describe("app mention queries", () => {
  it("opens on + at a word start and follows typing", () => {
    expect(appMentionQueryAt("+", 1)).toEqual({ start: 0, query: "" });
    expect(appMentionQueryAt("make it with +ed", 16)).toEqual({ start: 13, query: "ed" });
    expect(appMentionQueryAt("(+edits", 7)).toEqual({ start: 1, query: "edits" });
  });

  it("ignores phone numbers, sums and emails", () => {
    expect(appMentionQueryAt("call +44", 8)).toBeNull();
    expect(appMentionQueryAt("1+1", 3)).toBeNull();
    expect(appMentionQueryAt("me+edits@mail", 8)).toBeNull();
    expect(appMentionQueryAt("+edits now", 10)).toBeNull();
  });

  it("inserts the canonical tag followed by one space", () => {
    const q = appMentionQueryAt("use +Ed please", 7)!;
    expect(insertAppMention("use +Ed please", 7, q, "edits")).toEqual({ text: "use +edits please", caret: 11 });
  });
});

describe("app mention matches", () => {
  it("matches known apps only, case-insensitively, at word starts", () => {
    expect(appMentionMatches("+Edits make a montage, not a+edits or +nope", ["edits"])).toEqual([
      { start: 0, end: 6, text: "+Edits", appId: "edits" },
    ]);
  });
});
