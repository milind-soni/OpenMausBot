import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

test("legacy insecure saved addresses never receive sharing credentials", async t => {
  const { dir } = await fixture(t);
  let calls = 0;
  const sharing = createComputerSharing({ file: path.join(dir, "profile", "sharing.json"), environments: () => [], cuaConnection: async () => null, fetch: async () => { calls++; throw new Error("unexpected network"); } });
  t.after(() => sharing.close());
  await assert.rejects(sharing.observe({ id: "old", origin: "http://old-server.example", name: "Legacy" }), /HTTPS/);
  assert.equal(calls, 0);
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
