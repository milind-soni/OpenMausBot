// The real box, where it can run (Linux with an unprivileged bubblewrap): what a path on a command line, or in a
// configured server's environment, shows of the data folder. Elsewhere the suite says so and skips.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BotBox } from "./box.ts";
import { detectBox } from "./detect.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", OMB_BOT_BOX: "1" };
const detection = detectBox({ env: ENV });
const CANARY = "OPENMAUSBOT-COMMAND-LINE-CANARY";

describe.skipIf(detection.box !== "bwrap")(`paths on a boxed command line (${detection.box === "bwrap" ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const root = mkdtempSync(join(tmpdir(), "omb-argv-real-"));
  const home = join(root, "home"), dataDir = join(home, ".openmausbot"), cwd = join(dataDir, "task-workspaces", "bot-1", "thread-1");
  const settings = join(dataDir, "config.json"), handed = join(dataDir, "hook-tokens", "t", "token"), outside = join(root, "turn", "mcp.json");
  const box = new BotBox();
  beforeAll(async () => {
    for (const dir of [cwd, join(dataDir, "workspaces", "bot-1"), join(dataDir, "workspaces", "bot-2"), join(dataDir, "hook-tokens", "t"), join(root, "turn")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of [settings, join(dataDir, "messages.db"), join(dataDir, "workspaces", "bot-2", "MEMORY.md")]) writeFileSync(file, CANARY, { mode: 0o600 });
    writeFileSync(handed, "a file the server hands this turn");
    writeFileSync(outside, "the turn's own config");
    expect((await box.start({ dataDir, home, port: 1, env: ENV, denyEnv: new Set(), log: () => {} })).box).toBe("bwrap");
  });
  afterAll(async () => { await box.stop(); rmSync(root, { recursive: true, force: true }); });

  function run(args: string[], extra: { env?: Record<string, string>; configured?: boolean; ro?: string[] } = {}): Promise<{ code: number | null; out: string }> {
    const wrapped = box.wrap({ command: "/bin/sh", args, cwd, env: { ...ENV, HOME: home, ...extra.env }, botId: "bot-1", ...(extra.ro ? { ro: extra.ro } : {}), ...(extra.configured ? { configured: true, allowEnv: Object.keys(extra.env ?? {}) } : {}) })!;
    return new Promise((resolve) => {
      const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] });
      for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
      let out = "";
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.once("exit", (code) => { wrapped.release(); resolve({ code, out }); });
    });
  }
  const cat = 'for path in "$@"; do cat "${path#--model=}" 2>&1; done';

  it("shows nothing of the data folder for a path named there, in it or above it", async () => {
    for (const args of [[settings], [join(dataDir, "messages.db")], [`--model=${settings}`], [dataDir, settings], [join(dataDir, ".."), settings], [join(dataDir, "workspaces", "bot-2", "MEMORY.md")]]) {
      expect((await run(["-c", cat, "sh", ...args])).out, args.join(" ")).not.toContain(CANARY);
    }
  }, 60_000);

  it("still shows a file outside the data folder that the command line names, and one inside it that the caller names", async () => {
    expect((await run(["-c", cat, "sh", outside])).out).toBe("the turn's own config");
    expect((await run(["-c", cat, "sh", handed], { ro: [join(dataDir, "hook-tokens", "t")] })).out).toBe("a file the server hands this turn");
  }, 60_000);

  it("still runs a configured server whose program is in the bot's own folder, with the bot known or not", async () => {
    const program = join(dataDir, "workspaces", "bot-1", "tools", "server.sh");
    mkdirSync(join(dataDir, "workspaces", "bot-1", "tools"), { recursive: true });
    writeFileSync(program, "echo \"the bot's own server ran\"\n");
    expect((await run([program], { configured: true })).out).toBe("the bot's own server ran\n");
    const unknown = box.wrap({ command: "/bin/sh", args: [program], env: { ...ENV, HOME: home }, configured: true })!;
    const out = await new Promise<string>((resolve) => {
      const child = spawn(unknown.command, unknown.args, { env: unknown.env, stdio: ["ignore", "pipe", "pipe", ...unknown.extraFds] });
      for (const fd of unknown.extraFds) try { closeSync(fd); } catch {}
      let text = "";
      child.stdout?.on("data", (chunk) => { text += chunk; });
      child.stderr?.on("data", (chunk) => { text += chunk; });
      child.once("exit", () => { unknown.release(); resolve(text); });
    });
    expect(out).toBe("the bot's own server ran\n");
  }, 60_000);

  it("makes nothing of the data folder readable or writable through a configured server's environment", async () => {
    for (const name of ["XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
      for (const value of [dataDir, settings, join(dataDir, "workspaces", "bot-2")]) {
        const tried = await run(["-c", `${cat}; echo x >> '${settings}'`, "sh", settings, join(dataDir, "workspaces", "bot-2", "MEMORY.md")], { env: { [name]: value }, configured: true });
        expect(tried.out, `${name}=${value}`).not.toContain(CANARY);
      }
    }
    expect(readFileSync(settings, "utf8")).toBe(CANARY);
  }, 120_000);
});
