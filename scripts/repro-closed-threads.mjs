#!/usr/bin/env node
// Reproduce: threads a bot opens with start_thread and later closes with
// close_thread stay in the sidebar. Runs an isolated OpenMausBot server on a
// throwaway data dir with the repository's fake engine, then drives the same
// internal endpoints the agents tools hit. Never touches the user's app data.
//
//   node scripts/repro-closed-threads.mjs
//
// Ctrl-C stops the server and removes the fixture data.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dirname, "..");
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");
// Serves the built UI from dist/ when present (run `npx vite build` first).
const STATIC_DIR = process.env.REPRO_STATIC_DIR || join(ROOT, "dist");
const TEST_KEY = randomBytes(24).toString("hex");

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});
const portFree = (port) => new Promise((resolve) => {
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});
let port;
for (;;) { port = await freePort(); if (await portFree(port + 1)) break; }

const home = mkdtempSync(join(tmpdir(), "omb-closed-threads-repro-"));
writeFileSync(join(home, "config.json"), JSON.stringify({
  threads: { maxConcurrentPerBot: 4 },
  instances: { claude: { driver: "claudeAgent", displayName: "Fake engine", config: { cli: FAKE_CLI } } },
}, null, 2));

const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH,
    HOME: home, USERPROFILE: home, OMB_DATA_DIR: home,
    TMPDIR: home,
    OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_KEY,
    FAKE_CLAUDE_MODE: "happy",
    ...(existsSync(STATIC_DIR) ? { OMB_STATIC_DIR: STATIC_DIR } : {}),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => { try { child.kill("SIGTERM"); } catch {} setTimeout(() => { rmSync(home, { recursive: true, force: true }); process.exit(0); }, 500); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("uncaughtException", (e) => { console.error(e); stop(); });
process.on("unhandledRejection", (e) => { console.error(e); stop(); });

const api = async (method, path, body, headers = {}) => {
  const options = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined && method !== "GET" && method !== "HEAD") options.body = JSON.stringify(body);
  const res = await fetch(base + path, options);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deadline = Date.now() + 30_000;
for (;;) {
  if (child.exitCode !== null) throw new Error("server exited early");
  try { if ((await fetch(`${base}/api/health`)).status === 200) break; } catch {}
  if (Date.now() > deadline) throw new Error("server never became healthy");
  await sleep(150);
}

const { body: { instances } } = await api("GET", "/api/instances");
const model = instances.find((i) => i.instanceId === "claude")?.models?.options?.[0]?.id ?? "claude-sonnet-5";
const createBot = async (name) => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, { name, modelSelection: { instanceId: "claude", model } });
  if (patched.status !== 200) throw new Error(`patch bot ${name}: ${JSON.stringify(patched.body)}`);
  return patched.body.bot;
};
const parker = await createBot("Parker");
const quinn = await createBot("Quinn");
await api("PATCH", `/api/bots/${parker.id}/tasks/${parker.threadId}`, { title: "My own chat with Parker" });
await api("PATCH", `/api/bots/${quinn.id}/tasks/${quinn.threadId}`, { title: "My own chat with Quinn" });
// a couple of threads the PERSON opened, so we can see what the bot's pile does to them
for (const title of ["Plan the launch", "Draft release notes"]) await api("POST", `/api/bots/${parker.id}/tasks`, { title });

const minted = await api("POST", "/api/testing/internal-capability", { botId: parker.id, threadId: parker.threadId, kind: "agents", depth: 0 }, { "x-openmausbot-test-capability": TEST_KEY });
if (minted.status !== 201) throw new Error(`mint: ${minted.status} ${JSON.stringify(minted.body)}`);
const asParker = { authorization: `Bearer ${minted.body.token}` };

const taskOf = async (botId, threadId) => {
  const { body } = await api("GET", "/api/bots?messages=0");
  return body.bots.find((b) => b.id === botId)?.tasks?.find((t) => t.threadId === threadId);
};
const waitIdle = async (botId, threadId) => {
  const until = Date.now() + 30_000;
  for (;;) {
    const task = await taskOf(botId, threadId);
    if (task && !task.busy) return task;
    if (Date.now() > until) throw new Error(`thread ${threadId} never went idle`);
    await sleep(200);
  }
};

const opened = [];
for (let i = 1; i <= 3; i++) {
  const r = await api("POST", "/api/internal/threads", { title: `Helper ${i}: check config`, message: `Look at config ${i} and report back.` }, asParker);
  if (r.status !== 201) throw new Error(`start_thread self ${i}: ${r.status} ${JSON.stringify(r.body)}`);
  opened.push({ botId: parker.id, threadId: r.body.threadId, title: r.body.title ?? `Helper ${i}` });
}
for (let i = 1; i <= 2; i++) {
  const r = await api("POST", "/api/internal/threads", { toBotId: quinn.id, title: `QA ${i}: PR #${100 + i}`, message: `Test PR #${100 + i}.` }, asParker);
  if (r.status !== 201) throw new Error(`start_thread peer ${i}: ${r.status} ${JSON.stringify(r.body)}`);
  opened.push({ botId: quinn.id, threadId: r.body.threadId, title: `QA ${i}` });
}
console.log(`\nopened ${opened.length} bot threads; waiting for their fake turns to finish...`);
for (const o of opened) await waitIdle(o.botId, o.threadId);

const closed = [];
for (const o of opened) {
  const r = await api("POST", `/api/internal/threads/${o.threadId}/close`, {}, asParker);
  if (r.status !== 200) throw new Error(`close ${o.threadId}: ${r.status} ${JSON.stringify(r.body)}`);
  closed.push(r.body);
}

// What the server tells every client about those threads AFTER close:
const { body: after } = await api("GET", "/api/bots?messages=0");
const summary = after.bots.filter((b) => [parker.id, quinn.id].includes(b.id)).map((b) => ({
  bot: b.name,
  tasks: b.tasks.map((t) => ({ title: t.title, openedBy: t.openedBy?.name ?? null, closedBy: t.closedBy?.name ?? null, unread: t.unread ?? false, busy: t.busy ?? false })),
}));
console.log("\n=== server state after close_thread on all bot-opened threads ===");
console.log(JSON.stringify({ closedResponses: closed, bots: summary }, null, 2));
const stamped = summary.flatMap((b) => b.tasks).filter((t) => t.closedBy).length;
console.log(stamped === closed.length ? `
FIXED: all ${closed.length} closed threads carry closedBy. Open the isolated UI (NOT your real app):

    ${base}

Expand Parker and Quinn: the closed helper threads are folded away and only
the person's own threads show. "Show all N threads" lists them dimmed with
"closed by Parker" under the title. Send a message in one and it comes back.
` : `
BUG: only ${stamped} of ${closed.length} closed threads carry a closed marker — the only
trace is an activity message in each transcript, so the sidebar has nothing
to filter on. Open the isolated UI (NOT your real app):

    ${base}

Expand Parker and Quinn in the sidebar. All ${closed.length} closed threads are still
listed, with "opened by Parker" under each, indistinguishable from open ones.
Click one: the last row of the transcript is the "Closed by @Parker" chip.
`);
console.log(`
Server log is inline above. Ctrl-C stops the fixture and deletes ${home}.`);
await new Promise(() => {});
