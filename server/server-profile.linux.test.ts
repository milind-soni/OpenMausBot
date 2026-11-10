// The hardened profile against the real box, where it can run: Linux with an unprivileged bubblewrap. A self-hosted
// server's data folder, a real BotBox started the way the profile starts it (no OMB_BOT_BOX, no Cloud role), and the
// commands a hostile bot would run. Elsewhere the suite says so and skips: CI's Linux runners have no bubblewrap, so
// there the same attacks are run in the built image (.github/workflows/docker.yml, "the hardened profile").
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BotBox } from "./bot-box/box.ts";
import { detectBox } from "./bot-box/detect.ts";
import { OPERATOR_TOKEN_FILE } from "./server-profile.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
const detection = detectBox({ env: ENV, hardened: true });
const SECRET = "sk-ant-OPENMAUSBOT-PROFILE-CANARY";

describe.skipIf(detection.box !== "bwrap")(`the hardened profile in a real box (${detection.box === "bwrap" ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const root = mkdtempSync(join(tmpdir(), "omb-profile-real-"));
  const home = join(root, "home"), dataDir = join(home, ".openmausbot");
  const cwd = join(dataDir, "task-workspaces", "bot-1", "thread-1");
  const serverFiles = ["config.json", "logins.json", "logins.key", "sessions.json", OPERATOR_TOKEN_FILE, join("workspaces", "bot-2", "MEMORY.md")];
  let server: Server, port: number;
  const hardened = new BotBox(), standard = new BotBox();

  beforeAll(async () => {
    for (const dir of [cwd, join(dataDir, "workspaces", "bot-1"), join(dataDir, "workspaces", "bot-2")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of serverFiles) writeFileSync(join(dataDir, file), SECRET, { mode: 0o600 });
    writeFileSync(join(cwd, "notes.md"), "the bot's own notes");
    server = createServer((_req, res) => { res.writeHead(200); res.end(SECRET); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    const options = { dataDir, home, port, env: ENV, denyEnv: new Set<string>(), log: () => {} };
    expect((await hardened.start({ ...options, hardened: true })).box).toBe("bwrap");
    expect((await standard.start(options)).reason).toBe("not-cloud");
  });
  afterAll(async () => {
    await Promise.all([hardened.stop(), standard.stop()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  /** What a bot types in its shell. The server names no file of its own on the command line it starts, and the box
   * shows a file only when that command line does (plan.ts argvPaths), so the path rides inside the script. */
  const shell = (box: BotBox, script: string) => asBot(box, "/bin/sh", ["-c", script]);

  /** Runs a bot's command as the server would: boxed when the box is on, as it is otherwise. */
  function asBot(box: BotBox, command: string, args: string[]): Promise<{ code: number | null; out: string }> {
    const env = { ...ENV, HOME: home };
    const wrapped = box.wrap({ command, args, cwd, env, botId: "bot-1" });
    return new Promise((resolve) => {
      const child = wrapped
        ? spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] })
        : spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      for (const fd of wrapped?.extraFds ?? []) try { closeSync(fd); } catch {}
      let out = "";
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.once("exit", (code) => { wrapped?.release(); resolve({ code, out }); });
    });
  }
  const fetchScript = (path: string) => `fetch("http://127.0.0.1:${port}${path}", { method: "PUT", body: "{}", signal: AbortSignal.timeout(5000) }).then(async (r) => { console.log(r.status, await r.text()); }, (e) => { console.log("unreachable", e.cause?.code ?? e.message); });`;

  it("a bot's process cannot read the server's settings, saved logins, sessions, operator token or another bot's memory", async () => {
    for (const file of serverFiles) {
      const read = await shell(hardened, `cat '${join(dataDir, file)}'`);
      expect(read.code, file).not.toBe(0);
      expect(read.out, file).not.toContain(SECRET);
    }
    const listed = await shell(hardened, `ls -A '${dataDir}'; grep -rl ${SECRET} '${home}' 2>/dev/null; true`);
    expect(listed.out).not.toContain("config.json");
    expect(listed.out).not.toContain(SECRET);
    expect((await shell(hardened, "cat notes.md")).out).toBe("the bot's own notes");
  }, 60_000);

  it("reads every one of them on the same server without the profile", async () => {
    for (const file of serverFiles) expect((await shell(standard, `cat '${join(dataDir, file)}'`)).out, file).toBe(SECRET);
  }, 60_000);

  it("a bot's process reaches nothing of the server over loopback but the harness routes", async () => {
    const settings = await asBot(hardened, process.execPath, ["-e", fetchScript("/api/config")]);
    expect(settings.out).toMatch(/^403 /);
    expect(settings.out).not.toContain(SECRET);
    const guarded = await asBot(hardened, process.execPath, ["-e", fetchScript("/api/bots/bot-1/messages/guarded")]);
    expect(guarded.out).toMatch(/^403 /);
    expect((await asBot(hardened, process.execPath, ["-e", fetchScript("/api/internal/hook")])).out).toContain(`200 ${SECRET}`);
    expect(hardened.report().refused.harness).toBe(2);
  }, 60_000);

  it("reaches all of it on the same server without the profile", async () => {
    expect((await asBot(standard, process.execPath, ["-e", fetchScript("/api/config")])).out).toContain(`200 ${SECRET}`);
  }, 60_000);
});
