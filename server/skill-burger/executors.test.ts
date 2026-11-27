import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appFrame, createExecutors, shellQuote } from "./executors.ts";
import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { startRun } from "./runner.ts";

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

  it("opens a page with the browser's own open tool", async () => {
    const sent: unknown[] = [];
    const exec = createExecutors({ botId: "b", cwd: folder(), internal: async (kind, path, body) => { sent.push([kind, path, body]); return { ok: true, body: { result: { content: [{ type: "text", text: "Opened example.com" }] } } }; } });
    expect(await exec.browser({ url: "https://example.com/pricing", signal: signal() })).toEqual({ ok: true, output: "Opened example.com" });
    expect(sent).toEqual([["browser", "/api/internal/browser/mcp", expect.objectContaining({ method: "tools/call", params: { name: "agent_browser_open", arguments: { url: "https://example.com/pricing" } } })]]);
  });

  it("writes a file only inside the conversation's folder", async () => {
    const cwd = folder();
    const outside = folder();
    try {
      const exec = createExecutors({ botId: "b", cwd, internal: async () => ({ ok: false, body: {} }) });
      expect(await exec.file({ path: "notes/a.md", content: "hi", signal: signal() })).toMatchObject({ ok: true });
      expect(readFileSync(join(cwd, "notes/a.md"), "utf8")).toBe("hi");
      expect(await exec.file({ path: "..leading.md", content: "ok", signal: signal() })).toMatchObject({ ok: true });
      expect(await exec.file({ path: "../escape.md", content: "x", signal: signal() })).toMatchObject({ ok: false });

      symlinkSync(outside, join(cwd, "out"), process.platform === "win32" ? "junction" : "dir");
      expect(await exec.file({ path: "out/escape.md", content: "x", signal: signal() })).toMatchObject({ ok: false });
      expect(existsSync(join(outside, "escape.md"))).toBe(false);
      expect(await exec.file({ path: "out/nested/escape.md", content: "x", signal: signal() })).toMatchObject({ ok: false });
      expect(existsSync(join(outside, "nested"))).toBe(false);

      const outsideFile = join(outside, "secret.md");
      writeFileSync(outsideFile, "keep");
      let fileLinked = false;
      try {
        symlinkSync(outsideFile, join(cwd, "linked.md"), "file");
        fileLinked = true;
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      if (fileLinked) {
        expect(await exec.file({ path: "linked.md", content: "overwritten", signal: signal() })).toMatchObject({ ok: false });
        expect(readFileSync(outsideFile, "utf8")).toBe("keep");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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

  it.skipIf(process.platform === "win32").each([
    {
      name: "the CSV header and every appended row",
      commands: [
        "printf 'name,score\\n' > report.csv", "printf 'Ada,10\\n' >> report.csv",
        "printf 'Bob,20\\n' >> report.csv", "cp report.csv backup.csv",
      ],
      expected: { "report.csv": "name,score\nAda,10\nBob,20\n", "backup.csv": "name,score\nAda,10\nBob,20\n" },
    },
    {
      name: "the last overwrite of a file",
      commands: ["printf draft > report.csv", "printf corrected > report.csv", "cp report.csv final.csv"],
      expected: { "report.csv": "corrected", "final.csv": "corrected" },
    },
  ])("replays $name", async ({ commands, expected }) => {
    const cwd = folder();
    try {
      const messages: RunMessage[] = [
        { id: "ask", role: "user", kind: "text", text: "Prepare the reports" },
        ...commands.map((command, index) => ({
          id: `m${index}`, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: JSON.stringify({ command }) },
        })),
      ];
      const draft = draftWorkflow(messages)!;
      const result = await startRun({ name: "reports", botId: "b", threadId: "t", sha256: "test", workflow: draft.workflow }, {
        exec: createExecutors({ botId: "b", cwd, internal: async () => ({ ok: false, body: {} }) }),
        events: { started() {}, ended() {} }, save() {},
      });
      expect(result).toMatchObject({ ok: true, status: "ok" });
      for (const [name, content] of Object.entries(expected)) {
        expect(readFileSync(join(cwd, name), "utf8")).toBe(content);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
