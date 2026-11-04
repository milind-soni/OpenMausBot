import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bareToolName, scoreCase, summarize, type ToolChoiceCase } from "./score.ts";

describe("tool-choice scoring", () => {
  it("counts the right tool, direct or looked up first, and nothing else", () => {
    expect(scoreCase({ tools: ["trigger"] }, ["mcp__agents__trigger"])).toEqual({ pass: true, chosen: "trigger", searched: false });
    expect(scoreCase({ tools: ["trigger"] }, ["find_tool", "trigger"])).toEqual({ pass: true, chosen: "trigger", searched: true });
    expect(scoreCase({ tools: ["trigger"] }, ["find_tool", "Bash"])).toEqual({ pass: false, chosen: "Bash", searched: true });
    expect(scoreCase({ tools: ["trigger"] }, [])).toEqual({ pass: false, chosen: undefined, searched: false });
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
      expect(item.tools.length, item.id).toBeGreaterThan(0);
      expect(item.why.length, item.id).toBeGreaterThan(0);
    }
  });
});
