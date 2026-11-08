import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

it.skipIf(process.platform === "win32")("exposes a bot's nested skill files to a filesystem-capable fake CLI without running its script", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-skill-runtime-"));
  const calls = join(scratch, "calls.json"), log = join(scratch, "shell.jsonl"), marker = join(scratch, "executed");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_RUN_BASH: "1", FAKE_CLAUDE_TOOL_CALLS_FILE: calls, FAKE_CLAUDE_SHELL_LOG: log });
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value: any = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Folder fixture", useDefaults: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).bot;
    const script = `#!/bin/sh\nprintf ran > ${marker}\n`;
    await api("POST", `/api/bots/${bot.id}/skill-template`, {
      name: "folder-fixture", description: "Read fixture files.", source: "fixture", enabled: true, warnings: [],
      text: "---\nname: folder-fixture\ndescription: Read fixture files.\n---\nRead references/deep/guide.md.\n",
      files: [
        { path: "references/deep/guide.md", content: "nested fixture guide\n" },
        { path: "assets/sample.bin", binary: { base64: "AP8B" } },
        { path: "scripts/run.sh", content: script, executable: true },
      ],
    });
    const root = ".claude/skills/folder-fixture";
    writeFileSync(calls, JSON.stringify([
      { name: "Bash", input: { command: `/bin/cat ${root}/references/deep/guide.md` } },
      { name: "Bash", input: { command: `/usr/bin/od -An -t x1 ${root}/assets/sample.bin` } },
      { name: "Bash", input: { command: `/bin/cat ${root}/scripts/run.sh` } },
    ]));
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Read the fixture files." });
    await expect.poll(() => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0, { timeout: 15_000 }).toBe(3);
    const results = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(results[0].output).toContain("nested fixture guide");
    expect(results[1].output).toMatch(/00 ff 01/);
    expect(results[2].output).toContain("#!/bin/sh");
    expect(existsSync(marker)).toBe(false);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
