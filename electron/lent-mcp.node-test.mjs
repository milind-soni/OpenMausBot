import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { commandFingerprint, killTree, MCP_JOBS_MOVED, ownEnvironmentIds, ownPorts, windowsLaunch } from "./lent-mcp.mjs";
import { executeSharedOperation } from "./shared-computer-access.mjs";
import { validSharedOperation } from "./computer-sharing.mjs";

const signal = () => new AbortController().signal;

test("commandFingerprint hashes command, args and the env, values included", () => {
  const server = { command: "notes-mcp", args: ["--dir", "notes"], env: { NOTES_TOKEN: "a", NOTES_DIR: "x" } };
  assert.match(commandFingerprint(server), /^[a-f0-9]{64}$/);
  assert.equal(commandFingerprint({ ...server, env: { NOTES_DIR: "x", NOTES_TOKEN: "a" } }), commandFingerprint(server));
  assert.notEqual(commandFingerprint({ ...server, env: { NOTES_DIR: "y", NOTES_TOKEN: "a" } }), commandFingerprint(server), "an env value changed");
  assert.notEqual(commandFingerprint({ ...server, args: ["--dir", "other"] }), commandFingerprint(server));
  assert.notEqual(commandFingerprint({ ...server, env: { NOTES_TOKEN: "a" } }), commandFingerprint(server));
});

test("this computer's own ports: its OpenMausBot servers' and Chrome's DevTools port while Chrome runs", async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lent-mcp-ports-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chrome = path.join(dir, "Google", "Chrome");
  await mkdir(chrome, { recursive: true });
  await writeFile(path.join(chrome, "DevToolsActivePort"), "9333\n/devtools/browser/0b1c2d3e-aaaa-4bbb-8ccc-0123456789ab");
  const ports = await ownPorts({ serverPorts: [41234], dirs: [chrome, path.join(dir, "Brave")] });
  assert.deepEqual([...ports].sort((a, b) => a - b), [8799, 9333, 18799, 28799, 41234]);
});

test("an mcp_tools job is answered with one sentence and starts nothing", async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lent-mcp-jobs-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "started");
  const id = randomUUID();
  const grant = { enabled: true, folders: [], terminal: true, computer: true, cloud: { accountId: "a", origin: "https://x" } };
  const server = { name: "notes", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], env: {} };
  for (const operation of [{ computer_id: id, action: "mcp_tools", server }, { computer_id: id, action: "mcp_call", server, tool_name: "whoami", arguments: {} }]) {
    assert.equal(validSharedOperation(operation, id), true, "an older My Cloud's job is answered, not refused as malformed");
    await assert.rejects(executeSharedOperation(grant, operation, signal(), () => assert.fail("computer control is never asked")), { message: MCP_JOBS_MOVED });
  }
  assert.equal(MCP_JOBS_MOVED, "This computer runs MCP servers for My Cloud only through its link now; this My Cloud is too old to use it. It works once My Cloud updates.");
  assert.equal(existsSync(marker), false);
});

test("on Windows a program starts directly, a .cmd shim through cmd.exe with each word quoted, and a missing one is named", () => {
  const env = { PATH: "C:\\Tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const on = files => candidate => files.some(file => file.toLowerCase() === candidate.toLowerCase());
  assert.deepEqual(windowsLaunch("npx", ["-y", "notes mcp", 'say "hi"'], env, on(["C:\\Program Files\\nodejs\\npx.cmd"])), {
    file: "C:\\Windows\\system32\\cmd.exe", verbatim: true,
    args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npx.cmd" "-y" "notes mcp" "say ""hi""""'],
  });
  assert.deepEqual(windowsLaunch("uvx", ["mcp"], env, on(["C:\\Tools\\uvx.exe", "C:\\Tools\\uvx.cmd"])), { file: "C:\\Tools\\uvx.exe", args: ["mcp"], verbatim: false }, "PATHEXT's order");
  assert.deepEqual(windowsLaunch("C:\\Users\\Ada\\bin\\notes.exe", [], env, on(["C:\\Users\\Ada\\bin\\notes.exe"])), { file: "C:\\Users\\Ada\\bin\\notes.exe", args: [], verbatim: false });
  assert.equal(windowsLaunch("notes-mcp", [], env, on([])), null);
});

test("this computer's own installs, by the environment id each keeps", async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lent-mcp-ids-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = randomUUID();
  await mkdir(path.join(dir, "a")); await writeFile(path.join(dir, "a", "environment-id"), `${id}\n`);
  await mkdir(path.join(dir, "b")); await writeFile(path.join(dir, "b", "environment-id"), "not-an-id");
  assert.deepEqual(ownEnvironmentIds([path.join(dir, "a"), path.join(dir, "b"), path.join(dir, "missing"), null, path.join(dir, "a")]), [id]);
});

test("killTree ends the process group, or taskkill /T /F on win32", async t => {
  const calls = [];
  const spawn = (...call) => { calls.push(call); return { on() {} }; };
  killTree({ pid: 4321, exitCode: null, signalCode: null, kill() { assert.fail("a Windows tree is ended by taskkill"); } }, { platform: "win32", spawn });
  assert.deepEqual(calls, [["taskkill", ["/PID", "4321", "/T", "/F"], { windowsHide: true, stdio: "ignore" }]]);
  killTree({ kill() { assert.fail("no pid, nothing to kill"); } }, { platform: "win32", spawn });
  for (const exited of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGKILL" }]) killTree({ pid: 4321, ...exited, kill() { assert.fail("an exited child's PID may be someone else's"); } }, { platform: "win32", spawn });
  assert.equal(calls.length, 1);

  // A real group: the child starts a grandchild of its own, and both die.
  const { spawn: spawnReal } = await import("node:child_process");
  const child = spawnReal(process.execPath, ["-e", 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000)'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise(resolve => child.stdout.once("data", resolve)));
  const exited = new Promise(resolve => child.once("exit", resolve));
  const gone = () => { try { process.kill(grandchild, 0); return false; } catch { return true; } };
  t.after(() => { for (const pid of [child.pid, grandchild]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
  killTree(child, { platform: process.platform, spawn });
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("the child did not exit")), 3000).unref())]);
  for (let i = 0; i < 300 && !gone(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(gone(), "the grandchild died with it");
  assert.equal(calls.length, 1, "the real spawn is not touched off Windows");
});
