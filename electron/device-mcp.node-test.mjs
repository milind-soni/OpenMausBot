import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { commandFingerprint } from "./lent-mcp.mjs";
import { createMcpDoor, shownCommand } from "./device-mcp.mjs";

const until = async (check, what, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

// A regression should fail a test, not hang the file.
const bounded = (promise, what, ms = 2000) => Promise.race([promise, delay(ms, undefined, { ref: false }).then(() => assert.fail(`timed out waiting for ${what}`))]);

const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } };
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// A stdio MCP stand-in: says it is ready with the saved env it got, echoes stdin to stdout, writes to stderr before
// each echo, and exits when stdin ends. With "tree" it first starts a grandchild that never exits on its own.
const CHILD = `
const { spawn } = require("node:child_process");
if (process.argv.includes("tree")) process.stdout.write("grandchild " + spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid + "\\n");
process.stdout.write("ready " + (process.env.MCP_TEST_FLAG ?? "") + "\\n");
process.stdin.on("data", (data) => { process.stderr.write("stderr-secret\\n"); process.stdout.write(data); });
process.stdin.on("end", () => process.exit(0));
`;

/** A door over definitions held in memory (what My Cloud serves), approvals kept in memory, and a prompt that waits until
 * the test answers it. Every child it spawns, and every grandchild a child reports, is killed by its exact PID. */
async function setup(t, definitions = {}, { saved = {}, ...options } = {}) {
  const approvals = { read: () => saved, write: (next) => { saved = next; } };
  const asks = [];
  const prompt = (ask) => new Promise((answer) => asks.push({ ...ask, answer }));
  const spawned = [];
  const pids = [];
  const fetched = [];
  const door = createMcpDoor({
    approvals, prompt,
    ownPorts: async () => [],
    definition: async (name) => { fetched.push(name); return Object.hasOwn(definitions, name) ? definitions[name] : null; },
    environment: async () => ({ PATH: process.env.PATH, FROM_APP: "inherited" }),
    home: tmpdir(),
    spawn: (...args) => { const child = spawn(...args); spawned.push(child); if (child.pid) pids.push(child.pid); return child; },
    ...options,
  });
  t.after(() => {
    door.close();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  });
  return { door, asks, spawned, pids, fetched, saved: () => saved };
}

async function echoServer(t) {
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.pipe(socket); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server.address().port;
}

const collect = (socket) => {
  const got = { text: "" };
  socket.on("data", (data) => { got.text += data; });
  return got;
};

const answered = () => new Promise((resolve) => setImmediate(resolve));

const echoEntry = (...extra) => ({ command: process.execPath, args: ["-e", CHILD, ...extra], env: { MCP_TEST_FLAG: "saved-env" } });
const approved = (entry) => ({ kind: "command", fingerprint: commandFingerprint(entry) });
const frame = (name, entry) => ({ name, fingerprint: commandFingerprint(entry) });

test("a command target is spawned once approved; the prompt shows the command only, and stdout comes back, stderr never", async (t) => {
  const entry = { command: process.execPath, args: ["-e", CHILD, "--", "--token", "hunter2"], env: { MCP_TEST_FLAG: "saved-env", SECRET_KEY: "env-secret-value" } };
  const { door, asks, spawned, fetched, saved } = await setup(t, { echo: entry });
  assert.deepEqual(await door.open(frame("echo", entry)), { refused: "needs-approval" });
  assert.equal(spawned.length, 0);
  assert.deepEqual(fetched, ["echo"]);
  assert.deepEqual(asks.map(({ name, target }) => ({ name, target })), [{ name: "echo", target: { kind: "command", command: shownCommand(entry.command, entry.args), env: ["MCP_TEST_FLAG", "SECRET_KEY"] } }]);
  const shown = JSON.stringify(asks[0].target);
  assert.ok(!shown.includes("hunter2") && !shown.includes("env-secret-value"), "no secret, no env");
  asks[0].answer(true);
  await answered();
  assert.deepEqual(saved(), { echo: approved(entry) });

  const { socket } = await door.open(frame("echo", entry));
  assert.ok(socket, "opened");
  const got = collect(socket);
  await until(() => got.text.includes("ready saved-env\n"), "the child's first line");
  socket.write("{\"jsonrpc\":\"2.0\",\"id\":1}\n");
  await until(() => got.text.includes("{\"jsonrpc\":\"2.0\",\"id\":1}\n"), "the echoed line");
  assert.equal(got.text, "ready saved-env\n{\"jsonrpc\":\"2.0\",\"id\":1}\n");
});

test("the child gets the app's inherited environment with the saved env on top, and its stderr is ignored", async (t) => {
  const entry = { command: process.execPath, args: ["-e", "process.stdout.write(`${process.env.FROM_APP}|${process.env.OVERRIDE}|${process.env.MCP_TEST_FLAG}\\n`); setInterval(() => {}, 1000)"], env: { OVERRIDE: "saved", MCP_TEST_FLAG: "x" } };
  const seen = [];
  const { door, spawned } = await setup(t, { env: entry }, {
    saved: { env: approved(entry) },
    environment: async () => ({ PATH: process.env.PATH, FROM_APP: "inherited", OVERRIDE: "app" }),
    spawn: (...args) => { seen.push(args[2]); const child = spawn(...args); spawned.push(child); return child; },
  });
  const { socket } = await door.open(frame("env", entry));
  const got = collect(socket);
  await until(() => got.text === "inherited|saved|x\n", "the child's environment");
  assert.equal(seen[0].stdio[2], "ignore", "stderr is never read");
  assert.equal(seen[0].detached, true);
  assert.equal(seen[0].cwd, tmpdir());
});

test("a URL target: a bad or own port is bad-port; unapproved shows the prompt once and refuses needs-approval; after Allow the next open connects", async (t) => {
  const port = await echoServer(t);
  const { door, asks, saved } = await setup(t, {}, { ownPorts: async () => [8799] });
  assert.deepEqual(await door.open({ name: "x", port: 8799 }), { failed: "bad-port" });
  for (const bad of [80, 1023, 65536, 8080.5, "8080", null]) assert.deepEqual(await door.open({ name: "x", port: bad }), { failed: "bad-port" }, String(bad));
  assert.deepEqual(asks, []);

  assert.deepEqual(await bounded(door.open({ name: "native", port }), "open to answer without the prompt"), { refused: "needs-approval" });
  assert.deepEqual(await door.open({ name: "native", port }), { refused: "needs-approval" });
  assert.deepEqual(asks.map(({ name, target }) => ({ name, target })), [{ name: "native", target: { kind: "url", port } }]);
  asks[0].answer(true);
  await answered();
  assert.deepEqual(saved(), { native: { kind: "url", port } });

  const { socket } = await door.open({ name: "native", port });
  assert.ok(socket, "opened");
  t.after(() => socket.destroy());
  const got = collect(socket);
  socket.write("ping\n");
  await until(() => got.text === "ping\n", "the echo");
  assert.equal(asks.length, 1);
});

test("a changed definition under an old approval asks again and runs nothing", async (t) => {
  const old = echoEntry();
  const changed = { ...old, args: [...old.args, "--more"] };
  const { door, asks, spawned } = await setup(t, { echo: changed }, { saved: { echo: approved(old) } });
  assert.deepEqual(await door.open(frame("echo", changed)), { refused: "needs-approval" });
  assert.deepEqual(asks.map(({ name, target }) => ({ name, target })), [{ name: "echo", target: { kind: "command", command: shownCommand(changed.command, changed.args), env: ["MCP_TEST_FLAG"] } }]);
  assert.equal(spawned.length, 0);
  asks[0].answer(false);
  await answered();

  // My Cloud's frame still carries the old fingerprint while it now serves another definition.
  const second = await setup(t, { echo: changed }, { saved: { echo: approved(old) } });
  assert.deepEqual(await second.door.open(frame("echo", old)), { failed: "changed" });
  assert.deepEqual(second.asks, []);
  assert.equal(second.spawned.length, 0);
  assert.deepEqual(await second.door.open({ name: "gone", fingerprint: commandFingerprint(old) }), { failed: "no-server" }, "no definition");
});

test("a changed env value under an old approval asks again and spawns nothing", async (t) => {
  const old = echoEntry();
  const changed = { ...old, env: { MCP_TEST_FLAG: "other-value" } };
  const { door, asks, spawned } = await setup(t, { echo: changed }, { saved: { echo: approved(old) } });
  assert.deepEqual(await door.open(frame("echo", changed)), { refused: "needs-approval" });
  assert.equal(asks.length, 1);
  assert.equal(spawned.length, 0);
});

test("a no holds ten minutes per name and per target; the prompt shows again after declineMs", async (t) => {
  let clock = 1_000_000;
  const { door, asks, saved } = await setup(t, {}, { now: () => clock });
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" });
  asks[0].answer(false);
  await answered();
  assert.deepEqual(saved(), {}, "a no is not stored");
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "declined" });
  assert.deepEqual(await door.open({ name: "other", port: 19501 }), { refused: "declined" }, "the same port under another name");
  assert.deepEqual(await door.open({ name: "native", port: 19502 }), { refused: "declined" }, "the same name on another port");
  clock += 599_999;
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "declined" });
  assert.equal(asks.length, 1);
  clock += 1;
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" });
  assert.equal(asks.length, 2);
});

test("an answer that lands after close() is dropped: no Allow is kept and no No holds", async (t) => {
  const { door, asks, saved } = await setup(t);
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" });
  door.close();
  asks[0].answer(true);
  await answered();
  assert.deepEqual(saved(), {});
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" });
  door.close();
  asks[1].answer(false);
  await answered();
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" }, "asked again, not held");
  assert.equal(asks.length, 3);
});

test("a no for a command holds for the same command under another name; a different command asks", async (t) => {
  const { door, asks } = await setup(t, { echo: echoEntry(), copy: echoEntry(), other: echoEntry("tree") });
  assert.deepEqual(await door.open(frame("echo", echoEntry())), { refused: "needs-approval" });
  asks[0].answer(false);
  await answered();
  assert.deepEqual(await door.open(frame("copy", echoEntry())), { refused: "declined" });
  assert.equal(asks.length, 1);
  assert.deepEqual(await door.open(frame("other", echoEntry("tree"))), { refused: "needs-approval" });
  assert.equal(asks.length, 2);
});

test("one prompt at a time across servers: another server's open while one is up shows no second prompt", async (t) => {
  const { door, asks } = await setup(t, { echo: echoEntry() });
  assert.deepEqual(await door.open(frame("echo", echoEntry())), { refused: "needs-approval" });
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" });
  assert.deepEqual(asks.map(({ name }) => name), ["echo"]);
  asks[0].answer(false);
  await answered();
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" });
  assert.deepEqual(asks.map(({ name }) => name), ["echo", "native"]);
});

test("with nowhere to ask, a server that needs a prompt is refused no-window: nothing shown, stored or held; an allowed or declined one never consults canAsk", async (t) => {
  const port = await echoServer(t);
  let window = false;
  let checks = 0;
  const { door, asks, saved } = await setup(t, { echo: echoEntry() }, { saved: { allowed: { kind: "url", port } }, canAsk: () => { checks += 1; return window; } });
  const { socket } = await door.open({ name: "allowed", port });
  assert.ok(socket, "an allowed server opens");
  socket.destroy();
  assert.equal(checks, 0);
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "no-window" });
  assert.deepEqual(await door.open(frame("echo", echoEntry())), { refused: "no-window" });
  assert.equal(asks.length, 0);
  assert.deepEqual(Object.keys(saved()), ["allowed"]);
  window = true;
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "needs-approval" }, "nothing held");
  assert.deepEqual(asks.map(({ name }) => name), ["native"]);
  asks[0].answer(false);
  await answered();
  window = false;
  assert.deepEqual(await door.open({ name: "native", port: 19501 }), { refused: "declined" }, "a no still holds");
  assert.equal(checks, 3);
});

test("an unreachable port and a port that never connects", async (t) => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const freed = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const { door } = await setup(t, {}, { saved: { gone: { kind: "url", port: freed } } });
  assert.deepEqual(await door.open({ name: "gone", port: freed }), { failed: "unreachable" });
  const stalled = await setup(t, {}, { saved: { slow: { kind: "url", port: 19502 } }, connect: () => new Socket(), connectMs: 50 });
  assert.deepEqual(await stalled.door.open({ name: "slow", port: 19502 }), { failed: "timeout" });
});

test("bad names and frames are refused before anything is fetched", async (t) => {
  const { door, asks, fetched } = await setup(t, { cmd: echoEntry() });
  for (const name of ["../x", "X", "1x", "a".repeat(33), ["cmd"], undefined]) assert.deepEqual(await door.open({ name, fingerprint: "f" }), { failed: "no-server" }, String(name));
  assert.deepEqual(await door.open({ name: "cmd" }), { failed: "no-server" }, "neither a port nor a fingerprint");
  assert.deepEqual(asks, []);
  assert.deepEqual(fetched, []);
});

test("ending the stream kills the child's tree; close() kills one still starting; stderr is never read", async (t) => {
  const entry = echoEntry("tree");
  const plain = echoEntry();
  const { door, spawned, pids } = await setup(t, { echo: plain, tree: entry }, { saved: { echo: approved(plain), tree: approved(entry) } });

  const ended = (await door.open(frame("echo", plain))).socket;
  const endedOutput = collect(ended);
  await until(() => endedOutput.text.includes("ready"), "the child to start");
  let closed = false;
  ended.on("close", () => { closed = true; });
  ended.end();
  await until(() => exited(spawned[0]) && closed, "the child to exit on end of input, closing the stream");

  const grandchildOf = async (got) => {
    await until(() => /grandchild \d+\n/.test(got.text), "the grandchild's pid");
    const pid = Number(/grandchild (\d+)/.exec(got.text)[1]);
    pids.push(pid);
    assert.equal(gone(pid), false);
    return pid;
  };

  const destroyed = (await door.open(frame("tree", entry))).socket;
  const grandchild = await grandchildOf(collect(destroyed));
  destroyed.destroy();
  await until(() => exited(spawned[1]) && gone(grandchild), "the child and its grandchild to die");

  const left = [(await door.open(frame("tree", entry))).socket, (await door.open(frame("echo", plain))).socket];
  const leftOutput = left.map(collect);
  const leftGrandchild = await grandchildOf(leftOutput[0]);
  await until(() => leftOutput.every((got) => got.text.includes("ready")), "both children to start");
  left[1].write("hello\n");
  await until(() => leftOutput[1].text.includes("hello\n"), "the echo");
  assert.ok(!leftOutput[1].text.includes("stderr-secret"), "stderr never comes back");
  door.close();
  await until(() => exited(spawned[2]) && exited(spawned[3]) && gone(leftGrandchild), "close() to kill the rest, trees and all");

  // close() while the definition is still being fetched.
  let release;
  const slow = await setup(t, { echo: plain }, { saved: { echo: approved(plain) } });
  const slowDoor = createMcpDoor({
    approvals: { read: () => ({ echo: approved(plain) }), write() {} }, prompt: async () => false, ownPorts: async () => [],
    definition: () => new Promise((resolve) => { release = () => resolve(plain); }),
    environment: async () => ({ PATH: process.env.PATH }), home: tmpdir(),
    spawn: (...args) => { const child = spawn(...args); slow.spawned.push(child); slow.pids.push(child.pid); return child; },
  });
  const opening = slowDoor.open(frame("echo", plain));
  await until(() => release, "the definition to be asked for");
  slowDoor.close();
  release();
  assert.deepEqual(await opening, { failed: "spawn-failed" });
  assert.equal(slow.spawned.length, 0, "nothing starts after close()");
  slowDoor.close();
});

test("a command that cannot start is spawn-failed", async (t) => {
  const entry = { command: join(tmpdir(), "no-such-mcp-server-here"), args: [], env: {} };
  const { door } = await setup(t, { nope: entry }, { saved: { nope: approved(entry) } });
  assert.deepEqual(await door.open(frame("nope", entry)), { failed: "spawn-failed" });
});

test("a command that exits at once still opens, and its stream ends before any byte", async (t) => {
  const entry = { command: process.execPath, args: ["-e", "process.exit(1)"], env: {} };
  const { door } = await setup(t, { quits: entry }, { saved: { quits: approved(entry) } });
  const { socket } = await door.open(frame("quits", entry));
  const got = collect(socket);
  await bounded(new Promise((resolve) => socket.once("close", resolve)), "the stream to end");
  assert.equal(got.text, "");
});

test("windowsLaunch and taskkill /T are used on win32", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shim = join(dir, "npx.cmd");
  await writeFile(shim, "@echo off\r\n");
  await chmod(shim, 0o755);
  const entry = { command: shim, args: ["-y", "a b"], env: { KEY: "v" } };
  const calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
  const spawn = (...call) => {
    calls.push(call);
    if (call[0] === "taskkill") return new EventEmitter();
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const { door } = await setup(t, { shim: entry }, { saved: { shim: approved(entry) }, platform: "win32", spawn });
  const { socket } = await door.open(frame("shim", entry));
  assert.ok(socket, "opened");
  assert.equal(calls[0][0], process.env.ComSpec || "cmd.exe");
  assert.deepEqual(calls[0][1].slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(calls[0][1][3].includes(`"${shim}" "-y" "a b"`), calls[0][1][3]);
  assert.equal(calls[0][2].windowsVerbatimArguments, true);
  assert.equal(calls[0][2].detached, false);
  assert.equal(calls[0][2].env.KEY, "v");
  socket.destroy();
  await until(() => calls.length === 2, "taskkill");
  assert.deepEqual(calls[1].slice(0, 2), ["taskkill", ["/PID", "777", "/T", "/F"]]);
});

test("a Windows program that is not there is spawn-failed", async (t) => {
  const entry = { command: "C:\\no\\such\\thing.exe", args: [], env: {} };
  const { door } = await setup(t, { gone: entry }, { saved: { gone: approved(entry) }, platform: "win32", spawn: () => assert.fail("nothing to spawn") });
  assert.deepEqual(await door.open(frame("gone", entry)), { failed: "spawn-failed" });
});

test("the shown command hides secrets by name and shows everything else in full", () => {
  const shown = (...args) => shownCommand("npx", args);
  for (const [args, secret] of [
    [["--token=abc"], "abc"], [["API_KEY=abc"], "abc"], [["API_KEY=supersecretpasswordvalue"], "supersecretpasswordvalue"],
    [["--key", "ghp_abc"], "ghp_abc"], [["--password", "hunter2"], "hunter2"],
    [["postgresql://user:hunter2@localhost/db"], "hunter2"], [["--header", "Authorization: Bearer abc123"], "abc123"],
    [["--header", "X-Note: Bearer abc123"], "abc123"],
  ]) assert.ok(!shown(...args).includes(secret), shown(...args));
  assert.equal(shown("--token=abc"), "npx --token=…");
  assert.equal(shown("--key", "ghp_abc"), "npx --key …");
  assert.equal(shown("postgresql://user:hunter2@localhost/db"), "npx postgresql://user:…@localhost/db");
  assert.equal(shown("-y", "evilpackage123456789", "/Users/jane/vault", "--port", "8080"), "npx -y evilpackage123456789 /Users/jane/vault --port 8080");
  assert.equal(shownCommand("node", []), "node");
});

test("close() ends an open URL stream, and an open whose connect finishes after close() leaves no socket", async (t) => {
  const port = await echoServer(t);
  const { door } = await setup(t, {}, { saved: { native: { kind: "url", port } } });
  const { socket } = await door.open({ name: "native", port });
  let closed = false;
  socket.on("close", () => { closed = true; });
  door.close();
  await until(() => closed, "the URL stream to end");

  const sockets = [];
  const late = await setup(t, {}, { saved: { native: { kind: "url", port } }, connect: (options) => { const s = new Socket(); sockets.push(s); return s.connect(options.port, options.host); } });
  const opening = late.door.open({ name: "native", port });
  late.door.close();
  assert.deepEqual(await opening, { failed: "unreachable" });
  await until(() => sockets.every((s) => s.destroyed), "no socket left");
});

test("a failing ownPorts or environment is a failed open, not a rejection", async (t) => {
  const entry = echoEntry();
  const first = await setup(t, {}, { ownPorts: async () => { throw new Error("no"); } });
  assert.deepEqual(await first.door.open({ name: "x", port: 19501 }), { failed: "unreachable" });
  const second = await setup(t, { echo: entry }, { saved: { echo: approved(entry) }, environment: async () => { throw new Error("no"); } });
  assert.deepEqual(await second.door.open(frame("echo", entry)), { failed: "spawn-failed" });
  assert.equal(second.spawned.length, 0);
  const third = await setup(t, { echo: { command: 5, args: [], env: {} } });
  assert.deepEqual(await third.door.open({ name: "echo", fingerprint: "f" }), { failed: "no-server" }, "a definition of the wrong shape");
});
