import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRunner } from "./vps-computer.ts";
import { resetPathCache } from "./env-path.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  resetPathCache();
});

async function sshFixture() {
  const bin = mkdtempSync(join(tmpdir(), "omb-ssh-burst-"));
  const sockets = new Set<Socket>();
  const calls: string[][] = [];
  const held: Socket[] = [];
  let warm = false;
  let failInit = false;
  let autoInitialize = false;
  let failCommand = false;
  let entered!: () => void;
  const authenticating = new Promise<void>(resolve => { entered = resolve; });
  const respond = (socket: Socket, code: number) => socket.end(JSON.stringify({ code }));
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.endsWith("\n")) return;
      const args = JSON.parse(input) as string[];
      calls.push(args);
      if (args.includes("check")) { respond(socket, warm ? 0 : 255); return; }
      if (args.at(-1) === "true") {
        if (failInit) respond(socket, 255);
        else if (autoInitialize) { warm = true; respond(socket, 0); }
        else held.push(socket);
      } else respond(socket, !warm || failCommand ? 255 : 0);
      entered();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const sshScript = `#!${process.execPath}
const socket = require('node:net').createConnection(${address.port}, '127.0.0.1');
socket.on('connect', () => socket.write(JSON.stringify(process.argv.slice(2)) + '\\n'));
let reply = '';
socket.on('data', chunk => reply += chunk);
socket.on('end', () => { const { code } = JSON.parse(reply); if (code) console.error('synthetic SSH failure'); else console.log('synthetic daemon'); process.exitCode = code; });
`;
  writeFileSync(join(bin, "ssh"), sshScript, { mode: 0o700 });
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
const args = process.argv.slice(2);
const child = require('node:child_process').spawn('ssh', ['-o', 'ConnectTimeout=30', '-T', '--', args[1].slice(6), 'docker system dial-stdio', ...args.slice(2)], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code; });
`, { mode: 0o700 });
  const home = join(bin, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OMB_EXTRA_PATH", bin);
  resetPathCache();
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(bin, { recursive: true, force: true });
  });
  return {
    calls, authenticating,
    release: () => { warm = true; for (const socket of held.splice(0)) respond(socket, 0); },
    failInitialization: () => { failInit = true; },
    failCommands: () => { failCommand = true; },
    expire: () => { warm = false; failInit = false; autoInitialize = true; },
  };
}

const target = (alias: string, command = "info") => ["-H", `ssh://${alias}`, command];
const commands = (calls: string[][]) => calls.filter(args => args.includes("docker system dial-stdio"));

describe.skipIf(process.platform === "win32")("cold VPS SSH startup", () => {
  it("holds a cold burst behind one authentication before releasing Docker commands", async () => {
    const fixture = await sshFixture();
    const burst = Promise.allSettled(Array.from({ length: 16 }, () => defaultRunner(target("cold-vps"))));
    try {
      await fixture.authenticating;
      expect(commands(fixture.calls)).toHaveLength(0);
    } finally { fixture.release(); await burst; }
    const results = await burst;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(16);
    expect(fixture.calls.filter(args => args.at(-1) === "true")).toHaveLength(1);
    expect(commands(fixture.calls)).toHaveLength(16);
  });

  it("shares initialization failure, releases the slot, and never replays a mutation", async () => {
    const fixture = await sshFixture();
    fixture.failInitialization();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => defaultRunner(target("failed-vps", "run"))));
    expect(results.every(result => result.status === "rejected")).toBe(true);
    for (const result of results) {
      const message = String((result as PromiseRejectedResult).reason?.message);
      expect(message).toContain("synthetic SSH failure");
      expect(message).not.toContain("Command failed");
    }
    expect(commands(fixture.calls)).toHaveLength(0);
    expect(fixture.calls.filter(args => args.at(-1) === "true")).toHaveLength(1);
    fixture.release();
    fixture.failCommands();
    await expect(defaultRunner(target("failed-vps", "run"))).rejects.toThrow("synthetic SSH failure");
    expect(commands(fixture.calls)).toHaveLength(1);
  });

  it("reinitializes after a master expires without keeping a stale success", async () => {
    const fixture = await sshFixture();
    const first = defaultRunner(target("expiring-vps"));
    await fixture.authenticating;
    fixture.release();
    await first;
    fixture.expire();
    await expect(defaultRunner(target("expiring-vps"))).resolves.toMatchObject({ stdout: "synthetic daemon\n" });
    expect(fixture.calls.filter(args => args.at(-1) === "true")).toHaveLength(2);
    expect(commands(fixture.calls)).toHaveLength(2);
  });

  it("does not let a short waiter cancel the shared initialization", async () => {
    const fixture = await sshFixture();
    const first = defaultRunner(target("shared-budget-vps"));
    await fixture.authenticating;
    try {
      await expect(defaultRunner(target("shared-budget-vps"), { timeoutMs: 100 })).rejects.toThrow(/timed out/i);
      expect(commands(fixture.calls)).toHaveLength(0);
    } finally { fixture.release(); await first; }
    expect(fixture.calls.filter(args => args.at(-1) === "true")).toHaveLength(1);
    expect(commands(fixture.calls)).toHaveLength(1);
  });

  it("bounds a stuck initialization without launching Docker", async () => {
    const fixture = await sshFixture();
    await expect(defaultRunner(target("stuck-vps", "run"), { timeoutMs: 1_000 })).rejects.toThrow(/SSH|timed out/i);
    expect(commands(fixture.calls)).toHaveLength(0);
  });

  it("does not let a short first caller cancel initialization for a longer caller", async () => {
    const fixture = await sshFixture();
    const short = defaultRunner(target("short-owner-vps"), { timeoutMs: 1_000 });
    const rejected = expect(short).rejects.toThrow();
    await fixture.authenticating;
    const long = defaultRunner(target("short-owner-vps"), { timeoutMs: 3_000 });
    const longResult = Promise.allSettled([long]);
    try {
      await rejected;
      expect(commands(fixture.calls)).toHaveLength(0);
    } finally { fixture.release(); await longResult; }
    expect(await longResult).toMatchObject([{ status: "fulfilled" }]);
    expect(fixture.calls.filter(args => args.at(-1) === "true")).toHaveLength(1);
    expect(commands(fixture.calls)).toHaveLength(1);
  });
});
