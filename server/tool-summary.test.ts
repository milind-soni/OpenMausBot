import { describe, expect, it } from "vitest";

import { askInputSummary, commandSummary } from "./tool-summary.ts";

describe("commandSummary", () => {
  it("is the shell command, cut at 200", () => {
    expect(commandSummary({ command: "pnpm control:omb doctor --url http://127.0.0.1:1", url: "x" }))
      .toBe("pnpm control:omb doctor --url http://127.0.0.1:1");
    expect(commandSummary({ command: "x".repeat(260) })).toBe("x".repeat(200));
  });

  it("says nothing for a call that runs no command — a Read, an Edit, a fetch", () => {
    expect(commandSummary({ file_path: "/tmp/notes.md" })).toBeUndefined();
    expect(commandSummary({ file_path: "scripts/control-omb.ts", old_string: "a", new_string: "b" })).toBeUndefined();
    expect(commandSummary({ url: "https://example.com/docs" })).toBeUndefined();
    expect(commandSummary({ question: "Which one?" })).toBeUndefined();
    expect(commandSummary({})).toBeUndefined();
    expect(commandSummary(undefined)).toBeUndefined();
    expect(commandSummary(null)).toBeUndefined();
    expect(commandSummary("ls")).toBeUndefined();
    expect(commandSummary(["ls"])).toBeUndefined();
  });

  it("collapses a multi-line command onto one line", () => {
    expect(commandSummary({ command: "cd repo &&\n  pnpm test \\\n  --run" })).toBe("cd repo && pnpm test \\ --run");
  });

  it("redacts credentials before cutting, so a sliced key cannot slip through", () => {
    // the token starts at column 186: cutting first would leave "ghp_" plus
    // ten characters — too short for the github shape to catch
    const token = `ghp_${"a".repeat(36)}`;
    const summary = commandSummary({ command: `${"x".repeat(180)} curl ${token} https://api` });
    expect(summary).not.toContain("ghp_");
    expect(summary).toContain("«redacted 40 chars»".slice(0, 14));
    expect(summary!.length).toBeLessThanOrEqual(200);
  });
});

describe("askInputSummary", () => {
  it("prefers a question, at its longer limit", () => {
    const question = "Which of these should I keep? ".repeat(12);
    expect(askInputSummary({ question, command: "ls" })).toBe(question.trim().slice(0, 300));
  });

  it("keeps a multi-line command multi-line — the card shows it as it will run", () => {
    expect(askInputSummary({ command: "cd repo &&\n  pnpm test \\\n  --run" })).toBe("cd repo &&\n  pnpm test \\\n  --run");
    expect(askInputSummary({ command: "x".repeat(260) })).toBe("x".repeat(200));
  });

  it("falls back to a url, then to the arguments as JSON, then to nothing", () => {
    expect(askInputSummary({ url: "https://example.com/docs" })).toBe("https://example.com/docs");
    expect(askInputSummary({ file_path: "/tmp/notes.md" })).toBe('{"file_path":"/tmp/notes.md"}');
    expect(askInputSummary({})).toBeUndefined();
    expect(askInputSummary(undefined)).toBeUndefined();
    expect(askInputSummary(["ls"])).toBeUndefined();
  });

  it("redacts a key in a url", () => {
    expect(askInputSummary({ url: `https://h/?api_key=${"k".repeat(24)}` })).toBe("https://h/?api_key=«redacted 24 chars»");
  });
});
