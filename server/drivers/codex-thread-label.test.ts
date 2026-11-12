import { describe, expect, it } from "vitest";

import { codexThreadLabel } from "./codex-thread-label.ts";

describe("codexThreadLabel", () => {
  it("files a bot with no department under MausBot", () => {
    expect(codexThreadLabel({ department: "  ", bot: "MausBot", conversation: "Plan the week" }))
      .toEqual({ section: "MausBot", name: "MausBot · Plan the week" });
  });

  it("files a department's bot under that department", () => {
    expect(codexThreadLabel({ department: " Marketing ", bot: "Carol", conversation: "Q1 campaign" }))
      .toEqual({ section: "MausBot · Marketing", name: "Carol · Q1 campaign" });
  });

  it("shortens a long name", () => {
    const { name } = codexThreadLabel({ bot: "Ada", conversation: "x".repeat(200) });
    expect(name).toHaveLength(120);
    expect(name.endsWith("…")).toBe(true);
  });
});
