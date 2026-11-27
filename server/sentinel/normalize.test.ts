import { describe, expect, it } from "vitest";

import { failureKey, HARNESS_NOTICE, isToolIdentifier, normalizeSignatureText, signatureOf, toolOrigin } from "./normalize.ts";

describe("sentinel signatures", () => {
  it("folds errors that differ only in values into one signature", () => {
    expect(normalizeSignatureText("no layer 90")).toBe(normalizeSignatureText("no layer 104"));
    expect(normalizeSignatureText("no layer 12")).toBe("no layer <n>");
    expect(normalizeSignatureText("ENOENT: no such file, open '/path/to/project/a.txt'")).toBe(normalizeSignatureText("ENOENT: no such file, open '/elsewhere/b.txt'"));
    expect(normalizeSignatureText("cannot read /path/to/project/notes.md: denied")).toBe("cannot read <path>: denied");
    expect(normalizeSignatureText("C:\\work\\file.txt is locked")).toBe("<path> is locked");
    expect(normalizeSignatureText('unknown client "Example Co"')).toBe("unknown client <q>");
    expect(normalizeSignatureText("thread 3f2b9c1e-0a4d-4c2e-9b1f-7d6e5c4b3a21 is gone")).toBe("thread <id> is gone");
    expect(normalizeSignatureText("commit 9f2c4e1ab07d failed")).toBe("commit <id> failed");
    expect(normalizeSignatureText("call tu-4821-7 timed out after 30.5 s")).toBe("call <id> timed out after <n> s");
    expect(normalizeSignatureText("see https://example.com/a?b=1 or mail someone@example.com")).toBe("see <url> or mail <email>");
    // an apostrophe is not a quote, and the words around it stay
    expect(normalizeSignatureText("can't reach the room,   it's busy")).toBe("can't reach the room, it's busy");
    expect(normalizeSignatureText("x".repeat(1000)).length).toBe(240);
  });

  it("groups shell failures by exit code and error class, not by what they printed", () => {
    const timeouts = [
      "Command timed out after 2m 0.0s",
      "Error: command timed out after 120000ms\n/path/to/project/build.sh: still running",
      "Exit code 124\ntimeout: sending signal TERM to command 'npm test'",
      "exec_command failed: timed out waiting for process 4821",
    ].map((text) => failureKey("Bash", text));
    expect(new Set(timeouts.map((failure) => failure.key)).size).toBe(1);
    expect(timeouts[0]!.title).toBe("timed out");

    const notFound = failureKey("Bash", "Exit code 127\n/bin/sh: ffprobe: command not found");
    expect(notFound).toEqual({ key: "127\ncommand not found", title: "exit 127: command not found" });
    expect(failureKey("Bash", "Exit code 127\nzsh: command not found: jq").key).toBe(notFound.key);
    expect(failureKey("exec_command", "exit status 2\nls: /path/to/x: No such file or directory").title).toBe("exit 2: no such file");
    expect(failureKey("Bash", "Exit code 1\nsomething broke in a way nobody predicted").title).toBe("exit 1");
    expect(failureKey("Bash", "Exit code 1\nsomething else entirely").key).toBe(failureKey("Bash", "Exit code 1\nsomething broke").key);
    expect(failureKey("Bash", "Exit code 2\nsomething broke").key).not.toBe(failureKey("Bash", "Exit code 1\nsomething broke").key);
    expect(failureKey("Bash", "").title).toBe("failed");
    expect(failureKey("Bash", `Exit code ${"9".repeat(300)}\ncommand not found`).title.length).toBe(160);
  });

  it("keeps the whole normalized error, capped, for every other tool", () => {
    expect(failureKey("mcp__agents__send", 'no layer 90 for "Example Co" in /path/to/project')).toEqual({ key: "no layer <n> for <q> in <path>", title: "no layer <n> for <q> in <path>" });
    expect(failureKey("Read", "x ".repeat(200)).title.length).toBeLessThanOrEqual(160);
  });

  it("hashes the normalized parts, so the signature never holds the text", () => {
    const sig = signatureOf("tool_error", "mcp__agents__send", "no client named <q>");
    expect(sig).toMatch(/^tool_error:[0-9a-f]{16}$/);
    expect(signatureOf("tool_error", "Bash", "no client named <q>")).not.toBe(sig);
    expect(signatureOf("tool_error", "mcp__agents__send", "no client named <q>")).toBe(sig);
  });

  it("ranks OpenMausBot's own tools as harness, shells as shell, everything else as external", () => {
    expect(toolOrigin("mcp__agents__coordinate_bots")).toBe("harness");
    expect(toolOrigin("mcp__computer__screenshot")).toBe("harness");
    expect(toolOrigin(HARNESS_NOTICE)).toBe("harness");
    expect(toolOrigin("Bash")).toBe("shell");
    expect(toolOrigin("exec_command")).toBe("shell");
    expect(toolOrigin("mcp__linear__create_issue")).toBe("external");
    expect(toolOrigin("Read")).toBe("external");
  });

  it("tells a tool identifier from a sentence the harness wrote", () => {
    expect(isToolIdentifier("mcp__agents__send")).toBe(true);
    expect(isToolIdentifier("Bash")).toBe(true);
    expect(isToolIdentifier("Probe's room turn exceeded 20 minutes and was stopped")).toBe(false);
  });
});
