import { describe, expect, it } from "vitest";

import { FIX_HINTS, fixHintFor, hintOrigin, HINT_PREFIX, withFixHint } from "./tool-hints.ts";

const toolFor = (origin: string, tools?: readonly string[]) =>
  tools?.[0] ?? (origin === "shell" ? "Bash" : origin === "harness" ? "mcp__agents__coordinate_bots" : "Read");

describe("fix hint table", () => {
  it("has unique ids, one-line hints, and an example each entry matches", () => {
    const ids = FIX_HINTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of FIX_HINTS) {
      expect(entry.id, entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(entry.hint, entry.id).not.toContain("\n");
      expect(entry.hint.length, entry.id).toBeLessThanOrEqual(200);
      expect(fixHintFor({ tool: toolFor(entry.origin, entry.tools), text: entry.example })?.id, entry.id).toBe(entry.id);
    }
  });

  it("matches the failures seen in real runs", () => {
    const cases: Array<[string, string, string]> = [
      ["Bash", "Exit code 143\nCommand timed out after 2m 0s", "shell-timeout"],
      ["Bash", "awk: syntax error at source line 1\n context is\n\t{ >>>  sin= <<< \nawk: bailing out at source line 1", "awk-builtin-name"],
      ["Read", "File does not exist. Note: your current working directory is /tmp/w.", "read-missing-file"],
      ["mcp__agents__coordinate_bots", "Cannot assign work back to an ancestor; results return automatically", "assign-to-ancestor"],
      ["mcp__agents__coordinate_bots", "A room request cannot return to an ancestor room; results are returned automatically", "assign-to-ancestor"],
      ["mcp__agents__coordinate_bots", "This agent already completed your assignment. Do not send acknowledgements or approvals as new work.", "already-completed"],
      ["mcp__agents__coordinate_bots", "No bot with id or name \"Editor\" — call list_bots and copy the exact id from the result.", "unknown-bot"],
    ];
    for (const [tool, text, id] of cases) expect(fixHintFor({ tool, text })?.id, text).toBe(id);
  });

  it("keeps an entry to its own tools and origin", () => {
    // a Bash script that prints "File does not exist" is not a Read failure
    expect(fixHintFor({ tool: "Bash", text: "File does not exist" })).toBeUndefined();
    // another MCP server's timeout is not a shell timeout
    expect(fixHintFor({ tool: "mcp__someone__run", text: "Command timed out after 2m" })).toBeUndefined();
    // awk failing for another reason gets no built-in-name hint
    expect(fixHintFor({ tool: "Bash", text: "awk: syntax error at source line 1\n context is\n\t{ >>> print( <<<" })).toBeUndefined();
    expect(fixHintFor({ tool: "Bash", text: "Exit code 1\nls: x: No such file or directory" })).toBeUndefined();
  });

  it("classifies tools by who owns them", () => {
    expect(hintOrigin("Bash")).toBe("shell");
    expect(hintOrigin("exec_command")).toBe("shell");
    expect(hintOrigin("mcp__agents__coordinate_bots")).toBe("harness");
    expect(hintOrigin("mcp__github__create_issue")).toBe("external");
    expect(hintOrigin("Read")).toBe("external");
  });

  it("matches with numbers, paths and quoted names replaced", () => {
    expect(fixHintFor({ tool: "Bash", text: "Exit code <n> Command timed out after <n>m <n>s" })?.id).toBe("shell-timeout");
    expect(fixHintFor({ tool: "Read", text: "File does not exist. Note: your current working directory is <path>." })?.id).toBe("read-missing-file");
    expect(fixHintFor({ tool: "coordinate_bots", origin: "harness", text: "No bot with id or name <q> — call list_bots" })?.id).toBe("unknown-bot");
  });

  it("appends one hint line and never twice", () => {
    const text = "Exit code 143\nCommand timed out after 2m 0s";
    const hinted = withFixHint({ tool: "Bash", text });
    expect(hinted.startsWith(`${text}\n\n${HINT_PREFIX}`)).toBe(true);
    expect(withFixHint({ tool: "Bash", text: hinted })).toBe(hinted);
    expect(withFixHint({ tool: "Bash", text: "Exit code 2" })).toBe("Exit code 2");
  });

  it("finds the reason at either end of a long error", () => {
    const noise = "x".repeat(50_000);
    expect(fixHintFor({ tool: "Bash", text: `${noise}\nCommand timed out after 2m` })?.id).toBe("shell-timeout");
    expect(fixHintFor({ tool: "Bash", text: `Command timed out after 2m\n${noise}` })?.id).toBe("shell-timeout");
  });
});
