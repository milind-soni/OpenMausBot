// API regressions boot the real harness against a private HOME and data dir.
// Every cua/container command goes to the fixture below, never an installed CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { recordCuaSpaceOwnership, cuaSpaceOwnership } from "./cua-space-ownership.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
type Os = "linux" | "macos";
type Backend = "container" | "cua-spaces";
type Mode = "shared" | "per-bot" | "pool";
const CommandSchema = z.object({ kind: z.enum(["cua", "docker", "podman", "container"]), args: z.array(z.string()) });
type Command = z.infer<typeof CommandSchema>;
type Reply = { stdout?: string; stderr?: string; code?: number };
type Bot = { id: string; name: string; threadId: string; vmOs?: Os; busy?: boolean };
type ErrorBody = { error: string };
type Status = {
  backend: Backend;
  installed?: boolean;
  managed: boolean;
  ready: boolean;
  container: "missing" | "running" | "stopped";
  problem: string | null;
  os?: Os;
  space_name?: string;
  target_key: string;
};
type Inventory = {
  backend: Backend;
  available: boolean;
  problem: string | null;
  instances: Array<{ botId: string; os?: Os; managed: boolean; ready: boolean; problem: string | null }>;
};
type Config = { localVm: { backend: Backend; mode: Mode; spacesOs: Os } };
type FakeSpace = { name: string; state: string; status: string; added_at: string };
type FakeContainer = { name: string; managed: boolean; targetLabel: string; workspace: string };
type ApiResponse<T> = { status: number; body: T; cache: string | null };

type FixtureOptions = { backend?: Backend; mode?: Mode; spacesOs?: Os; missingCli?: boolean };
type CommandGate = {
  kind: Command["kind"];
  prefix: string[];
  entered: Promise<void>;
  release: () => void;
  enter: () => void;
  wait: Promise<void>;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function commandGate(kind: Command["kind"], prefix: string[]): CommandGate {
  const entered = deferred();
  const release = deferred();
  return {
    kind, prefix, entered: entered.promise, release: release.resolve,
    enter: entered.resolve, wait: release.promise,
  };
}

const ClaudeDump = z.object({
  mcpConfig: z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() }).optional(),
});

/** Watch before checking, then re-check on file events: no readiness sleeps.
 * The test deadline owns failure timing; fixture shutdown closes this watcher. */
function readDumpWhenWritten(file: string, signal: AbortSignal): Promise<z.infer<typeof ClaudeDump>> {
  const { promise, resolve, reject } = deferred<z.infer<typeof ClaudeDump>>();
  const watcher = watch(dirname(file), { signal }, () => check());
  const onAbort = () => {
    watcher.close();
    reject(new Error(`fixture stopped before fake Claude wrote ${file}`));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (!existsSync(file)) return;
    let parsed: z.infer<typeof ClaudeDump>;
    try { parsed = ClaudeDump.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return; }
    signal.removeEventListener("abort", onAbort);
    watcher.close();
    resolve(parsed);
  };
  check();
  return promise;
}

class CuaApiFixture {
  readonly home = mkdtempSync(join(tmpdir(), "omb-cua-api-"));
  readonly dataDir = join(this.home, "data");
  readonly dump = join(this.home, "claude-dump.json");
  readonly calls: Command[] = [];
  readonly spaces = new Map<string, FakeSpace>();
  readonly containers = new Map<string, FakeContainer>();
  readonly gates: CommandGate[] = [];
  readonly shutdown = new AbortController();
  readonly bin = join(this.home, "bin");
  readonly cli = join(this.bin, "fake-cua-cli.ts");
  readonly commands: Server;
  child?: ChildProcess;
  base = "";
  commandUrl = "";
  port = 0;
  missingCli = false;
  /** Cua installed but its daemon not answering: every listing fails. */
  listingDown = false;

  constructor(options: FixtureOptions = {}) {
    this.missingCli = options.missingCli ?? false;
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    copyFileSync(join(SERVER_DIR, "testing", "fake-cua-cli.ts"), this.cli);
    chmodSync(this.cli, 0o755);
    const staticDir = join(this.home, "static");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Cua API fixture</title>");
    writeFileSync(join(this.dataDir, "config.json"), JSON.stringify({
      features: { browser: false, llmThreadTitles: false },
      localVm: {
        backend: options.backend ?? "cua-spaces", mode: options.mode ?? "per-bot",
        spacesOs: options.spacesOs ?? "linux", maxInstances: 8,
      },
      instances: {
        claude: {
          driver: "claudeAgent", displayName: "Fixture Claude",
          config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") },
        },
      },
    }));
    // Shadow every host runtime, including ones discovery probes but does not
    // select. Only the fake Docker daemon reports healthy; none reaches a VM.
    for (const kind of ["docker", "podman", "container"] as const) {
      const program = join(this.bin, `${kind}-fixture.mjs`);
      writeFileSync(program, [
        'const response = await fetch(process.env.FAKE_CUA_API, { method: "POST",',
        'headers: { "content-type": "application/json" },',
        `body: JSON.stringify({ kind: ${JSON.stringify(kind)}, args: process.argv.slice(2) }) });`,
        'const reply = await response.json();',
        'if (reply.stdout) process.stdout.write(reply.stdout);',
        'if (reply.stderr) process.stderr.write(reply.stderr);',
        'process.exitCode = reply.code ?? 0;',
      ].join("\n"));
      if (process.platform === "win32") {
        writeFileSync(join(this.bin, `${kind}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${kind}-fixture.mjs" %*\r\n`);
      } else {
        writeFileSync(join(this.bin, kind), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`, { mode: 0o755 });
      }
    }
    this.commands = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const command = CommandSchema.parse(JSON.parse(raw));
        this.calls.push(command);
        const gate = this.gates.find((candidate) => candidate.kind === command.kind && candidate.prefix.every((arg, index) => command.args[index] === arg));
        if (gate) { gate.enter(); await gate.wait; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.reply(command)));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  reply({ kind, args }: Command): Reply {
    const json = (value: unknown): Reply => ({ stdout: JSON.stringify(value) });
    const absent = { code: 1, stderr: "fixture resource not found\n" };
    if (kind !== "cua") {
      if (kind !== "docker") return { code: 127, stderr: "fixture runtime unavailable\n" };
      if (args[0] === "info") return { stdout: "29\n" };
      if (args[0] === "inspect") {
        const container = this.containers.get(args[1]);
        if (!container) return absent;
        return json([{
          Config: { Image: "fixture", Labels: container.managed ? {
            "com.openmausbot.local-vm": "1", "com.openmausbot.workspace": "1",
            "com.openmausbot.local-vm-target": container.targetLabel,
          } : {} },
          State: { Running: false },
          Mounts: [{ Type: "bind", Source: container.workspace, Destination: "/home/cua/workspace", RW: true }],
        }]);
      }
      if (args[0] === "rm") {
        const name = args[args.length - 1];
        if (name) this.containers.delete(name);
        return json({});
      }
      return absent;
    }
    if (args[0] === "--version") return { stdout: "cua 0.2.0\n" };
    if (args[0] === "daemon" && args[1] === "status") return json({ pid: 123 });
    if (args[0] === "sb" && args[1] === "ls") {
      if (this.listingDown) return { code: 1, stderr: "daemon: connection refused\n" };
      return json([...this.spaces.values()].map((space) => ({ ...space, kind: "container", location: "local" })));
    }
    if (args[0] === "spaces" && args[1] === "ls") {
      return json({ spaces: [...this.spaces.values()].map((space) => ({ id: `local:${space.name}`, added_at: space.added_at })) });
    }
    if (args[0] === "spaces" && args[1] === "create") {
      const name = args[args.indexOf("--name") + 1];
      if (!name || this.spaces.has(name)) return { code: 1, stderr: "fixture name collision\n" };
      const space = this.seedSpace(name, false);
      return json({ spaces: [{ id: `local:${name}`, added_at: space.added_at }] });
    }
    const name = args[2]?.replace(/^local:/, "");
    if (args[0] === "spaces" && args[1] === "rm") return json({});
    const space = name ? this.spaces.get(name) : undefined;
    if (!space) return absent;
    if (args[0] === "sb" && args[1] === "rm") { this.spaces.delete(space.name); return json({}); }
    if (args[0] === "spaces" && args[1] === "add") return json({});
    if (args[0] === "spaces" && (args[1] === "start" || args[1] === "stop")) {
      space.state = args[1] === "start" ? "running" : "stopped";
      space.status = args[1] === "start" ? "ready" : "stopped";
      return json({});
    }
    if (args[0] === "sb" && args[1] === "view") {
      return json({ url: "http://127.0.0.1:32123/view?ticket=fixture-ticket", expires_at_unix: 2_000_000_000 });
    }
    throw new Error(`unexpected fake cua command: ${args.join(" ")}`);
  }

  seedSpace(name: string, owned = true): FakeSpace {
    const space = { name, state: "running", status: "ready", added_at: "2026-01-01T00:00:00Z" };
    this.spaces.set(name, space);
    if (owned) recordCuaSpaceOwnership(name, this.dataDir, space.added_at);
    return space;
  }

  target(bot: Bot) {
    const digest = createHash("sha256").update(bot.id).digest("hex");
    const short = digest.slice(0, 16);
    return { name: `openmausbot-computer-${short}`, workspace: join(this.dataDir, "vm-homes", short), digest };
  }

  gate(prefix: string[], kind: Command["kind"] = "cua") {
    const gate = commandGate(kind, prefix);
    this.gates.push(gate);
    return gate;
  }

  async start(): Promise<void> {
    const listening = deferred();
    this.commands.once("error", listening.reject);
    this.commands.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    this.commands.off("error", listening.reject);
    const address = this.commands.address();
    if (!address || typeof address === "string") throw new Error("command fixture did not bind a TCP port");
    this.commandUrl = `http://127.0.0.1:${address.port}`;
    this.port = await freePortBlock([0, 1], 28_000, 5_000);
    this.base = `http://127.0.0.1:${this.port}`;
    await this.launch();
  }

  async launch(): Promise<void> {
    const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: this.home, USERPROFILE: this.home, OMB_DATA_DIR: this.dataDir,
        OMB_PORT: String(this.port), OMB_WEBHOOK_PORT: String(this.port + 1),
        OMB_EXTRA_PATH: this.bin, OMB_STATIC_DIR: join(this.home, "static"),
        OMB_CUA_CLI: this.missingCli ? join(this.bin, "missing-cua") : this.cli,
        FAKE_CUA_API: this.commandUrl, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: this.dump,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const listening = deferred();
    let stdout = "";
    let stderr = "";
    const finish = (error?: Error) => {
      child.stdout?.off("data", onStdout);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) listening.reject(error); else listening.resolve();
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(`openmausbot server on ${this.base}`)) finish();
    };
    const onExit = (code: number | null) => finish(new Error(`isolated Cua server exited ${String(code)}\n${stderr}`));
    const onError = (error: Error) => finish(error);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("exit", onExit);
    child.once("error", onError);
    await listening.promise;
    const health = await this.api<{ app: string; pid: number }>("GET", "/api/health");
    expect(health).toMatchObject({ status: 200, body: { app: "openmausbot", pid: child.pid } });
  }

  async api<T = ErrorBody>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const response = await fetch(`${this.base}${path}`, {
      method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as T, cache: response.headers.get("cache-control") };
  }

  async bot(body: Record<string, unknown> = {}): Promise<Bot> {
    const { vmOs = "linux", ...settings } = body;
    const response = await this.api<{ bot: Bot }>("POST", "/api/bots", {
      name: "Cua fixture", settings: { computer: "vm", ...settings },
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    // vmOs is the bot PATCH contract, not a New bot template field.
    const patched = await this.api<{ bot: Bot }>("PATCH", `/api/bots/${response.body.bot.id}`, { vmOs });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return patched.body.bot;
  }

  async create(bot: Bot): Promise<Status> {
    const response = await this.api<Status>("POST", `/api/bots/${bot.id}/local-computer/run`, {});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ backend: "cua-spaces", managed: true, ready: true, os: "linux" });
    return response.body;
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    for (const gate of this.gates) gate.release();
    await waitForExit(this.child, { signal: "SIGTERM" });
    this.commands.closeAllConnections();
    const closed = deferred();
    this.commands.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    rmSync(this.home, { recursive: true, force: true });
  }
}

let fixture: CuaApiFixture | undefined;
async function isolated(options: FixtureOptions = {}): Promise<CuaApiFixture> {
  fixture = new CuaApiFixture(options);
  await fixture.start();
  return fixture;
}

afterEach(async () => { await fixture?.close(); fixture = undefined; }, 30_000);

async function interrupt(f: CuaApiFixture, bot: Bot): Promise<void> {
  const stream = await openSse(`${f.base}/api/events`);
  try {
    expect((await f.api("POST", `/api/bots/${bot.id}/interrupt`, {})).status).toBe(200);
    await stream.until((frame: unknown) => {
      const event = frame as { kind?: string; bot?: Bot };
      return event.kind === "bot" && event.bot?.id === bot.id && event.bot.busy === false;
    });
  } finally { stream.close(); }
}

async function expectTargetChangesRefused(f: CuaApiFixture, bot: Bot): Promise<void> {
  for (const localVm of [{ backend: "container" }, { spacesOs: "linux" }]) {
    const response = await f.api("PATCH", "/api/config", { localVm });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/stop Local VM turns and setup actions/i);
  }
  const changedOs = await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: null });
  expect(changedOs.status).toBe(409);
  expect(changedOs.body.error).toMatch(/Local VM|computer|stop/i);
  const bots = await f.api<{ bots: Bot[] }>("GET", "/api/bots?messages=0");
  expect(bots.body.bots.find((entry) => entry.id === bot.id)?.vmOs).toBe("linux");
  expect((await f.api<Config>("GET", "/api/config")).body.localVm).toMatchObject({ backend: "cua-spaces", spacesOs: "macos" });
}

describe("Cua Spaces real server API", () => {
  it("hands a viewer ticket only to loopback, not an authenticated remote owner", async () => {
    const f = await isolated();
    const bot = await f.bot();
    await f.create(bot);
    const pairing = await f.api<{ code: string }>("POST", "/api/auth/pairing", {});
    expect(pairing.status).toBe(200);
    const paired = await f.api<{ token: string }>("POST", "/api/auth/pair", { code: pairing.body.code });
    expect(paired.status).toBe(200);
    const remote = { authorization: `Bearer ${paired.body.token}`, "x-forwarded-for": "192.0.2.10" };
    expect((await f.api("GET", "/api/config", undefined, remote)).status).toBe(200);
    const before = f.calls.length;
    const denied = await f.api("POST", `/api/bots/${bot.id}/local-computer/viewer`, {}, remote);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/computer that runs it/i);
    expect(f.calls.slice(before).some(({ args }) => args[0] === "sb" && args[1] === "view")).toBe(false);
    const viewer = await f.api<{ url: string; expiresAt: number }>("POST", `/api/bots/${bot.id}/local-computer/viewer`, {});
    expect(viewer).toMatchObject({ status: 200, cache: "private, no-store", body: {
      url: "http://127.0.0.1:32123/view?ticket=fixture-ticket", expiresAt: 2_000_000_000_000,
    } });
  }, 30_000);

  it("validates and persists a bot's vmOs and clears it back to the default", async () => {
    const f = await isolated();
    const bot = await f.bot();
    for (const vmOs of ["windows", "", "Linux", 1, false, {}, []]) {
      const invalid = await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("vmOs");
    }
    if (!(process.platform === "darwin" && process.arch === "arm64")) {
      const unsupported = await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: "macos" });
      expect(unsupported).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Apple silicon/i) } });
    } else {
      expect((await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: "macos" })).status).toBe(200);
      expect((await f.api<Status>("GET", `/api/bots/${bot.id}/local-computer`)).body.os).toBe("macos");
    }
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: "linux" })).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(f.dataDir, "bots.json"), "utf8")) as Bot[];
    expect(saved.find((entry) => entry.id === bot.id)?.vmOs).toBe("linux");
    expect((await f.api<{ bot: Bot }>("PATCH", `/api/bots/${bot.id}`, { vmOs: null })).body.bot.vmOs).toBeUndefined();
    expect((await f.api<Status>("GET", `/api/bots/${bot.id}/local-computer`)).body.os).toBe("linux");
  }, 30_000);

  it("fences backend, default OS and bot OS changes throughout a Space create", async () => {
    const f = await isolated({ spacesOs: "macos" });
    const bot = await f.bot();
    const gate = f.gate(["spaces", "create"]);
    const creating = f.api<Status>("POST", `/api/bots/${bot.id}/local-computer/run`, {});
    try {
      await gate.entered;
      await expectTargetChangesRefused(f, bot);
      const beforeRename = f.calls.length;
      expect((await f.api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed during create" })).status).toBe(200);
      expect(f.calls.slice(beforeRename).some(({ args }) => args[0] === "spaces" && args[1] === "add")).toBe(false);
      expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/remove`, {})).status).toBe(409);
      expect((await f.api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
    } finally { gate.release(); await creating; }
    expect((await creating).body.ready).toBe(true);
    expect((await f.api("PATCH", "/api/config", { localVm: { spacesOs: "linux" } })).status).toBe(200);
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: null })).status).toBe(200);
  }, 30_000);

  it("serializes managed relabels with lifecycle and target changes", async () => {
    const f = await isolated({ spacesOs: "macos" });
    const bot = await f.bot();
    await f.create(bot);
    const gate = f.gate(["spaces", "add"]);
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { name: "New label" })).status).toBe(200);
    await gate.entered;
    await expectTargetChangesRefused(f, bot);
    expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/stop`, {})).status).toBe(409);
    expect((await f.api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
    gate.release();
  }, 30_000);

  it("refuses backend, default OS and bot OS switches during an active Local VM turn", async () => {
    const f = await isolated({ spacesOs: "macos" });
    const bot = await f.bot();
    await f.create(bot);
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "Hold this Local VM" })).status).toBe(202);
    const dump = await readDumpWhenWritten(f.dump, f.shutdown.signal);
    expect(dump.mcpConfig?.mcpServers?.computer).toBeDefined();
    await expectTargetChangesRefused(f, bot);
    expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/remove`, {})).status).toBe(409);
    await interrupt(f, bot);
    expect((await f.api("PATCH", "/api/config", { localVm: { spacesOs: "linux" } })).status).toBe(200);
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: null })).status).toBe(200);
    expect((await f.api("PATCH", "/api/config", { localVm: { backend: "container" } })).status).toBe(200);
  }, 30_000);

  it("refuses bot OS changes while a config target switch is awaiting Cua", async () => {
    const f = await isolated({ backend: "container", spacesOs: "macos" });
    const bot = await f.bot();
    const gate = f.gate(["daemon", "status"]);
    const changing = f.api("PATCH", "/api/config", { localVm: { backend: "cua-spaces" } });
    try {
      await gate.entered;
      const changedOs = await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: null });
      expect(changedOs.status).toBe(409);
      expect(changedOs.body.error).toMatch(/Local VM|settings|computer/i);
    } finally { gate.release(); await changing; }
    expect((await changing).status).toBe(200);
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { vmOs: null })).status).toBe(200);
  }, 30_000);

  it("addresses removal by OS without deleting the bot's other Space", async () => {
    const f = await isolated();
    const bot = await f.bot();
    const target = f.target(bot);
    f.seedSpace(`${target.name}-macos`);
    await f.create(bot);
    for (const [action, os] of [["run", "linux"], ["start", "linux"], ["stop", "linux"], ["remove", "windows"]]) {
      expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/${action}`, { os })).status).toBe(400);
    }
    const before = f.calls.length;
    const removed = await f.api<Status>("POST", `/api/bots/${bot.id}/local-computer/remove`, { os: "macos" });
    expect(removed).toMatchObject({ status: 200, body: { os: "macos", container: "missing" } });
    expect(f.calls.slice(before)).toContainEqual({ kind: "cua", args: ["sb", "rm", `local:${target.name}-macos`, "--force", "--json"] });
    expect(f.calls.slice(before)).toContainEqual({ kind: "cua", args: ["spaces", "rm", `local:${target.name}-macos`, "--json"] });
    expect(cuaSpaceOwnership(`${target.name}-macos`, f.dataDir)).toBeNull();
    expect((await f.api<Status>("GET", `/api/bots/${bot.id}/local-computer`)).body).toMatchObject({ os: "linux", ready: true });
    const inventory = await f.api<Inventory>("GET", "/api/local-computer/instances");
    expect(inventory).toMatchObject({ status: 200, cache: "private, no-store", body: { backend: "cua-spaces", available: true } });
    expect(inventory.body.instances).toContainEqual(expect.objectContaining({ botId: bot.id, os: "linux", managed: true, ready: true }));
    expect(inventory.body.instances.some((entry) => entry.os === "macos")).toBe(false);
    expect(JSON.stringify(inventory.body)).not.toMatch(/ticket|viewer_url|workspace_path|space_name|target_key/);
  }, 30_000);

  it("forgets a deleted Space so Auto cannot silently recreate it", async () => {
    const f = await isolated();
    const bot = await f.bot();
    await f.create(bot);
    expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/remove`, {})).status).toBe(200);
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { computer: null })).status).toBe(200);
    const before = f.calls.length;
    expect((await f.api("POST", `/api/bots/${bot.id}/messages`, { text: "Work without provisioning a desktop" })).status).toBe(202);
    const dump = await readDumpWhenWritten(f.dump, f.shutdown.signal);
    expect(dump.mcpConfig?.mcpServers?.computer).toBeUndefined();
    expect(f.calls.slice(before).some(({ args }) => args[0] === "spaces" && args[1] === "create")).toBe(false);
    expect(f.spaces.size).toBe(0);
    await interrupt(f, bot);
  }, 30_000);

  it("reports an exact-name collision as unmanaged and never views, relabels or removes it", async () => {
    const f = await isolated();
    const bot = await f.bot();
    const name = `${f.target(bot).name}-linux`;
    f.seedSpace(name, false);
    // A no-op removal of the absent shared target invalidates the real
    // adapter's list cache without a time wait or a process-global test hook.
    expect((await f.api("POST", "/api/local-computer/remove", {})).status).toBe(200);
    const status = await f.api<Status>("GET", `/api/bots/${bot.id}/local-computer`);
    expect(status.body).toMatchObject({ container: "running", managed: false, ready: false });
    expect(status.body.problem).toMatch(/did not create/i);
    const inventory = await f.api<Inventory>("GET", "/api/local-computer/instances");
    expect(inventory.body).toMatchObject({ backend: "cua-spaces", available: true });
    expect(inventory.body.instances).toContainEqual(expect.objectContaining({ botId: bot.id, os: "linux", managed: false, ready: false, problem: status.body.problem }));
    const before = f.calls.length;
    expect((await f.api("PATCH", `/api/bots/${bot.id}`, { name: "Not its Space" })).status).toBe(200);
    expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/viewer`, {})).status).toBe(409);
    expect((await f.api("POST", `/api/bots/${bot.id}/local-computer/remove`, {})).status).toBe(409);
    expect(f.calls.slice(before).some(({ args }) => (args[0] === "spaces" && args[1] === "add") || (args[0] === "sb" && ["rm", "view"].includes(args[1])))).toBe(false);
    expect(f.spaces.has(name)).toBe(true);
  }, 30_000);

  it("reports the configured backend and denies capacity when the explicit cua CLI is missing", async () => {
    const f = await isolated({ missingCli: true });
    const bot = await f.bot();
    const availability = await f.api<{ installed: boolean; daemonUp: boolean; problem: string }>("GET", "/api/local-computer/cua-spaces");
    expect(availability).toMatchObject({ status: 200, body: { installed: false, daemonUp: false } });
    expect(availability.body.problem).toMatch(/Install Cua Spaces/i);
    const inventory = await f.api<Inventory>("GET", "/api/local-computer/instances");
    expect(inventory.body).toMatchObject({ backend: "cua-spaces", available: false, instances: [] });
    expect(inventory.body.problem).toMatch(/Install Cua Spaces/i);
    const status = await f.api<Status>("GET", `/api/bots/${bot.id}/local-computer`);
    expect(status.body).toMatchObject({ backend: "cua-spaces", installed: false, ready: false, container: "missing" });
    const creating = await f.api("POST", `/api/bots/${bot.id}/local-computer/run`, {});
    expect(creating.status).toBe(409);
    expect(creating.body.error).toMatch(/Install Cua Spaces/i);
    expect(f.calls.some(({ kind }) => kind === "cua")).toBe(false);
    expect((await f.api("PATCH", "/api/config", { localVm: { backend: "container" } })).status).toBe(200);
    expect((await f.api<Inventory>("GET", "/api/local-computer/instances")).body.backend).toBe("container");
  }, 30_000);

  it.each([
    { backend: "container" as const, mode: "shared" as const },
    { backend: "cua-spaces" as const, mode: "pool" as const },
  ])("deletes both owned OS Spaces and the container workspace with $backend/$mode configured", async (options) => {
    // Initial bot creation may relabel asynchronously on the Spaces backend.
    // Seed old resources with that backend off, then select the requested
    // backend, so this cleanup test cannot race an unrelated initial relabel.
    const f = await isolated({ ...options, backend: "container" });
    const owned = await f.bot({ computer: "off" });
    const unmanaged = await f.bot({ computer: "off" });
    const missing = await f.bot({ computer: "off" });
    const target = f.target(owned);
    mkdirSync(target.workspace, { recursive: true });
    writeFileSync(join(target.workspace, "saved.txt"), "owned workspace data");
    f.containers.set(target.name, { name: target.name, managed: true, targetLabel: target.digest, workspace: target.workspace });
    for (const os of ["linux", "macos"] as const) f.seedSpace(`${target.name}-${os}`);
    const foreign = f.target(unmanaged);
    f.containers.set(foreign.name, { name: foreign.name, managed: false, targetLabel: foreign.digest, workspace: foreign.workspace });
    f.seedSpace(`${foreign.name}-linux`, false);
    // Switch after seeding, then refresh the adapter cache through a real
    // lifecycle command while the shared target is absent.
    expect((await f.api("PATCH", "/api/config", { localVm: { backend: "cua-spaces" } })).status).toBe(200);
    expect((await f.api("POST", "/api/local-computer/remove", {})).status).toBe(200);
    if (options.backend === "container") {
      expect((await f.api("PATCH", "/api/config", { localVm: { backend: "container" } })).status).toBe(200);
    }
    const before = f.calls.length;
    const removed = await f.api("DELETE", `/api/bots/${owned.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(existsSync(target.workspace)).toBe(false);
    expect(f.containers.has(target.name)).toBe(false);
    for (const os of ["linux", "macos"] as const) {
      const name = `${target.name}-${os}`;
      expect(f.spaces.has(name)).toBe(false);
      expect(cuaSpaceOwnership(name, f.dataDir)).toBeNull();
      expect(f.calls.slice(before)).toContainEqual({ kind: "cua", args: ["sb", "rm", `local:${name}`, "--force", "--json"] });
      expect(f.calls.slice(before)).toContainEqual({ kind: "cua", args: ["spaces", "rm", `local:${name}`, "--json"] });
    }
    expect(f.calls.slice(before)).toContainEqual({ kind: "docker", args: ["rm", "-f", target.name] });
    const beforeSkipped = f.calls.length;
    const refusedForeignContainer = await f.api("DELETE", `/api/bots/${unmanaged.id}`);
    expect(refusedForeignContainer.status, JSON.stringify(refusedForeignContainer.body)).toBe(409);
    expect(refusedForeignContainer.body.error).toMatch(/container.*not created/i);
    expect(f.containers.has(foreign.name)).toBe(true);
    // The existing container safety contract requires external removal.
    // Afterwards bot cleanup must still leave the unmanaged Space alone.
    f.containers.delete(foreign.name);
    expect((await f.api("DELETE", `/api/bots/${unmanaged.id}`)).status).toBe(200);
    expect((await f.api("DELETE", `/api/bots/${missing.id}`)).status).toBe(200);
    const skipped = f.calls.slice(beforeSkipped);
    expect(skipped.some(({ args }) => args[0] === "rm" || args[1] === "rm")).toBe(false);
    expect(f.spaces.has(`${foreign.name}-linux`)).toBe(true);
    const bots = await f.api<{ bots: Bot[] }>("GET", "/api/bots?messages=0");
    expect(bots.body.bots.some((bot) => [owned.id, unmanaged.id, missing.id].includes(bot.id))).toBe(false);
  }, 30_000);

  it("deletes a bot that owns no Space without asking a Cua whose daemon is down", async () => {
    const f = await isolated({ backend: "container" });
    const bot = await f.bot({ computer: "off" });
    f.listingDown = true;
    const before = f.calls.length;
    const removed = await f.api("DELETE", `/api/bots/${bot.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(f.calls.slice(before).some(({ kind }) => kind === "cua")).toBe(false);
  }, 30_000);
});
