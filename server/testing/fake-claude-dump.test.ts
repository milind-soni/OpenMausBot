import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";

it.each(["stream", "text", "text-fallback"])("%s capture stays complete while another process writes it", async (mode) => {
  const home = mkdtempSync(join(tmpdir(), "omb-claude-dump-"));
  const dump = join(home, "capture.json");
  const writing = join(home, "writing");
  const release = join(home, "release");
  const preload = join(home, "slow-write.mjs");
  const old = { prompt: "previous complete turn" };
  writeFileSync(dump, JSON.stringify(old));
  // Hold a real subprocess halfway through its capture write. Reading the
  // destination must still return the previous complete JSON, not a fragment.
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, data, ...args) => {
      if (typeof path !== 'string' || !path.startsWith(${JSON.stringify(dump)})) return write(path, data, ...args);
      const text = String(data), middle = Math.floor(text.length / 2);
      write(path, text.slice(0, middle), ...args);
      write(${JSON.stringify(writing)}, 'ready');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(${JSON.stringify(release)})) {
        if (Date.now() > deadline) throw new Error('capture test was not released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      write(path, text.slice(middle), { flag: 'a' });
    };
    syncBuiltinESMExports();
  `);
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [
      "--import", pathToFileURL(preload).href,
      fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url)),
      "--output-format", mode === "stream" ? "stream-json" : "text",
    ], {
      cwd: home,
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_EXIT_AFTER_TURN: "1",
        FAKE_CLAUDE_DUMP: dump,
        FAKE_CLAUDE_TEXT_DUMP: mode === "text" ? dump : undefined,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout!.resume();
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const prompt = "new complete turn";
    child.stdin!.end(mode === "stream"
      ? JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n"
      : prompt);
    await expect.poll(() => existsSync(writing), { timeout: 10_000 }).toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual(old);
    writeFileSync(release, "go");
    await expect.poll(() => child!.exitCode, { timeout: 10_000 }).not.toBeNull();
    expect(child.exitCode, stderr).toBe(0);
    expect(stderr).not.toContain("Error:");
    const captured = JSON.parse(readFileSync(dump, "utf8"));
    expect(mode === "stream" ? captured.prompt.message.content : captured.prompt).toBe(prompt);
    expect(readdirSync(home).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally {
    writeFileSync(release, "go");
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
});

it("keeps the server's connection check out of every turn and one-shot capture, logging it on its own", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-claude-dump-"));
  const dump = join(home, "capture.json");
  const textDump = join(home, "text.json");
  const textLog = join(home, "text.jsonl");
  const checkLog = join(home, "checks.jsonl");
  const check = async (extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url)), "-p", "--output-format", "text"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_TEXT_DUMP: textDump,
        FAKE_CLAUDE_TEXT_LOG: textLog, FAKE_CLAUDE_CHECK_LOG: checkLog, FAKE_CLAUDE_TEXT_FILE: join(home, "missing"), ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stdin!.end("This is a connection check. Reply with the single word OK.");
    await waitForExit(child);
    return { code: child.exitCode, stdout };
  };
  try {
    expect(await check()).toEqual({ code: 0, stdout: "OK" });
    expect(await check({ FAKE_CLAUDE_CHECK: "fail" })).toEqual({ code: 1, stdout: "" });
    for (const file of [dump, textDump, textLog]) expect(existsSync(file), file).toBe(false);
    expect(readFileSync(checkLog, "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    await removeTempDir(home);
  }
});

it("keeps a new bot's setup answers out of every turn and one-shot capture, failing at once without a reply file, and holds the reply back on request", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-claude-dump-"));
  const dump = join(home, "capture.json");
  const textDump = join(home, "text.json");
  const textLog = join(home, "text.jsonl");
  const setupDump = join(home, "setup.json");
  const setupFile = join(home, "setup.txt");
  const prompt = "You write the answer options for the first message of a new bot in OpenMausBot.";
  const ask = async (extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url)), "-p", "--output-format", "text"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_TEXT_DUMP: textDump,
        FAKE_CLAUDE_TEXT_LOG: textLog, FAKE_CLAUDE_TEXT_FILE: join(home, "missing"), FAKE_CLAUDE_SETUP_DUMP: setupDump, FAKE_CLAUDE_SETUP_FILE: setupFile, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stdin!.end(prompt);
    await waitForExit(child);
    return { code: child.exitCode, stdout };
  };
  try {
    expect(await ask()).toEqual({ code: 1, stdout: "" });
    writeFileSync(setupFile, '["Sort my receipts"]');
    expect(await ask()).toEqual({ code: 0, stdout: '["Sort my receipts"]' });
    for (const file of [dump, textDump, textLog]) expect(existsSync(file), file).toBe(false);
    expect(JSON.parse(readFileSync(setupDump, "utf8")).prompt).toBe(prompt);
    const started = Date.now();
    expect(await ask({ FAKE_CLAUDE_SETUP_DELAY_MS: "1500" })).toEqual({ code: 0, stdout: '["Sort my receipts"]' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  } finally {
    await removeTempDir(home);
  }
});
