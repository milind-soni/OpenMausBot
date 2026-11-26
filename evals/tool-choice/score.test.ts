import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES } from "../../server/drivers/agents-claude-defer.ts";
import { contextSizes } from "./context.ts";
import { bareToolName, scoreCase, summarize, type ToolChoiceCase } from "./score.ts";

describe("tool-choice scoring", () => {
  it("counts the right tool, direct or looked up first, and nothing else", () => {
    expect(scoreCase({ tools: ["trigger"] }, ["mcp__agents__trigger"])).toEqual({ pass: true, chosen: "trigger", searched: false });
    expect(scoreCase({ tools: ["trigger"] }, ["find_tool", "trigger"])).toEqual({ pass: true, chosen: "trigger", searched: true });
    expect(scoreCase({ tools: ["trigger"] }, ["find_tool", "Bash"])).toEqual({ pass: false, chosen: "Bash", searched: true });
    expect(scoreCase({ tools: ["trigger"] }, [])).toEqual({ pass: false, chosen: undefined, searched: false });
  });

  it("fails a turn that reaches a tool the case rules out, and a publish that does not say the link is public", () => {
    const justForMe = { tools: [], never: ["publish_page", "publish_app"] };
    expect(scoreCase(justForMe, ["Write", "attach_file"])).toEqual({ pass: true, chosen: "Write", searched: false });
    expect(scoreCase(justForMe, ["Write", "mcp__agents__publish_page"])).toEqual({ pass: false, chosen: "publish_page", searched: false });
    const share = { tools: ["publish_page"], publishSays: "anyone with (the |this )?link" };
    expect(scoreCase(share, ["publish_page"], "Here it is: https://x.page. Anyone with the link can open it.").pass).toBe(true);
    expect(scoreCase(share, ["publish_page"], "Here it is: https://x.page").pass).toBe(false);
    const family = { tools: [], publishSays: "anyone with (the |this )?link" };
    expect(scoreCase(family, ["Write"], "Here is the file.").pass).toBe(true);
    expect(scoreCase(family, ["publish_page"], "Shared: https://x.page").pass).toBe(false);
  });

  it("strips the server from a tool name, including one with an underscore", () => {
    expect(bareToolName("mcp__agents__session_search")).toBe("session_search");
    expect(bareToolName("mcp__own_apps__GMAIL_SEND")).toBe("GMAIL_SEND");
    expect(bareToolName("Bash")).toBe("Bash");
  });

  it("adds up a run", () => {
    const pass = { pass: true, chosen: "a", searched: false }, miss = { pass: false, chosen: undefined, searched: true };
    expect(summarize([{ score: pass, costUsd: 0.1, inputTokens: 5 }, { score: miss, costUsd: 0.2, inputTokens: 7 }]))
      .toEqual({ cases: 2, passed: 1, searched: 1, costUsd: 0.3, inputTokens: 12 });
  });

  it("every case names a real failure and at least one tool", () => {
    const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as ToolChoiceCase[];
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    for (const item of cases) {
      expect(item.tools.length + (item.never?.length ?? 0) + (item.publishSays ? 1 : 0), item.id).toBeGreaterThan(0);
      expect(item.why.length, item.id).toBeGreaterThan(0);
    }
  });

  it("measures the deferred agents tools against the whole list, with no model", () => {
    for (const row of contextSizes()) {
      expect(row.after.total, row.profile).toBeLessThan(row.before.total / 5);
      expect(row.loaded.every((name) => CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES.has(name)), row.profile).toBe(true);
    }
  });
});
