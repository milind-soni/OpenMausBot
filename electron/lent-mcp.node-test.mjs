import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { commandFingerprint, createLentMcp, inheritedEnvironment, isLoopbackAddress, killTree, lentMcpRefusal, ownEnvironmentIds, ownPorts, validLentMcpServer, windowsLaunch } from "./lent-mcp.mjs";
import { executeSharedOperation } from "./shared-computer-access.mjs";
import { validSharedOperation } from "./computer-sharing.mjs";

const signal = () => new AbortController().signal;
const http = (url, headers = {}) => ({ name: "local", url, type: "http", headers });

/** A stdio MCP server: `whoami` answers with its process id and the key it was started with, `fail` with an error. */
const SERVER_SCRIPT = `
import readline from "node:readline";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: message.params.cursor ? { tools: [{ name: "fail", inputSchema: { type: "object" } }] } : { tools: [{ name: "whoami", inputSchema: { type: "object" } }], nextCursor: "2" } });
  if (message.params.name === "fail") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "no such thing" } });
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, key: process.env.NOTES_TOKEN, cwd: process.cwd() }) }] } });
});
`;

/** One step of a test, refused after 20 seconds by name, so a hang says where it is. */
const step = (name, promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} took over 20 s`)), 20_000).unref())]);

async function stdioFixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lent-mcp-")));
  const script = path.join(dir, "server.mjs");
  await writeFile(script, SERVER_SCRIPT);
  const home = path.join(dir, "home");
  await mkdir(home);
  const lent = createLentMcp({ environment: () => ({ ...inheritedEnvironment(), PATH: process.env.PATH ?? "" }), home });
  // Windows keeps a running process's working folder: the servers end before their folder goes.
  t.after(async () => { await lent.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return { dir, home, script, lent, server: { name: "notes", command: process.execPath, args: [script], env: { NOTES_TOKEN: "saved-env-key" } } };
}

test("takes a server only in the shape the Cloud sends, and an MCP job only with its server", () => {
  const command = { name: "notes", command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "x" } };
  assert.equal(validLentMcpServer(command), true);
  assert.equal(validLentMcpServer(http("http://127.0.0.1:1/mcp")), true);
  for (const bad of [{ ...command, extra: 1 }, { ...command, name: "Bad" }, { ...command, env: { "BAD NAME": "x" } }, { ...command, args: "x" }, { name: "local", url: "http://127.0.0.1/", type: "ws", headers: {} }, null]) {
    assert.equal(validLentMcpServer(bad), false, JSON.stringify(bad));
  }
  const id = randomUUID();
  assert.equal(validSharedOperation({ computer_id: id, action: "mcp_tools", server: command }, id), true);
  assert.equal(validSharedOperation({ computer_id: id, action: "mcp_call", server: command, tool_name: "x".repeat(200), arguments: {} }, id), true);
  assert.equal(validSharedOperation({ computer_id: id, action: "mcp_tools" }, id), false);
  assert.equal(validSharedOperation({ computer_id: id, action: "read_file", server: command }, id), false);
});

test("security: only the person's own Cloud, a command only with the terminal lent, an address only on this computer, MCP only", () => {
  const command = { name: "notes", command: "npx", args: [], env: {} };
  const cloud = { cloud: { accountId: "a", origin: "https://x" }, terminal: false };
  assert.match(lentMcpRefusal({ terminal: true }, command), /only for the person's own Clouds/);
  assert.match(lentMcpRefusal(cloud, command), /Running commands is not enabled/);
  assert.equal(lentMcpRefusal({ ...cloud, terminal: true }, command), null);
  assert.equal(lentMcpRefusal(cloud, http("http://127.0.0.1:19501/mcp")), null);
  assert.equal(lentMcpRefusal(cloud, http("http://[::1]:19501/mcp")), null);
  for (const url of ["http://192.168.1.10:8080/mcp", "https://example.com/mcp", "http://127.0.0.1.nip.io/mcp", "http://user:pw@127.0.0.1/mcp", "file:///etc/passwd"]) {
    assert.equal(isLoopbackAddress(url), false, url);
    assert.match(lentMcpRefusal(cloud, http(url)), /this computer's own address/);
  }
  assert.match(lentMcpRefusal(cloud, { ...http("http://127.0.0.1:1/sse"), type: "sse" }), /older SSE transport/);
});

const OWN_PORT = /^Only an MCP server on its own port \(1024 or higher\) at this computer's address can be reached, never this computer's own OpenMausBot or Chrome ports$/;

test("security: an address only on its own port, 1024 or higher, never one left to its default", () => {
  const cloud = { cloud: { accountId: "a", origin: "https://x" }, terminal: false };
  for (const url of ["http://127.0.0.1/mcp", "http://127.0.0.1:80/mcp", "https://localhost/mcp", "http://localhost:443/mcp", "http://[::1]:1023/mcp", "http://[::1]/mcp", "http://127.0.0.1:0/mcp"]) {
    assert.match(lentMcpRefusal(cloud, http(url)) ?? "", OWN_PORT, url);
  }
  for (const url of ["http://127.0.0.1:19501/mcp", "http://localhost:19501/mcp", "http://[::1]:19501/mcp", "https://127.0.0.1:1024/mcp"]) assert.equal(lentMcpRefusal(cloud, http(url)), null, url);
});

test("commandFingerprint hashes command, args and env names, never env values", () => {
  const server = { command: "notes-mcp", args: ["--dir", "notes"], env: { NOTES_TOKEN: "a", NOTES_DIR: "x" } };
  assert.match(commandFingerprint(server), /^[a-f0-9]{64}$/);
  assert.equal(commandFingerprint({ ...server, env: { NOTES_DIR: "y", NOTES_TOKEN: "b" } }), commandFingerprint(server));
  assert.notEqual(commandFingerprint({ ...server, args: ["--dir", "other"] }), commandFingerprint(server));
  assert.notEqual(commandFingerprint({ ...server, env: { NOTES_TOKEN: "a" } }), commandFingerprint(server));
});

test("security: never this computer's own OpenMausBot ports or Chrome's DevTools port, and nothing is fetched", async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lent-mcp-ports-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chrome = path.join(dir, "Google", "Chrome");
  await mkdir(chrome, { recursive: true });
  await writeFile(path.join(chrome, "DevToolsActivePort"), "9333\n/devtools/browser/0b1c2d3e-aaaa-4bbb-8ccc-0123456789ab");
  const ports = await ownPorts({ serverPorts: [41234], dirs: [chrome, path.join(dir, "Brave")] });
  assert.deepEqual([...ports].sort((a, b) => a - b), [8799, 9333, 18799, 28799, 41234]);
  let fetched = 0;
  const fetch = async () => { fetched++; throw new Error("never fetched"); };
  const lent = createLentMcp({ ports: () => ownPorts({ serverPorts: [41234], dirs: [chrome] }), fetch });
  for (const url of ["http://127.0.0.1:8799/mcp", "http://localhost:18799/mcp", "http://[::1]:41234/mcp", "http://127.0.0.1:9333/json/new"]) {
    await assert.rejects(lent.call({ action: "mcp_tools", server: http(url) }, signal()), error => OWN_PORT.test(error.message), url);
  }
  await assert.rejects(createLentMcp({ fetch }).call({ action: "mcp_call", server: http("http://127.0.0.1:8799/api/config"), tool_name: "x" }, signal()), error => OWN_PORT.test(error.message), "the desktop's ports by default");
  assert.equal(fetched, 0);
  await assert.rejects(lent.call({ action: "mcp_tools", server: http("http://127.0.0.1:19501/mcp") }, signal()), /local is not answering/);
  assert.equal(fetched, 1, "a port of its own is reached");
});

test("the executor refuses before anything starts when the grant doesn't allow it", async () => {
  let started = 0;
  const grant = { enabled: true, folders: [], terminal: false, computer: false, cloud: { accountId: "a", origin: "https://x" } };
  const operation = { action: "mcp_tools", server: { name: "notes", command: "touch", args: ["/tmp/never"], env: {} } };
  await assert.rejects(executeSharedOperation(grant, operation, signal(), null, () => { started++; return null; }), /Running commands is not enabled/);
  await assert.rejects(executeSharedOperation({ ...grant, cloud: undefined, terminal: true }, operation, signal(), null, () => { started++; return null; }), /own Clouds/);
  await assert.rejects(executeSharedOperation({ ...grant, enabled: false }, operation, signal(), null, () => { started++; return null; }), /sharing is off/);
  assert.equal(started, 0);
});

test("a command server starts once, from the home folder, with its saved key, and keeps running between calls", async t => {
  const { lent, server, home } = await stdioFixture(t);
  const listed = await step("listing", lent.call({ action: "mcp_tools", server }, signal()));
  assert.deepEqual(listed.tools.map(tool => tool.name), ["whoami", "fail"], "every page");
  const first = JSON.parse((await step("the first call", lent.call({ action: "mcp_call", server, tool_name: "whoami", arguments: {} }, signal()))).content[0].text);
  assert.equal(first.key, "saved-env-key");
  assert.equal(await realpath(first.cwd), await realpath(home));
  await assert.rejects(step("a failing call", lent.call({ action: "mcp_call", server, tool_name: "fail" }, signal())), /no such thing/);
  const again = JSON.parse((await step("the call after it", lent.call({ action: "mcp_call", server, tool_name: "whoami" }, signal()))).content[0].text);
  assert.equal(again.pid, first.pid, "an error from the server leaves it running");
  const changed = { ...server, env: { NOTES_TOKEN: "new-key" } };
  const fresh = JSON.parse((await step("the changed server's call", lent.call({ action: "mcp_call", server: changed, tool_name: "whoami" }, signal()))).content[0].text);
  assert.notEqual(fresh.pid, first.pid, "a changed server starts anew");
  assert.equal(fresh.key, "new-key");
});

test("a server that refuses to start is started again on the next call, not kept refusing", async t => {
  let refusals = 1;
  const { url, seen } = await httpFixture(t, (req, res, message) => {
    if (!("id" in message)) { res.writeHead(202).end(); return; }
    if (message.method === "initialize" && refusals-- > 0) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "warming up" } })); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [{ name: "search" }] } }));
  });
  const lent = createLentMcp();
  t.after(() => lent.close());
  await assert.rejects(lent.call({ action: "mcp_tools", server: http(url) }, signal()), /warming up/);
  assert.deepEqual(await lent.call({ action: "mcp_tools", server: http(url) }, signal()), { tools: [{ name: "search" }] });
  assert.equal(seen.filter(request => request.message.method === "initialize").length, 2);
});

test("a command server that can't start says so by its program's name, never with its keys", async t => {
  const { lent } = await stdioFixture(t);
  const missing = { name: "notes", command: path.join(tmpdir(), "omb-no-such-program"), args: [], env: { NOTES_TOKEN: "never-echoed" } };
  await assert.rejects(step("a missing program", lent.call({ action: "mcp_tools", server: missing }, signal())), error => {
    assert.match(error.message, /notes could not start: omb-no-such-program is not on this computer/);
    assert.doesNotMatch(error.message, /never-echoed/);
    return true;
  });
});

async function httpFixture(t, answer) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, message });
    answer(req, res, message);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

test("an address on this computer gets MCP messages with its saved headers, as JSON or an event stream, in one session", async t => {
  const { seen, url } = await httpFixture(t, (req, res, message) => {
    if (!("id" in message)) { res.writeHead(202).end(); return; }
    if (message.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26" } })); return; }
    if (message.method === "tools/list") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search" }] } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `found ${message.params.arguments.q}` }] } })}\n\n`);
  });
  const lent = createLentMcp();
  t.after(() => lent.close());
  const server = http(url, { Authorization: "Bearer saved-header" });
  assert.deepEqual(await lent.call({ action: "mcp_tools", server }, signal()), { tools: [{ name: "search" }] });
  assert.deepEqual(await lent.call({ action: "mcp_call", server, tool_name: "search", arguments: { q: "plan" } }, signal()), { content: [{ type: "text", text: "found plan" }] });
  assert.deepEqual(seen.map(request => request.message.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.ok(seen.every(request => request.method === "POST" && request.url === "/mcp" && request.headers.authorization === "Bearer saved-header"));
  assert.deepEqual(seen.slice(1).map(request => request.headers["mcp-session-id"]), ["s-1", "s-1", "s-1"]);
});

test("an address that refuses its keys, redirects or isn't there says so plainly, with no key in the words", async t => {
  const { url } = await httpFixture(t, (req, res, message) => {
    if (req.headers.authorization === "Bearer wrong") { res.writeHead(401).end(); return; }
    res.writeHead(302, { location: "https://example.com/" }).end();
    void message;
  });
  const lent = createLentMcp();
  t.after(() => lent.close());
  await assert.rejects(lent.call({ action: "mcp_tools", server: http(url, { Authorization: "Bearer wrong" }) }, signal()), error => {
    assert.equal(error.message, "local refused its saved keys (HTTP 401)");
    return true;
  });
  await assert.rejects(lent.call({ action: "mcp_tools", server: http(url) }, signal()), /local is not answering at 127\.0\.0\.1:\d+ on this computer/);
  await assert.rejects(lent.call({ action: "mcp_tools", server: http("http://127.0.0.1:9/mcp") }, signal()), /local is not answering at 127\.0\.0\.1:9 on this computer/);
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

test("killTree ends the process group, or taskkill /T /F on win32", async () => {
  const calls = [];
  const spawn = (...call) => { calls.push(call); return { on() {} }; };
  killTree({ pid: 4321, kill() { assert.fail("a Windows tree is ended by taskkill"); } }, { platform: "win32", spawn });
  assert.deepEqual(calls, [["taskkill", ["/PID", "4321", "/T", "/F"], { windowsHide: true, stdio: "ignore" }]]);
  killTree({ kill() { assert.fail("no pid, nothing to kill"); } }, { platform: "win32", spawn });
  assert.equal(calls.length, 1);

  // A real group: the child starts a grandchild of its own, and both die.
  const { spawn: spawnReal } = await import("node:child_process");
  const child = spawnReal(process.execPath, ["-e", 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000)'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise(resolve => child.stdout.once("data", resolve)));
  const exited = new Promise(resolve => child.once("exit", resolve));
  killTree(child, { platform: process.platform, spawn });
  await exited;
  const gone = () => { try { process.kill(grandchild, 0); return false; } catch { return true; } };
  for (let i = 0; i < 300 && !gone(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(gone(), "the grandchild died with it");
  assert.equal(calls.length, 1, "the real spawn is not touched off Windows");
});
