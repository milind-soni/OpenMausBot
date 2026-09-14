import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import { mkdtemp, mkdir, stat, realpath, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { executeSharedOperation, sharedCommand, createSharedCua } from "./shared-computer-access.mjs";
import { createComputerSharing, validateSharedFolders } from "./computer-sharing.mjs";

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-shared-access-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = { id: randomUUID(), name: "Fixture", path: dir, write: false };
  const grant = { enabled: true, folders: [folder], terminal: false, computer: false };
  const run = async operation => executeSharedOperation(grant, { folder_id: folder.id, ...operation }, new AbortController().signal);
  return { dir, folder, grant, run };
}
const payload = result => JSON.parse(result.content[0].text);

/** What this host's filesystem treats as one directory. APFS and NTFS fold
 * case, APFS also folds Unicode normalization, ext4 folds neither. */
async function spellings(dir) {
  const probe = path.join(dir, "Probe-\u00c9");
  await mkdir(probe);
  const reaches = async candidate => { try { await stat(candidate); return true; } catch { return false; } };
  const folded = { case: await reaches(path.join(dir, "probe-\u00c9")), normalization: await reaches(path.join(dir, "Probe-E\u0301")) };
  await rm(probe, { recursive: true, force: true });
  return folded;
}

/** A workspace that pairs, connects, hands out one operation and keeps the
 * result. Polls past the queued work fail so the loop backs off instead of
 * spinning; closing the controller ends the backoff. */
function stubWorkspace() {
  const sessionId = randomUUID();
  const environmentId = randomUUID();
  const env = { id: "fixture-workspace", name: "Fixture", origin: "https://workspace.test" };
  const json = value => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { connected: null, work: [] };
  let deliver;
  state.delivered = new Promise(resolve => { deliver = resolve; });
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: sessionId });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId, capabilities: { sharedComputers: true } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connected = body; return json({}); }
    if (route.endsWith("/poll")) {
      const operation = state.work.shift();
      if (!operation) throw new Error("fixture workspace has no more work");
      return json({ job: { id: randomUUID(), operation: { computer_id: state.connected.id, folder_id: state.connected.folders[0]?.id, ...operation } } });
    }
    if (route.endsWith("/lease")) return json({ active: true });
    if (route.endsWith("/result")) { deliver(body.result); return json({}); }
    if (route.endsWith("/disconnect")) return json({});
    throw new Error(`fixture workspace has no route ${route}`);
  };
  return { env, fetchImpl, state };
}

test("legacy insecure saved addresses never receive sharing credentials", async t => {
  const { dir } = await fixture(t);
  let calls = 0;
  const sharing = createComputerSharing({ file: path.join(dir, "profile", "sharing.json"), environments: () => [], enabled: async () => true, cuaConnection: async () => null, fetch: async () => { calls++; throw new Error("unexpected network"); } });
  t.after(() => sharing.close());
  await assert.rejects(sharing.observe({ id: "old", origin: "http://old-server.example", name: "Legacy" }), /HTTPS/);
  assert.equal(calls, 0);
});

test("saved grants and stale consent cannot bypass a disabled or unavailable local gate", async t => {
  const { dir, folder } = await fixture(t);
  const env = { id: "saved", origin: "https://workspace.fixture.example", name: "Saved" };
  const info = { sessionId: randomUUID(), environmentId: randomUUID() };
  const file = path.join(dir, "sharing.json");
  await writeFile(file, JSON.stringify({ version: 1, records: { [env.id]: { ...info, id: randomUUID(), secret: "a".repeat(64), enabled: true, folders: [folder], terminal: false, computer: false } } }));
  const original = await readFile(file, "utf8");
  for (const enabled of [undefined, async () => false, async () => { throw new Error("local server unavailable"); }]) {
    let calls = 0;
    const sharing = createComputerSharing({ file, environments: () => [env], enabled, cuaConnection: async () => null, fetch: async () => { calls++; throw new Error("must not contact remote"); } });
    t.after(() => sharing.close());
    sharing.start();
    await assert.rejects(sharing.save(env, { folders: [folder], terminal: false, computer: false }, info), /turned off/);
    assert.equal(calls, 0);
    assert.equal(await readFile(file, "utf8"), original, "disabled consent cannot replace the stored grant");
    assert.notEqual(sharing.state(env.id).connected, true);
  }
});

test("selected folders are read-only; writes require an explicit grant and fresh hash", async t => {
  const { dir, folder, run } = await fixture(t);
  await writeFile(path.join(dir, "note.txt"), "hello 🌱");
  assert.equal(payload(await run({ action: "list_files" })).entries[0].name, "note.txt");
  const original = payload(await run({ action: "read_file", path: "note.txt" }));
  assert.equal(original.content, "hello 🌱");
  await assert.rejects(run({ action: "write_file", path: "note.txt", content: "changed" }), /read-only/);
  folder.write = true;
  await assert.rejects(run({ action: "write_file", path: "note.txt", content: "changed" }), /EEXIST/);
  await assert.rejects(run({ action: "write_file", path: "note.txt", content: "changed", expected_sha256: "0".repeat(64) }), /File changed/);
  await run({ action: "write_file", path: "note.txt", content: "ok", expected_sha256: original.sha256 });
  assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "ok");
  await run({ action: "write_file", path: "new.txt", content: "new" });
  assert.equal(await readFile(path.join(dir, "new.txt"), "utf8"), "new");
  await assert.rejects(run({ action: "delete_file", path: "note.txt" }), /Unsupported/);
});

test("folder boundary rejects traversal, links, oversized files and unknown folder IDs", async t => {
  const { dir, run } = await fixture(t);
  for (const unsafe of ["../escape", "/etc/passwd", "nested/../../escape", "C:\\secret", "note.txt\0"]) {
    await assert.rejects(run({ action: "read_file", path: unsafe }), /relative path/);
  }
  await writeFile(path.join(dir, "note.txt"), "fixture");
  await link(path.join(dir, "note.txt"), path.join(dir, "hard.txt"));
  await assert.rejects(run({ action: "read_file", path: "hard.txt" }), /single-link/);
  if (process.platform !== "win32") {
    await symlink(dir, path.join(dir, "linked"));
    await assert.rejects(run({ action: "read_file", path: "linked/note.txt" }), /Symbolic links/);
  }
  await writeFile(path.join(dir, "large.txt"), Buffer.alloc(262145));
  await assert.rejects(run({ action: "read_file", path: "large.txt" }), /256 KiB/);
  await assert.rejects(run({ action: "list_files", folder_id: randomUUID() }), /not been shared/);
  await assert.rejects(validateSharedFolders([{ id: randomUUID(), path: path.parse(dir).root, write: false }]), /specific folders/);
});

test("terminal and computer control are separately off, and revocation fails closed", async t => {
  const { grant, run } = await fixture(t);
  await assert.rejects(run({ action: "run_command", command: "echo no" }), /Terminal access/);
  await assert.rejects(run({ action: "computer_tools" }), /Computer control/);
  grant.enabled = false;
  await assert.rejects(run({ action: "list_files" }), /sharing is off/);
});

test("a broad selected parent cannot expose the desktop's own credentials or grants", async t => {
  const { dir, grant, run } = await fixture(t);
  await writeFile(path.join(dir, "credentials.json"), "private");
  grant.protectedPaths = [dir];
  await assert.rejects(run({ action: "read_file", path: "credentials.json" }), /Desktop credentials/);
  grant.folders[0].write = true;
  await assert.rejects(run({ action: "write_file", path: "grant.json", content: "{}" }), /sharing settings/);
});

test("explicit terminal grant executes a harmless command and cancellation stops its process", async t => {
  const { dir } = await fixture(t);
  const result = payload(await sharedCommand("echo fixture-terminal", dir, new AbortController().signal));
  assert.equal(result.exitCode, 0); assert.match(result.output, /fixture-terminal/);
  const stop = new AbortController();
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
  const pending = sharedCommand(command, dir, stop.signal);
  setTimeout(() => stop.abort(), 80);
  await assert.rejects(pending, /revoked|turn ended/);
});

test("Windows terminal preserves command syntax, pipeline output and exit status", { skip: process.platform !== "win32" }, async t => {
  const { dir } = await fixture(t);
  const run = async command => payload(await sharedCommand(command, dir, new AbortController().signal));
  const quoted = await run('param([string]$value = "fixture \'quoted\'"); Write-Output $value');
  assert.equal(quoted.exitCode, 0); assert.match(quoted.output, /fixture 'quoted'/);
  const declared = await run("using namespace System.Text; [StringBuilder]::new('fixture-using').ToString()");
  assert.equal(declared.exitCode, 0); assert.match(declared.output, /fixture-using/);
  const pipeline = await run("@('alpha', 'beta') | ForEach-Object { $_.ToUpper() }");
  assert.equal(pipeline.exitCode, 0); assert.match(pipeline.output, /ALPHA\s+BETA/);
  const unicode = await run('Write-Output ([int][char]("fixture’s")[7])');
  assert.equal(unicode.exitCode, 0); assert.match(unicode.output, /8217/);
  assert.equal((await run("exit 7")).exitCode, 7);
  assert.equal((await run("cmd.exe /c exit 7")).exitCode, 1);
  assert.equal((await run("Write-Error 'fixture-nonterminating'")).exitCode, 1);
  assert.equal((await run("Write-Error 'fixture-recovered'; 'after'")).exitCode, 0);
  const blocks = await run("begin { 'fixture-begin' } end { 'fixture-end' }");
  assert.equal(blocks.exitCode, 0); assert.match(blocks.output, /fixture-begin\s+fixture-end/);
  const returned = await run("return 'fixture-return'; throw 'must-not-run'");
  assert.equal(returned.exitCode, 0); assert.match(returned.output, /fixture-return/);
  const paths = await run("[Console]::WriteLine($env:PSModulePath)");
  assert.equal(paths.exitCode, 0);
  const modulePaths = paths.output.trim().toLowerCase();
  assert.ok(modulePaths.startsWith(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules").toLowerCase()), "built-in modules must be first");
  assert.ok(modulePaths.includes(path.join(process.env.ProgramFiles, "WindowsPowerShell", "Modules").toLowerCase()), "installed modules must remain available");
  const failed = await run("throw 'fixture-command-failed'");
  assert.notEqual(failed.exitCode, 0); assert.match(failed.output, /fixture-command-failed/);
});

test("Windows terminal cancellation stops the running inner shell", { skip: process.platform !== "win32", timeout: 35_000 }, async t => {
  const { dir } = await fixture(t);
  const marker = path.join(dir, "inner-shell.pid");
  const stop = new AbortController();
  const pending = sharedCommand(`[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', [string]$PID); [Threading.Thread]::Sleep(20000)`, dir, stop.signal);
  // Attach a handler while waiting for the marker, before asserting rejection.
  pending.catch(() => {});
  let innerPid;
  const alive = () => {
    try { process.kill(innerPid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  try {
    const startedBy = Date.now() + 15_000;
    while (Date.now() < startedBy) {
      try { innerPid = Number((await readFile(marker, "utf8")).trim()); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Number.isInteger(innerPid) && innerPid > 0) break;
      await delay(50);
    }
    assert.ok(Number.isInteger(innerPid) && innerPid > 0, "inner shell must write its PID before cancellation");
    assert.equal(alive(), true, "inner shell must still be running");
    const stoppedBy = Date.now() + 5000;
    stop.abort();
    await Promise.race([
      assert.rejects(pending, /revoked|turn ended/),
      delay(5000, undefined, { ref: false }).then(() => assert.fail("cancellation must reject promptly")),
    ]);
    while (alive() && Date.now() < stoppedBy) await delay(50);
    assert.equal(alive(), false, "cancellation must terminate the inner shell, not just its wrapper");
  } finally {
    stop.abort();
    // If the assertion fails, clean up only the PID written by this fixture.
    if (Number.isInteger(innerPid) && innerPid > 0 && alive()) process.kill(innerPid);
    await pending.catch(() => {});
  }
});

test("official-style MCP transport preserves session state and image content; it closes on revoke", async t => {
  const { dir } = await fixture(t);
  const script = path.join(dir, "cua-fixture.mjs");
  await writeFile(script, `import readline from 'node:readline'; let count=0;
readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(!m.id)return;
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'observe'}]}:{content:[{type:'text',text:String(++count)},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
  const cua = createSharedCua({ mcpCommand: process.execPath, mcpArgs: [script] });
  t.after(() => cua.close());
  const signal = new AbortController().signal;
  assert.equal(payload(await cua.call({ action: "computer_tools" }, signal)).tools[0].name, "observe");
  assert.equal((await cua.call({ action: "computer_call", tool_name: "observe" }, signal)).content[0].text, "1");
  const next = await cua.call({ action: "computer_call", tool_name: "observe" }, signal);
  assert.equal(next.content[0].text, "2"); assert.equal(next.content[1].type, "image");
  cua.close();
  await assert.rejects(cua.call({ action: "computer_tools" }, signal), /disconnected/);
});

test("a protected directory spelled in another case is still refused", async t => {
  const { dir, folder, grant, run } = await fixture(t);
  if (!(await spellings(dir)).case) return t.skip("this filesystem is case-sensitive, so no case variant names the same directory");
  await mkdir(path.join(dir, "OpenMausBot"));
  await writeFile(path.join(dir, "OpenMausBot", "credentials.bin"), "credential blob");
  grant.protectedPaths = [path.join(dir, "OpenMausBot")];
  folder.write = true;
  await assert.rejects(run({ action: "read_file", path: "OpenMausBot/credentials.bin" }), /Desktop credentials/);
  await assert.rejects(run({ action: "read_file", path: "openmausbot/credentials.bin" }), /Desktop credentials/);
  await assert.rejects(run({ action: "read_file", path: "OPENMAUSBOT/credentials.bin" }), /Desktop credentials/);
  await assert.rejects(run({ action: "list_files", path: "openmausbot" }), /Desktop credentials/);
  await assert.rejects(run({ action: "write_file", path: "openmausbot/computer-sharing.json", content: "{}" }), /sharing settings/);
});

test("a protected directory spelled in another Unicode normalization is still refused", async t => {
  const { dir, folder, grant, run } = await fixture(t);
  if (!(await spellings(dir)).normalization) return t.skip("this filesystem keeps Unicode normalizations apart");
  const composed = "Caf\u00e9";
  const decomposed = "Cafe\u0301";
  await mkdir(path.join(dir, composed));
  await writeFile(path.join(dir, composed, "computer-sharing.json"), "{}");
  grant.protectedPaths = [path.join(dir, composed)];
  folder.write = true;
  await assert.rejects(run({ action: "read_file", path: `${composed}/computer-sharing.json` }), /sharing settings/);
  await assert.rejects(run({ action: "read_file", path: `${decomposed}/computer-sharing.json` }), /sharing settings/);
  await assert.rejects(run({ action: "list_files", path: decomposed }), /sharing settings/);
  await assert.rejects(run({ action: "write_file", path: `${decomposed}/planted.json`, content: "{}" }), /sharing settings/);
});

test("the picker refuses the home directory, anything above it, and volume roots", async t => {
  const { dir } = await fixture(t);
  const refuse = candidate => assert.rejects(validateSharedFolders([{ id: randomUUID(), path: candidate, write: true }]), /specific folders/, candidate);
  const home = await realpath(homedir());
  const homes = [home];
  if (process.platform === "darwin") {
    const alias = path.join("/System/Volumes/Data", path.resolve(homedir()));
    try {
      const actual = await stat(home, { bigint: true });
      const alternate = await stat(alias, { bigint: true });
      if (actual.dev === alternate.dev && actual.ino === alternate.ino) homes.push(await realpath(alias));
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  for (let candidate of homes) {
    for (;;) {
      await refuse(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  await refuse(path.parse(dir).root);
  // /home may be macOS autofs, a Linux home ancestor, or an unrelated ordinary
  // folder on a custom-home host. Only an actual mount root is always refused.
  if (process.platform !== "win32") {
    for (const candidate of ["/home", "/System/Volumes/Data"]) {
      try {
        if ((await stat(candidate, { bigint: true })).dev !== (await stat(path.dirname(candidate), { bigint: true })).dev) await refuse(candidate);
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    }
  }
});

test("the picker fails closed when the home boundary cannot be inspected", async t => {
  const { dir } = await fixture(t);
  const parent = path.join(dir, "Users");
  const home = path.join(parent, "person");
  await mkdir(home, { recursive: true });
  t.mock.method(os, "homedir", () => home);
  // These errors stand in for an unavailable mounted home or a permission
  // failure; all filesystem contents and candidates remain in the fixture.
  for (const method of ["realpath", "stat"]) {
    for (const inaccessible of [home, parent]) {
      if (method === "realpath" && inaccessible === parent) continue;
      const original = fs[method];
      const failing = t.mock.method(fs, method, async (candidate, ...options) => {
        if (candidate === inaccessible) throw Object.assign(new Error("fixture home boundary unavailable"), { code: "EACCES" });
        return original(candidate, ...options);
      });
      try {
        await assert.rejects(validateSharedFolders([{ id: randomUUID(), path: dir, write: true }]), /home boundary unavailable/);
      } finally { failing.mock.restore(); }
    }
  }
});

test("a specific nested folder is still shareable, readable and writable", async t => {
  const { dir } = await fixture(t);
  const nested = path.join(dir, "Projects", "notes");
  await mkdir(nested, { recursive: true });
  const [shared] = await validateSharedFolders([{ id: randomUUID(), path: nested, write: true }]);
  assert.equal(shared.path, await realpath(nested));
  const grant = { enabled: true, folders: [shared], terminal: false, computer: false, protectedPaths: [path.join(dir, "never-created"), path.join(dir, "Projects", "vault")] };
  const run = operation => executeSharedOperation(grant, { folder_id: shared.id, ...operation }, new AbortController().signal);
  await run({ action: "write_file", path: "todo.md", content: "ship it" });
  assert.equal(payload(await run({ action: "read_file", path: "todo.md" })).content, "ship it");
  assert.equal(payload(await run({ action: "list_files" })).entries[0].name, "todo.md");
  await mkdir(path.join(nested, "deeper"));
  await run({ action: "write_file", path: "deeper/todo.md", content: "still fine" });
  assert.equal(await readFile(path.join(nested, "deeper", "todo.md"), "utf8"), "still fine");
});

test("protected roots are rechecked after first creation and lookup failures deny access", async t => {
  const { dir, folder, grant, run } = await fixture(t);
  const protectedRoot = path.join(dir, "later-installed");
  grant.protectedPaths = [protectedRoot];
  folder.write = true;
  await run({ action: "write_file", path: "ordinary.txt", content: "allowed" });
  await mkdir(protectedRoot);
  await writeFile(path.join(protectedRoot, "credentials.json"), "fixture secret");
  await assert.rejects(run({ action: "read_file", path: "later-installed/credentials.json" }), /Desktop credentials/);
  await assert.rejects(run({ action: "write_file", path: "later-installed/new.json", content: "blocked" }), /sharing settings/);
  await assert.rejects(stat(path.join(protectedRoot, "new.json")), { code: "ENOENT" });
  const original = fs.stat;
  t.mock.method(fs, "stat", async (candidate, ...options) => {
    if (candidate === protectedRoot) throw Object.assign(new Error("fixture protected root unavailable"), { code: "EACCES" });
    return original(candidate, ...options);
  });
  await assert.rejects(run({ action: "read_file", path: "ordinary.txt" }), /protected root unavailable/);
});

test("filesystem identities keep all 64 bits instead of rounding distinct inode numbers together", async t => {
  const { dir, grant, run } = await fixture(t);
  const protectedRoot = path.join(dir, "private");
  const ordinary = path.join(dir, "ordinary.txt");
  await mkdir(protectedRoot);
  await writeFile(ordinary, "allowed");
  grant.protectedPaths = [protectedRoot];
  const original = fs.stat;
  t.mock.method(fs, "stat", async (candidate, ...options) => {
    const info = await original(candidate, ...options);
    const inode = candidate === protectedRoot ? 9007199254740992n : candidate === ordinary ? 9007199254740993n : undefined;
    if (inode !== undefined) info.ino = typeof info.ino === "bigint" ? inode : Number(inode);
    return info;
  });
  assert.equal(payload(await run({ action: "read_file", path: "ordinary.txt" })).content, "allowed");
});

test("the harness data directory is protected through a broad share", async t => {
  const { dir } = await fixture(t);
  const shared = path.join(dir, "share");
  const dataDir = path.join(shared, ".openmausbot");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ anthropicApiKey: "sk-fixture" }));
  const stub = stubWorkspace();
  stub.state.work.push({ action: "read_file", path: ".openmausbot/config.json" });
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: stub.fetchImpl,
    environments: () => [stub.env], enabled: async () => true, cuaConnection: async () => null, protectedPaths: [dataDir],
  });
  t.after(() => sharing.close());
  const info = await sharing.identity(stub.env);
  await sharing.save(stub.env, { folders: [{ id: randomUUID(), path: shared, write: true }], terminal: false, computer: false }, info);
  const result = await stub.state.delivered;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Desktop credentials/);
});

test("a harness data directory that does not exist yet still saves and connects", async t => {
  const { dir } = await fixture(t);
  const shared = path.join(dir, "share");
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, "note.txt"), "ordinary file");
  const stub = stubWorkspace();
  stub.state.work.push({ action: "read_file", path: "note.txt" });
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: stub.fetchImpl,
    environments: () => [stub.env], enabled: async () => true, cuaConnection: async () => null, protectedPaths: [path.join(dir, "never-installed", ".openmausbot")],
  });
  t.after(() => sharing.close());
  const info = await sharing.identity(stub.env);
  assert.equal((await sharing.save(stub.env, { folders: [{ id: randomUUID(), path: shared, write: false }], terminal: false, computer: false }, info)).enabled, true);
  const result = await stub.state.delivered;
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).content, "ordinary file");
  assert.equal(stub.state.connected.folders.length, 1);
});
