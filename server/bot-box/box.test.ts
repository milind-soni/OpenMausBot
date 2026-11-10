import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BotBox, BoxRunner, BOX_EGRESS_PORT, flyApiPrivate, writeSeccompFile } from "./box.ts";
import { processStart, seesProcess } from "./box-probe.ts";
import { procHidepid } from "./hidepid.ts";
import { visibleInBox } from "./plan.ts";
import { DENIED_SYSCALLS, seccompBytes, seccompSupported } from "./seccomp.ts";
import { engineInstallRoots, npmEnginesPrefix } from "../engine-roots.ts";
import { spawnCli } from "../procs.ts";
import { waitForExit } from "../procs.ts";

const bridge = { socat: "/usr/bin/socat", bridgeScript: "/app/dist-server/bot-box/box-bridge.js", node: "/usr/local/bin/node" };

describe("BoxRunner.wrap", () => {
  const setup = { dataDir: "/data/.openmausbot", home: "/data", codeRoots: ["/app"], engineRoots: engineInstallRoots("/data/.openmausbot"), bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: "/data/.openmausbot/box/egress.sock" }, { name: "harness", port: 8799, socket: "/data/.openmausbot/box/harness.sock" }] };

  // An engine installed in the app's npm prefix: the absolute path the driver resolved, or the bare name looked up on the
  // PATH it was handed (the prefix's bin first), both read through the bin link's relative target.
  it.skipIf(process.platform === "win32")("an engine OpenMausBot installed runs inside: its path, the bin folder on PATH and the package the link points at are there, read-only", () => {
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set() });
    const bin = join(npmEnginesPrefix(setup.dataDir), "bin");
    const target = join(bin, "..", "lib", "node_modules", "opencode-ai", "bin", "opencode.exe");
    for (const command of [join(bin, "opencode"), "opencode"]) {
      const wrapped = runner.wrap({ command, args: ["acp"], cwd: "/data/.openmausbot/task-workspaces/b1/t1", env: { PATH: `${bin}:/usr/local/bin:/usr/bin`, HOME: "/data" } });
      const inner = wrapped.args.slice(wrapped.args.indexOf("--") + 1);
      expect(inner.slice(-2)).toEqual([command, "acp"]);
      expect(wrapped.env.PATH!.split(":")[0]).toBe(bin);
      const resolved = command.startsWith("/") ? command : join(wrapped.env.PATH!.split(":").find((dir) => visibleInBox(wrapped.plan, dir) !== "none")!, command);
      expect(resolved).toBe(join(bin, "opencode"));
      expect(visibleInBox(wrapped.plan, resolved)).toBe("ro");
      expect(visibleInBox(wrapped.plan, target)).toBe("ro");
    }
  });

  it("runs the engine under bwrap with the plan, the allow-listed environment and the proxy pointed at the gate", () => {
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(["COMPOSIO_API_KEY"]) });
    const wrapped = runner.wrap({
      command: "/usr/local/bin/claude", args: ["-p", "--output-format", "stream-json"], cwd: "/data/.openmausbot/task-workspaces/b1/t1",
      env: { PATH: "/usr/bin", HOME: "/data", ANTHROPIC_API_KEY: "k", COMPOSIO_API_KEY: "c", OMB_CLOUD_BOOTSTRAP_SECRET: "s", RANDOM_SECRET: "r" },
    });
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.args.slice(0, 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
    const separator = wrapped.args.indexOf("--");
    expect(wrapped.args.slice(separator + 1, separator + 3)).toEqual(["/bin/sh", "-c"]);
    expect(wrapped.args.slice(-4)).toEqual(["/usr/local/bin/claude", "-p", "--output-format", "stream-json"]);
    expect(wrapped.env).toEqual({
      PATH: "/usr/bin", HOME: "/data", ANTHROPIC_API_KEY: "k",
      HTTPS_PROXY: `http://127.0.0.1:${BOX_EGRESS_PORT}`, HTTP_PROXY: `http://127.0.0.1:${BOX_EGRESS_PORT}`, https_proxy: `http://127.0.0.1:${BOX_EGRESS_PORT}`, http_proxy: `http://127.0.0.1:${BOX_EGRESS_PORT}`,
      NO_PROXY: "127.0.0.1,localhost,::1,[::1]", no_proxy: "127.0.0.1,localhost,::1,[::1]",
    });
    expect(wrapped.plan.botId).toBe("b1");
  });

  it("a shared-network box gets no proxy and no bridge", () => {
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set() });
    const wrapped = runner.wrap({ command: "/opt/chrome", args: ["--headless"], env: { PATH: "/usr/bin" }, net: "shared" });
    expect(wrapped.env).toEqual({ PATH: "/usr/bin" });
    expect(wrapped.args.slice(wrapped.args.indexOf("--") + 1)).toEqual(["/opt/chrome", "--headless"]);
  });

  // The box's paths are POSIX paths inside it, which Windows' path module would write with drive letters and backslashes.
  it.skipIf(process.platform === "win32")("a relay is bound in and dialed by the Node bridge, even where socat bridges the gates; a shared-network box has none", () => {
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set() });
    const relay = "/data/.openmausbot/box/relay-ab12.sock";
    const wrapped = runner.wrap({ command: "/data/.openmausbot/tools/agy", args: ["--uid="], env: { PATH: "/usr/bin" }, relay });
    expect(wrapped.args.join(" ")).toContain(`--bind ${relay} /run/omb/relay.sock`);
    const inner = wrapped.args.slice(wrapped.args.indexOf("--") + 1);
    expect(inner).toEqual([bridge.node, bridge.bridgeScript, "--bridge=3128=/run/omb/egress.sock", "--bridge=8799=/run/omb/harness.sock", "--relay=/run/omb/relay.sock", "--", "/data/.openmausbot/tools/agy", "--uid="]);
    const shared = runner.wrap({ command: "/opt/chrome", args: [], env: {}, net: "shared", relay });
    expect(shared.args).not.toContain(relay);
    expect(shared.args.slice(shared.args.indexOf("--") + 1)).toEqual(["/opt/chrome"]);
  });

  it("the env-all mutation hands over the whole environment (so the self-check can prove the allow-list)", () => {
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup: { ...setup, mutate: new Set(["env-all" as const]) }, denyEnv: new Set() });
    expect(runner.wrap({ command: "x", args: [], env: { OMB_CLOUD_BOOTSTRAP_SECRET: "s", EMPTY: undefined } }).env).toMatchObject({ OMB_CLOUD_BOOTSTRAP_SECRET: "s" });
  });
});

describe("the box's hardening (T0c)", () => {
  it("hands each box the seccomp filter on descriptor 3, and the no-seccomp mutation leaves it out", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-seccomp-"));
    const file = join(dir, "seccomp.bpf");
    writeFileSync(file, seccompBytes());
    const setup = { dataDir: "/data/.openmausbot", home: "/data", codeRoots: ["/app"], engineRoots: [], bridges: [] };
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), seccompFile: file });
    const wrapped = runner.wrap({ command: "/usr/bin/x", args: [], env: {} });
    expect(wrapped.args).toContain("--seccomp");
    expect(wrapped.args[wrapped.args.indexOf("--seccomp") + 1]).toBe("3");
    expect(wrapped.extraFds).toHaveLength(1);
    expect(readFileSync(wrapped.extraFds[0]!)).toEqual(seccompBytes());
    for (const fd of wrapped.extraFds) closeSync(fd);
    const mutated = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup: { ...setup, mutate: new Set(["no-seccomp" as const]) }, denyEnv: new Set(), seccompFile: file });
    const plain = mutated.wrap({ command: "/usr/bin/x", args: [], env: {} });
    expect(plain.args).not.toContain("--seccomp");
    expect(plain.extraFds).toEqual([]);
    const none = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set() }).wrap({ command: "/usr/bin/x", args: [], env: {} });
    expect(none.extraFds).toEqual([]);
    expect(writeSeccompFile(dir)).toBe(seccompSupported() ? file : null);
    expect(DENIED_SYSCALLS.length).toBeGreaterThan(30);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the host's hidepid and Fly's socket folder mode", () => {
    expect(procHidepid(() => "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible 0 0\n")).toBe(true);
    expect(procHidepid(() => "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n")).toBe(true);
    expect(procHidepid(() => "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n")).toBe(false);
    expect(procHidepid(() => { throw new Error("no /proc"); })).toBe(false);
    expect(flyApiPrivate(() => ({ mode: 0o40700 }))).toBe(true);
    expect(flyApiPrivate(() => ({ mode: 0o40755 }))).toBe(false);
    expect(flyApiPrivate(() => { throw new Error("absent"); })).toBe(true);
  });
});

describe("BotBox", () => {
  const dirs: string[] = [];
  const boxes: BotBox[] = [];
  afterEach(async () => {
    for (const box of boxes.splice(0)) await box.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-box-")); dirs.push(dir); return dir; };

  it("off: wraps nothing and reports why", async () => {
    const box = new BotBox();
    boxes.push(box);
    const lines: string[] = [];
    expect((await box.start({ dataDir: temp(), home: temp(), port: 8799, denyEnv: new Set(), env: {}, log: (line) => lines.push(line) })).box).toBe("off");
    expect(box.wrap({ command: "claude", args: [], env: {} })).toBeNull();
    expect(box.report()).toMatchObject({ box: "off", reason: "not-cloud", checks: null, bridge: null, boxed: 0, refused: { egress: 0, harness: 0 }, broker: { on: false, tokens: 0, forwarded: 0, refused: 0, unbrokered: [] }, hardening: { seccomp: "off", denied: 0 } });
    expect(lines).toEqual(["bot box: off (not-cloud)"]);
    expect(existsSync(join(dirs[0]!, "box"))).toBe(false);
  });

  // On, the box's gates listen on unix sockets, which Windows refuses at a file path; the box runs only on a Linux Cloud
  // home (detect.ts says "not-linux" anywhere else), and "off" above is what Windows gets.
  it.skipIf(process.platform === "win32")("on: opens the two gates under the data folder, wraps every spawn and counts them", async () => {
    const box = new BotBox();
    boxes.push(box);
    const dataDir = temp();
    const lines: string[] = [];
    const detection = await box.start({
      dataDir, home: temp(), port: 8799, denyEnv: new Set(), env: {}, log: (line) => lines.push(line),
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: null } }),
    });
    expect(detection.box).toBe("bwrap");
    expect(existsSync(join(dataDir, "box", "egress.sock"))).toBe(true);
    expect(existsSync(join(dataDir, "box", "harness.sock"))).toBe(true);
    expect(existsSync(join(dataDir, "box", "broker.sock"))).toBe(true);
    expect(box.broker()?.port).toBe(18080);
    const wrapped = box.wrap({ command: "/usr/bin/codex", args: ["app-server"], env: { PATH: "/usr/bin" } })!;
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.args).toContain(join(dataDir, "box", "harness.sock"));
    expect(wrapped.args).toContain("/run/omb/harness.sock");
    expect(wrapped.args).toContain("/run/omb/broker.sock");
    expect(box.report()).toMatchObject({ box: "bwrap", bridge: "node", boxed: 1, checks: null, broker: { on: true, tokens: 0 } });
    // A key becomes a token bound to this process; releasing it (the process exit) revokes it.
    const keyed = box.wrap({ command: "/usr/local/bin/claude", args: [], cwd: join(dataDir, "task-workspaces", "b1", "t1"), env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-real", XAI_API_KEY: "xai-real" } })!;
    expect(keyed.token).toMatch(/^omb_t0_[a-f0-9]{48}$/);
    expect(keyed.env.ANTHROPIC_API_KEY).toBe(keyed.token);
    expect(keyed.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:18080/b/${keyed.token}/anthropic`);
    expect(JSON.stringify(keyed.env)).not.toContain("sk-ant-real");
    expect(keyed.unbrokered).toEqual(["XAI_API_KEY"]);
    expect(box.report().broker).toMatchObject({ on: true, tokens: 1, unbrokered: ["XAI_API_KEY"] });
    keyed.release();
    expect(box.report().broker.tokens).toBe(0);
    box.noteChecks({ passed: 20, total: 21, failed: ["egress-public-allowed"], at: 1 });
    expect(box.report().checks).toEqual({ passed: 20, total: 21, failed: ["egress-public-allowed"], at: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^bot box: on \(bubblewrap, node bridges, credential broker, seccomp (on|unsupported here)\)$/);
    const relay = (await box.openRelay())!;
    expect(relay.socketPath.startsWith(join(dataDir, "box", "relay-"))).toBe(true);
    expect(existsSync(relay.socketPath)).toBe(true);
    relay.close();
    expect(existsSync(relay.socketPath)).toBe(false);
  });

  it("off: no relay", async () => {
    const box = new BotBox();
    boxes.push(box);
    await box.start({ dataDir: temp(), home: temp(), port: 8799, denyEnv: new Set(), env: {}, log: () => {} });
    expect(await box.openRelay()).toBeNull();
  });
});

describe("the box a bot's Chrome runs in", () => {
  const boxes: BotBox[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const box of boxes.splice(0)) await box.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-box-")); dirs.push(dir); return dir; };

  it("is no box off a Cloud home, which is what Windows gets", () => {
    expect(new BotBox().browserBox(9, []), "no box off a Cloud home").toBeNull();
  });

  // On, the box's gates listen on unix sockets, which Windows refuses at a file path; the box runs only on a Linux Cloud
  // home (detect.ts says "not-linux" anywhere else).
  it.skipIf(process.platform === "win32")("has the host's network and the read-only paths asked for, and none of HOME or the data folder", async () => {
    const box = new BotBox();
    boxes.push(box);
    const dataDir = join(temp(), "home", ".openmausbot"), home = dirname(dataDir);
    mkdirSync(dataDir, { recursive: true });
    await box.start({ dataDir, home, port: 8799, denyEnv: new Set(), env: {}, log: () => {}, detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: null } }) });
    const uploads = join(dataDir, "browser-uploads");
    const browser = box.browserBox(9, [uploads])!;
    expect(browser.bwrap).toBe("/usr/bin/bwrap");
    const bind = (target: string) => browser.options.some((arg, i) => arg === "--bind" && browser.options[i + 2] === target);
    expect(bind(home), "HOME is not the browser's").toBe(false);
    // The cover stays, and what the browser is given of the data folder comes after it.
    expect(browser.options.indexOf(dataDir), "the data folder is covered").toBe(browser.options.indexOf("--tmpfs", browser.options.indexOf(dataDir) - 1) + 1);
    expect(browser.options.indexOf(uploads)).toBeGreaterThan(browser.options.indexOf(dataDir));
    expect(browser.options.join(" "), "the engines are the turns' only").not.toContain(join(dataDir, "tools"));
    expect(browser.options).not.toContain("--unshare-net");
    expect(browser.options).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid", "--die-with-parent"]));
    expect(browser.options.join(" ")).toContain(`${uploads} ${uploads}`);
    expect(browser.options.slice(browser.options.indexOf(uploads) - 1)[0]).toMatch(/^--ro-bind/u);
    if (browser.seccomp) expect(browser.options.join(" ")).toContain("--seccomp 9");
  });
});

describe("spawnCli goes through the box", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    const { botBox } = await import("./box.ts");
    await botBox.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("a bot spawn runs under the box's command; other spawns and box: false do not", async () => {
    const { botBox } = await import("./box.ts");
    const dir = mkdtempSync(join(tmpdir(), "omb-spawn-"));
    dirs.push(dir);
    // A stand-in for bwrap: records its argv, then runs what follows `--`.
    const fakeBwrap = join(dir, "fake-bwrap.sh"), record = join(dir, "argv.txt");
    writeFileSync(fakeBwrap, `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n`);
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: join(dir, "data"), home: dir, port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      // /usr/bin/true stands in for socat: the shell init starts it, waits once, and execs the engine.
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
    const run = async (owner: "bot" | "openmausbot", box?: false) => {
      rmSync(record, { force: true });
      const child = spawnCli("/bin/sh", ["-c", "echo ran"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: dir, SECRET_THING: "x" }, box }, owner);
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      await waitForExit(child, 10_000);
      return { out: out.trim(), boxed: existsSync(record), argv: existsSync(record) ? readFileSync(record, "utf8") : "" };
    };
    const boxed = await run("bot");
    expect(boxed.boxed).toBe(true);
    expect(boxed.out).toBe("ran");
    expect(boxed.argv).toContain("--unshare-net");
    expect(boxed.argv).toContain("/run/omb/egress.sock");
    const engines = npmEnginesPrefix(join(dir, "data"));
    expect(boxed.argv, "the engines OpenMausBot installed, read-only").toContain(`--ro-bind-try\n${engines}\n${engines}\n`);
    expect((await run("openmausbot")).boxed).toBe(false);
    expect((await run("bot", false)).boxed).toBe(false);
    expect(botBox.report().boxed).toBe(1);
  });
});

describe("BoxRunner.lend", () => {
  // A plan over the Linux box's POSIX paths, which Windows' path module would join with backslashes.
  it.skipIf(process.platform === "win32")("puts a conversation's lent folders (a memory layer) back read-write in its boxes only, until they are taken back", () => {
    const dataDir = "/data/.openmausbot";
    const setup = { dataDir, home: "/data", codeRoots: ["/app"], engineRoots: [], bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: `${dataDir}/box/egress.sock` }, { name: "harness", port: 8799, socket: `${dataDir}/box/harness.sock` }] };
    const runner = new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set() });
    const layer = join(dataDir, "workspaces", "bot-a--member-p_ada");
    const request = { command: "/usr/bin/x", args: [], cwd: join(dataDir, "task-workspaces", "bot-a", "thread-1"), env: { PATH: "/usr/bin", HOME: "/data" } };
    expect(runner.wrap(request).plan.writable).not.toContain(layer);
    runner.lend("bot-a", "thread-1", [layer]);
    expect(runner.wrap(request).plan.writable).toContain(layer);
    // Another conversation of the same bot never gets it.
    expect(runner.wrap({ ...request, cwd: join(dataDir, "task-workspaces", "bot-a", "thread-2") }).plan.writable).not.toContain(layer);
    runner.lend("bot-a", "thread-1", []);
    expect(runner.wrap(request).plan.writable).not.toContain(layer);
    expect(runner.lentTo("bot-a", "thread-1")).toEqual([]);
  });
});

describe("the probe tells the server and the canary from a box process with the same pid", () => {
  // /proc/<pid>/stat as Linux 6.8 writes it; the command may hold spaces and parentheses.
  const stat = (start: string) => `331 (node (MainThread)) S 1 331 331 0 -1 4194560 26085 0 0 0 63 12 0 0 20 0 11 0 ${start} 1270784000 23468 18446744073709551615`;

  it("reads a process's start after its command, however that is spelled", () => {
    expect(processStart(331, () => stat("4321789"))).toBe("4321789");
    expect(processStart(331, () => { throw new Error("ENOENT"); })).toBeNull();
    if (process.platform === "linux") expect(processStart("self")).toMatch(/^\d+$/);
  });

  it("counts a pid as the same process only when it started at the same moment", () => {
    expect(seesProcess(7, "4321789", () => "4321789")).toBe(true);
    expect(seesProcess(7, "4321789", () => "88")).toBe(false);
    expect(seesProcess(7, "4321789", () => null)).toBe(false);
  });
});
