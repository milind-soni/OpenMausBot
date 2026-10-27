import { describe, expect, it } from "vitest";

import { devsMentionRanges, tagsDevs, withoutDevsTags } from "./devs-mention.ts";

const tags = (text: string, bots: string[] = []) => devsMentionRanges(text, bots).map(({ start, end }) => text.slice(start, end));

describe("the @devs tag", () => {
  it("is found as the @ menu inserts it, typed by hand, in any case, and next to punctuation", () => {
    expect(tags("@devs the send button froze")).toEqual(["@devs"]);
    expect(tags("hey @Devs, it broke. (@DEVS) **@devs**\n@devs: again")).toEqual(["@Devs", "@DEVS", "@devs", "@devs"]);
  });

  it("is not an email, a URL path, a longer word or a tag inside code", () => {
    for (const text of ["mail ops@devs.example", "see /@devs", "@devsite", "@devs_team", "@devs2", "`@devs`", "```\n@devs\n```", "~~~\n@devs\n~~~"]) {
      expect(tagsDevs(text), text).toBe(false);
    }
  });

  it("gives way to a bot named devs, or with a longer name starting with it", () => {
    expect(tagsDevs("@devs hi", ["Devs"])).toBe(false);
    expect(tagsDevs("@devs team is down", ["devs team"])).toBe(false);
    expect(tagsDevs("@devs it broke", ["devs team"])).toBe(true);
    expect(tagsDevs("@devs it broke", ["Dev"])).toBe(true);
  });

  it("leaves the person's own words without the tag", () => {
    expect(withoutDevsTags("@devs the send button froze")).toBe("the send button froze");
    expect(withoutDevsTags("@devs: pictures never load, @devs please")).toBe("pictures never load, please");
    expect(withoutDevsTags("@devs")).toBe("");
    expect(withoutDevsTags("keep `@devs` in code @devs")).toBe("keep `@devs` in code");
  });
});
