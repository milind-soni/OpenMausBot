// The Mac is the authority over what it lends. These tests play a hostile or
// prompt-injected server against the real connector and executor: whatever
// the server sends, only what the person lent runs here, and every attempt is
// in the Mac's own activity log.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createComputerSharing, validSharedOperation } from "./computer-sharing.mjs";
import { createSharedCua, executeSharedOperation, LENT_SCREEN_TOOLS } from "./shared-computer-access.mjs";
import { createLendingActivity } from "./lending-activity.mjs";

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lending-guards-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A server that pairs, then hands out the scripted jobs one per poll and
 * keeps every answer. Raw jobs are sent exactly as given. */
function scriptedServer(jobs) {
  const env = { id: "cloud-fixture", name: "Fixture Cloud", origin: "https://cloud.fixture.test" };
  const json = value => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const results = [];
  let registration = null;
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const queue = [...jobs];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: env.sessionId });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: env.environmentId, capabilities: { sharedComputers: true } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { registration = body; return json({}); }
    if (route.endsWith("/poll")) {
      const next = queue.shift();
      if (!next) { finished(results); throw new Error("no more work"); }
      const operation = typeof next === "function" ? next(registration) : { computer_id: registration.id, folder_id: registration.folders[0]?.id, ...next };
      return json({ job: { id: randomUUID(), operation } });
    }
    if (route.endsWith("/lease")) return json({ active: true });
    if (route.endsWith("/result")) { results.push(body.result); return json({}); }
    if (route.endsWith("/disconnect")) return json({});
    throw new Error(`no route ${route}`);
  };
  env.sessionId = randomUUID(); env.environmentId = randomUUID();
  return { env, fetchImpl, done, registration: () => registration };
}

async function lend(t, dir, { jobs, folders, terminal = false, computer = false, home, cuaConnection = async () => null }) {
  const server = scriptedServer(jobs);
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: server.fetchImpl, environments: () => [server.env],
    enabled: async () => true, cuaConnection, home: home ?? path.join(dir, "no-home"),
  });
  t.after(() => sharing.close());
  await sharing.save(server.env, { folders, terminal, computer }, await sharing.identity(server.env));
  const results = await server.done;
  return { results, sharing, server };
}
const text = result => result.content?.[0]?.text ?? "";

test("a read-only folder never reaches a shell, a write or the screen, whatever the server sends", async t => {
  const dir = await scratch(t);
  const shared = path.join(dir, "Docs");
  await mkdir(shared);
  await writeFile(path.join(shared, "plan.md"), "original");
  const folder = { id: randomUUID(), path: shared, write: false };
  const { results, sharing } = await lend(t, dir, {
    folders: [folder],
    jobs: [
      { action: "run_command", command: `echo pwned > ${JSON.stringify(path.join(dir, "pwned"))}` },
      { action: "write_file", path: "plan.md", content: "changed", expected_sha256: "0".repeat(64) },
      { action: "write_file", path: "new.md", content: "planted" },
      { action: "computer_tools" },
      { action: "computer_call", tool_name: "type_text", arguments: { text: "rm -rf ~" } },
      { action: "read_file", path: "plan.md" },
    ],
  });
  assert.equal(results.length, 6);
  for (const refused of results.slice(0, 5)) assert.equal(refused.isError, true, text(refused));
  assert.match(text(results[0]), /Terminal access/);
  assert.match(text(results[1]), /read-only/);
  assert.match(text(results[3]), /Computer control/);
  assert.equal(JSON.parse(text(results[5])).content, "original");
  assert.equal(await readFile(path.join(shared, "plan.md"), "utf8"), "original");
  await assert.rejects(stat(path.join(shared, "new.md")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(dir, "pwned")), { code: "ENOENT" });
  // The person can read every attempt on this Mac, refused ones included.
  const log = sharing.activity();
  assert.deepEqual(log.map(entry => [entry.action, entry.ok]).reverse(), [
    ["run_command", false], ["write_file", false], ["write_file", false], ["computer_tools", false], ["computer_call", false], ["read_file", true],
  ]);
  assert.equal(log[0].detail, "Docs/plan.md");
  assert.equal(log.at(-1).detail.startsWith("echo pwned"), true);
  assert.ok(log.every(entry => entry.server === "Fixture Cloud" && entry.origin === "https://cloud.fixture.test"));
  assert.doesNotMatch(JSON.stringify(log), /original|changed|planted|rm -rf/);
});

test("a read-only share around the person's keys never exposes them (read-only → shell)", async t => {
  const dir = await scratch(t);
  const home = path.join(dir, "home");
  for (const [relative, content] of [[".ssh/id_ed25519", "PRIVATE KEY"], [".aws/credentials", "aws_secret"], [".config/gh/hosts.yml", "oauth_token"], ["Library/Keychains/login.keychain-db", "keychain"], [".codex/auth.json", "codex"], ["notes/todo.md", "ordinary"]]) {
    await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await writeFile(path.join(home, relative), content);
  }
  const folder = { id: randomUUID(), path: home, write: false };
  const { results } = await lend(t, dir, {
    home, folders: [folder],
    jobs: [
      { action: "read_file", path: ".ssh/id_ed25519" },
      { action: "read_file", path: ".aws/credentials" },
      { action: "list_files", path: ".config/gh" },
      { action: "read_file", path: "Library/Keychains/login.keychain-db" },
      { action: "read_file", path: ".codex/auth.json" },
      { action: "read_file", path: "notes/todo.md" },
      { action: "list_files" },
    ],
  });
  for (const refused of results.slice(0, 5)) {
    assert.equal(refused.isError, true, text(refused));
    assert.match(text(refused), /cannot be accessed through a shared folder/);
    assert.doesNotMatch(text(refused), /PRIVATE KEY|aws_secret|oauth_token|keychain|codex/);
  }
  assert.equal(JSON.parse(text(results[5])).content, "ordinary");
  const listed = Object.fromEntries(JSON.parse(text(results[6])).entries.map(entry => [entry.name, entry.type]));
  assert.equal(listed[".ssh"], "protected");
  assert.equal(listed[".aws"], "protected");
  assert.equal(listed.notes, "directory");
});

test("a writable folder never reaches git's configuration, hooks or login items (write → exec)", async t => {
  const dir = await scratch(t);
  const home = path.join(dir, "home");
  const repo = path.join(home, "code", "app");
  await mkdir(path.join(repo, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n");
  await mkdir(path.join(repo, "vendor", "lib", ".git"), { recursive: true });
  await mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  const configHash = (await import("node:crypto")).createHash("sha256").update("[core]\n\tbare = false\n").digest("hex");
  const { results } = await lend(t, dir, {
    home, folders: [{ id: randomUUID(), path: repo, write: true }],
    jobs: [
      { action: "write_file", path: ".git/config", content: "[core]\n\tfsmonitor = \"touch pwned\"\n", expected_sha256: configHash },
      { action: "write_file", path: ".GIT/hooks/pre-commit", content: "#!/bin/sh\ntouch pwned\n" },
      { action: "write_file", path: "vendor/lib/.Git/config", content: "x" },
      { action: "write_file", path: "src/main.js", content: "console.log('ok')" },
      { action: "read_file", path: ".git/config" },
    ],
  });
  for (const refused of results.slice(0, 3)) { assert.equal(refused.isError, true); assert.match(text(refused), /\.git/); }
  assert.equal(results[3].isError, true, "src/ does not exist; a missing parent is an ordinary error");
  assert.equal(JSON.parse(text(results[4])).content, "[core]\n\tbare = false\n");
  assert.equal(await readFile(path.join(repo, ".git", "config"), "utf8"), "[core]\n\tbare = false\n");
  await assert.rejects(stat(path.join(repo, ".git", "hooks", "pre-commit")), { code: "ENOENT" });

  const agents = await lend(t, await scratch(t), {
    home, folders: [{ id: randomUUID(), path: path.join(home, "Library"), write: true }],
    jobs: [{ action: "write_file", path: "LaunchAgents/com.evil.plist", content: "<plist/>" }],
  });
  assert.equal(agents.results[0].isError, true);
  assert.match(text(agents.results[0]), /cannot be accessed through a shared folder/);
  await assert.rejects(stat(path.join(home, "Library", "LaunchAgents", "com.evil.plist")), { code: "ENOENT" });
});

test("lent apps and screen offer only on-screen tools; silent file and install tools never reach the driver", async t => {
  const dir = await scratch(t);
  const calls = path.join(dir, "calls.log");
  const script = path.join(dir, "cua-fixture.mjs");
  await writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs';
readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(!m.id)return;
if(m.method==='tools/call') fs.appendFileSync(${JSON.stringify(calls)}, m.params.name+'\\n');
const names=['click','type_text','get_window_state','browser_set_input_files','install_ffmpeg','set_config','start_recording','replay_trajectory','kill_app','browser_prepare'];
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:names.map(name=>({name}))}:{content:[{type:'text',text:'done'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
  const cua = createSharedCua({ mcpCommand: process.execPath, mcpArgs: [script] });
  t.after(() => cua.close());
  const signal = new AbortController().signal;
  const offered = JSON.parse((await cua.call({ action: "computer_tools" }, signal)).content[0].text).tools.map(tool => tool.name);
  assert.deepEqual(offered, ["click", "type_text", "get_window_state"]);
  for (const name of ["browser_set_input_files", "install_ffmpeg", "set_config", "start_recording", "replay_trajectory", "kill_app", "browser_prepare", "not_a_tool"]) {
    await assert.rejects(cua.call({ action: "computer_call", tool_name: name, arguments: { paths: ["/Users/me/.ssh/id_ed25519"] } }, signal), /not part of lent apps and screen/, name);
  }
  assert.equal((await cua.call({ action: "computer_call", tool_name: "click", arguments: {} }, signal)).content[0].text, "done");
  assert.equal(await readFile(calls, "utf8"), "click\n");
  for (const name of offered) assert.ok(LENT_SCREEN_TOOLS.has(name));
});

test("malformed jobs are refused before anything runs, and the connector keeps serving", async t => {
  const dir = await scratch(t);
  const shared = path.join(dir, "Docs");
  await mkdir(shared);
  await writeFile(path.join(shared, "a.txt"), "fine");
  const { results, sharing } = await lend(t, dir, {
    folders: [{ id: randomUUID(), path: shared, write: true }],
    jobs: [
      registration => ({ computer_id: registration.id, folder_id: registration.folders[0].id, action: "read_file", path: ["a.txt"] }),
      registration => ({ computer_id: registration.id, folder_id: registration.folders[0].id, action: "read_file", path: "a.txt", sneaky: true }),
      registration => ({ computer_id: registration.id, action: "computer_call", tool_name: "click", arguments: ["not", "an", "object"] }),
      registration => ({ computer_id: randomUUID(), folder_id: registration.folders[0].id, action: "read_file", path: "a.txt" }),
      { action: "read_file", path: "a.txt" },
    ],
  });
  for (const refused of results.slice(0, 4)) assert.match(text(refused), /Invalid computer request/);
  assert.equal(JSON.parse(text(results[4])).content, "fine");
  assert.equal(sharing.activity().filter(entry => entry.action === "invalid").length, 4);
  assert.equal(validSharedOperation({ computer_id: "x", action: "read_file" }, "x"), true);
  assert.equal(validSharedOperation({ computer_id: "x", action: "delete_file" }, "x"), false);
  assert.equal(validSharedOperation({ computer_id: "x", action: "read_file", encoding: "hex" }, "x"), false);
  assert.equal(validSharedOperation(null, "x"), false);
});

test("the activity log is owner-only, bounded and survives a restart", async t => {
  const dir = await scratch(t);
  const file = path.join(dir, "profile", "lending-activity.jsonl");
  const log = createLendingActivity(file);
  for (let index = 0; index < 520; index++) log.record({ env: { name: "Cloud", origin: "https://c.test" }, action: "read_file", detail: `n${index}`, ok: true });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reopened = createLendingActivity(file);
  const entries = reopened.list(1000);
  assert.equal(entries.length, 500);
  assert.equal(entries[0].detail, "n519");
  assert.equal(entries.at(-1).detail, "n20");
  reopened.record({ env: { name: "Cloud\u0000\n", origin: "x" }, action: "run_command", detail: "a\nb", ok: false, error: "boom" });
  assert.deepEqual({ ...reopened.list(1)[0], at: 0 }, { at: 0, server: "Cloud ", origin: "x", action: "run_command", detail: "a b", ok: false, error: "boom" });
});

test("direct executor: .git components are refused for writes in any case", async t => {
  const dir = await scratch(t);
  const folder = { id: randomUUID(), name: "Repo", path: dir, write: true };
  await mkdir(path.join(dir, ".git"));
  const grant = { enabled: true, folders: [folder], terminal: false, computer: false };
  const run = operation => executeSharedOperation(grant, { folder_id: folder.id, ...operation }, new AbortController().signal);
  for (const candidate of [".git/config", ".GIT/config", "a/.gIt/x", ".git"]) await assert.rejects(run({ action: "write_file", path: candidate, content: "x" }), /\.git/, candidate);
  const inside = { id: randomUUID(), name: ".git", path: path.join(dir, ".git"), write: true };
  await assert.rejects(executeSharedOperation({ ...grant, folders: [inside] }, { folder_id: inside.id, action: "write_file", path: "config", content: "x" }, new AbortController().signal), /\.git/);
  await run({ action: "write_file", path: ".gitignore", content: "node_modules\n" });
  await run({ action: "write_file", path: "git.txt", content: "fine" });
  assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "node_modules\n");
});
