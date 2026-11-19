import { describe, expect, it } from "vitest";
import { encodeProjectPath, pathMentionAt } from "./pathMentions";

describe("composer path references", () => {
  it("opens on slash and dot-slash and supports nested, encoded folder names", () => {
    expect(pathMentionAt("/", 1)).toMatchObject({ prefix: "/", directory: "", query: "" });
    const text = `Read #studio ./${encodeProjectPath("test fixtures/icons")}/logo`;
    expect(pathMentionAt(text, text.length)).toMatchObject({ prefix: "./", directory: "test fixtures/icons", query: "logo" });
  });

  it("ignores URLs, quoted picks, and paths outside the project", () => {
    for (const text of ["https://example.test/docs", "//external/path", "See `./already picked.txt`", "../../secret"]) {
      expect(pathMentionAt(text, text.length)).toBeNull();
    }
  });
});
