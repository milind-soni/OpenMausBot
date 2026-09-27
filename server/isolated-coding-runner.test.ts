import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codingCommand } from "./isolated-coding-runner.ts";

it.skipIf(process.platform !== "linux")("runs the real supervisor with persistent projects, minimal secrets and revocable process groups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nation-coding-runner-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
root = pathlib.Path.cwd()
assert 'OPENROUTER_API_KEY' not in os.environ
assert 'DAYTONA_API_KEY' not in os.environ
assert sys.argv[sys.argv.index('--sandbox') + 1] == 'workspace-write'
prompt = sys.stdin.read()
if 'WAIT_FOR_STOP' in prompt:
    child = subprocess.Popen(['sleep', '60'])
    (root / 'child.pid').write_text(str(child.pid))
    time.sleep(60)
if 'SAVE_VALUE' in prompt: (root / 'project.txt').write_text('PERSISTENT_VALUE')
answer = pathlib.Path(sys.argv[sys.argv.index('--output-last-message') + 1])
answer.write_text((root / 'project.txt').read_text() + ' ' + os.environ['NATION_TASK_TOKEN'])
`, { mode: 0o700 });
  let active = true;
  const token = "a".repeat(64);
  const lease = createServer((req, res) => { res.writeHead(active && req.headers.authorization === `Bearer ${token}` ? 200 : 403); res.end(); });
  await new Promise<void>(resolve => lease.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(lease.address() as { port: number }).port}`;
  const start = (id: string, prompt: string) => {
    const child = spawn("sh", ["-c", codingCommand({ id, prompt, project: "project", model: "openai/fixture", token, url, expires: Date.now() + 30_000 })], {
      env: { PATH: bin + ':' + process.env.PATH, HOME: dir, OPENROUTER_API_KEY: "MUST_NOT_LEAK", DAYTONA_API_KEY: "MUST_NOT_LEAK" },
    });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    return new Promise<any>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    });
  };
  try {
    expect(await start("one", "SAVE_VALUE")).toMatchObject({ status: "completed", text: "PERSISTENT_VALUE [redacted]" });
    expect(await start("two", "Read existing work")).toMatchObject({ status: "completed", text: "PERSISTENT_VALUE [redacted]" });
    const pending = start("three", "WAIT_FOR_STOP");
    const pidFile = join(dir, ".nation-coding/project/child.pid");
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    active = false;
    expect(await pending).toMatchObject({ status: "cancelled" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => {
      try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z"; } catch { return true; }
    }).toBe(true);
    expect(readFileSync(join(dir, ".nation-coding/project/project.txt"), "utf8")).toBe("PERSISTENT_VALUE");
  } finally {
    active = false;
    await new Promise<void>(resolve => lease.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
