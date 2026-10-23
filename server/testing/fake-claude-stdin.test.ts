import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("decodes a raw prompt whose UTF-8 character spans stdin chunks", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-fake-stdin-"));
  try {
    const prompt = "Produce a checkpoint for continuing the same task.\n日本語の要件 🧪";
    const bytes = Buffer.from(prompt), split = bytes.indexOf(Buffer.from("日")) + 1;
    const preload = join(dir, "stdin.mjs"), dump = join(dir, "dump.json"), settings = join(dir, "settings.json");
    writeFileSync(settings, "{}");
    writeFileSync(preload, `import { Readable } from 'node:stream';
      const parts = ${JSON.stringify([bytes.subarray(0, split).toString("hex"), bytes.subarray(split).toString("hex")])};
      const input = Readable.from((async function* () {
        for (const part of parts) { yield Buffer.from(part, 'hex'); await new Promise(setImmediate); }
      })(), { objectMode: false, highWaterMark: 1 });
      Object.defineProperty(process, 'stdin', { value: input });`);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", preload,
      fileURLToPath(new URL("./fake-claude-cli.ts", import.meta.url)), "--output-format", "stream-json", "--no-session-persistence", "--settings", settings], {
      env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, FAKE_CLAUDE_DUMP: dump }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(dump, "utf8")).prompt).toBe(prompt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
