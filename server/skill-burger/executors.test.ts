import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appFrame, createExecutors, shellQuote } from "./executors.ts";

const folder = () => mkdtempSync(join(tmpdir(), "burger-exec-"));
const signal = () => new AbortController().signal;

describe("where a Skill Burger's steps run", () => {
  it("sends an app action through the one multi-execute tool, and a plain app tool by its own name", () => {
    expect(appFrame("GMAIL_SEND_EMAIL", { to: "a" }, "acct-1", 7).frame).toEqual({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a" }, account: "acct-1" }] } },
    });
    expect(appFrame("gmail.search_emails", { query: "invoice" }, undefined, 8).slug).toMatch(/^GMAIL_/);
  });

  it("writes a file only inside the conversation's folder", async () => {
    const cwd = folder();
    const exec = createExecutors({ botId: "b", cwd, internal: async () => ({ ok: false, body: {} }) });
    expect(await exec.file({ path: "notes/a.md", content: "hi", signal: signal() })).toMatchObject({ ok: true });
    expect(readFileSync(join(cwd, "notes/a.md"), "utf8")).toBe("hi");
    expect(await exec.file({ path: "../escape.md", content: "x", signal: signal() })).toMatchObject({ ok: false });
    symlinkSync(tmpdir(), join(cwd, "out"));
    expect(await exec.file({ path: "out/escape.md", content: "x", signal: signal() })).toMatchObject({ ok: false });
  });

  it.skipIf(process.platform === "win32")("runs a command as the bot, reading its inputs from OMB_ARG_ variables, and stops one that says too much", async () => {
    const cwd = folder();
    const exec = createExecutors({ botId: "b", cwd, internal: async () => ({ ok: false, body: {} }) });
    const value = "it's $(rm -rf /) `x`";
    const ran = await exec.shell({ command: 'printf %s "$OMB_ARG_NOTE"', env: { OMB_ARG_NOTE: value }, where: "bot", tool: "shell", signal: signal(), maxBytes: 1_000 });
    expect(ran).toEqual({ ok: true, output: value });
    expect(await exec.shell({ command: "exit 3", env: {}, where: "bot", tool: "shell", signal: signal(), maxBytes: 1_000 })).toMatchObject({ ok: false });
    expect(await exec.shell({ command: "yes | head -c 5000", env: {}, where: "bot", tool: "shell", signal: signal(), maxBytes: 1_000 })).toMatchObject({ ok: false, tooLarge: true });
    expect(shellQuote(value)).toBe(`'it'\\''s $(rm -rf /) \`x\`'`);
  });
});
