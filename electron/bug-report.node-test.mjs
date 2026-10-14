import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  BUG_REPORT_ERRORS,
  BUG_REPORT_LOG_TAIL_BYTES,
  BUG_REPORT_TEXT_MAX_BYTES,
  bugReportFailure,
  createBugReporter,
  installId,
  registerBugReportIpc,
} from "./bug-report.mjs";
import { collectDiagnostics } from "./diagnostics.mjs";

const require = createRequire(import.meta.url);
const localOrigin = require("./local-origin.cjs");

const ENV_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const LOCAL = "http://127.0.0.1:48993";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
const bytes = (text) => Buffer.byteLength(text, "utf8");

function dataDir(id = ENV_ID) {
  const dir = mkdtempSync(join(tmpdir(), "omb-bug-report-"));
  if (id !== null) writeFileSync(join(dir, "environment-id"), `${id}\n`);
  return dir;
}

function reporter({ answer = () => Response.json({ id: "br_1" }, { status: 201 }), chat = "", diagnostics = "OpenMausBot diagnostics\n", dir = dataDir() } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(LOCAL)) return new Response(chat, { status: chat === null ? 404 : 200 });
    return answer(init);
  };
  const diagnosed = [];
  const instance = createBugReporter({
    diagnostics: async (maxLogBytes) => { diagnosed.push(maxLogBytes); return diagnostics; },
    localServer: () => LOCAL,
    dataDir: () => dir,
    appVersion: "0.1.109",
    platform: "darwin-arm64",
    fetch,
  });
  const sent = () => calls.filter((call) => call.url.startsWith("https://")).map((call) => JSON.parse(call.init.body));
  return { ...instance, calls, sent, diagnosed, dir };
}

test("sends the contract's fields to the Cloud's bug-report endpoint, without the conversation unless asked", async () => {
  const r = reporter();
  assert.deepEqual(await r.send({ description: "  Team tools never connect.  ", source: "button", threadId: "t1" }), { ok: true, id: "br_1" });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "https://cloud.openmausbot.com/api/bug-reports");
  assert.equal(r.calls[0].init.method, "POST");
  assert.equal(r.calls[0].init.redirect, "error");
  assert.equal(r.calls[0].init.credentials, "omit");
  assert.deepEqual(r.sent(), [{
    installId: ENV_ID, appVersion: "0.1.109", platform: "darwin-arm64",
    diagnostics: "OpenMausBot diagnostics\n", source: "button", description: "Team tools never connect.",
  }]);
  assert.deepEqual(r.diagnosed, [BUG_REPORT_LOG_TAIL_BYTES]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("includes the open conversation only when ticked: read from the local server, masked, and cut to its newest 256 KB", async () => {
  const older = Array.from({ length: 6000 }, (_, index) => `**Scout:** older line ${index} ${"x".repeat(40)}`).join("\n");
  const chat = `# Build\n\n${older}\n\n**You:** my key is ${KEY}\n\n**Scout:** the newest line`;
  const r = reporter({ chat });
  await r.send({ description: "Broken", source: "bot", threadId: "thread-1", includeChatLog: true });
  assert.equal(r.calls[0].url, `${LOCAL}/api/threads/thread-1/export?format=markdown`);
  const [body] = r.sent();
  assert.equal(body.source, "bot");
  assert.ok(bytes(body.chatLog) <= BUG_REPORT_TEXT_MAX_BYTES, `${bytes(body.chatLog)} bytes`);
  assert.ok(body.chatLog.endsWith("**Scout:** the newest line"));
  assert.ok(!body.chatLog.includes("# Build"), "the oldest lines are the ones left out");
  assert.ok(!body.chatLog.includes(KEY));
  assert.match(body.chatLog, /my key is «redacted \d+ chars»/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("a thread id that is not one is never put into the local server's URL", async () => {
  const r = reporter({ chat: "hello" });
  await r.send({ description: "Broken", source: "button", threadId: "../config", includeChatLog: true });
  assert.equal(r.calls.length, 1);
  assert.equal("chatLog" in r.sent()[0], false);
  rmSync(r.dir, { recursive: true, force: true });
});

test("says so in the conversation's place when it cannot be read", async () => {
  const r = reporter({ chat: null });
  const preview = await r.preview({ threadId: "t1", includeChatLog: true });
  assert.equal(preview.chatLog, BUG_REPORT_ERRORS.chatUnavailable);
  rmSync(r.dir, { recursive: true, force: true });
});

test("caps the diagnostics at 256 KB, and the preview is what a send carries", async () => {
  const diagnostics = Array.from({ length: 9000 }, (_, index) => `line ${index} ${"y".repeat(30)}`).join("\n");
  const r = reporter({ diagnostics, chat: "**You:** hi" });
  const preview = await r.preview({ threadId: "t1", includeChatLog: true });
  assert.ok(bytes(preview.diagnostics) <= BUG_REPORT_TEXT_MAX_BYTES);
  assert.ok(preview.diagnostics.startsWith("line 0 "));
  await r.send({ description: "Broken", source: "button", threadId: "t1", includeChatLog: true });
  const { description, source, ...carried } = r.sent()[0];
  assert.deepEqual(carried, preview);
  assert.deepEqual([description, source], ["Broken", "button"]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("each log tail in the diagnostics is cut to 64 KB", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "omb-bug-report-logs-"));
  const lines = (name) => Array.from({ length: 4000 }, (_, index) => `${name} ${index} ${"z".repeat(40)}`).join("\n") + "\n";
  writeFileSync(join(logDir, "server.log"), lines("server"));
  writeFileSync(join(logDir, "updater.log"), lines("updater"));
  writeFileSync(join(logDir, "desktop-crashes.log"), lines("crash"));
  const report = await collectDiagnostics({
    configUrl: "http://127.0.0.1:9/api/config", logDir, desktopCrashLog: join(logDir, "desktop-crashes.log"),
    appInfo: { version: "0.1.109" }, maxLogBytes: BUG_REPORT_LOG_TAIL_BYTES, fetch: async () => Response.json({ composio: true }),
  });
  for (const name of ["server", "updater", "crash"]) {
    const kept = report.split("\n").filter((line) => line.startsWith(`${name} `));
    assert.ok(kept.length > 100 && kept.length < 4000, `${name}: ${kept.length} lines`);
    assert.ok(bytes(kept.join("\n")) <= BUG_REPORT_LOG_TAIL_BYTES, name);
    assert.equal(kept.at(-1), `${name} 3999 ${"z".repeat(40)}`);
  }
  assert.match(report, /^composio=true$/m);
  rmSync(logDir, { recursive: true, force: true });
});

test("maps every refusal to one plain sentence, and 429 to when to try again", () => {
  assert.deepEqual(bugReportFailure(400, { error: "description must be at most 10000 characters." }),
    { ok: false, error: "The report was not accepted: description must be at most 10000 characters." });
  assert.deepEqual(bugReportFailure(400, null), { ok: false, error: "The report was not accepted. Update OpenMausBot and try again." });
  assert.deepEqual(bugReportFailure(413, {}), { ok: false, error: BUG_REPORT_ERRORS.tooLarge });
  assert.deepEqual(bugReportFailure(413, {}, { withChat: true }), { ok: false, error: BUG_REPORT_ERRORS.tooLargeWithChat });
  assert.deepEqual(bugReportFailure(429, { error: "slow down", retryAfter: 600 }),
    { ok: false, error: "Too many reports were sent from this computer. Try again in 10 minutes.", retryAfter: 600 });
  assert.deepEqual(bugReportFailure(429, {}, { headers: new Headers({ "retry-after": "30" }) }),
    { ok: false, error: "Too many reports were sent from this computer. Try again in 1 minute.", retryAfter: 30 });
  assert.deepEqual(bugReportFailure(429, {}), { ok: false, error: "Too many reports were sent from this computer. Try again later." });
  assert.deepEqual(bugReportFailure(503, {}), { ok: false, error: BUG_REPORT_ERRORS.server });
});

test("answers the person with those sentences: offline, refused, rate-limited, or an answer without an id", async () => {
  const cases = [
    [() => { throw new TypeError("fetch failed"); }, { ok: false, error: BUG_REPORT_ERRORS.offline }],
    [() => Response.json({ error: "too big" }, { status: 413 }), { ok: false, error: BUG_REPORT_ERRORS.tooLarge }],
    [() => Response.json({ error: "slow down", retryAfter: 3600 }, { status: 429 }), { ok: false, error: "Too many reports were sent from this computer. Try again in 60 minutes.", retryAfter: 3600 }],
    [() => new Response("<html>bad gateway</html>", { status: 502 }), { ok: false, error: BUG_REPORT_ERRORS.server }],
    [() => Response.json({}, { status: 201 }), { ok: false, error: BUG_REPORT_ERRORS.server }],
  ];
  for (const [answer, expected] of cases) {
    const r = reporter({ answer });
    assert.deepEqual(await r.send({ description: "Broken", source: "button" }), expected);
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("sends nothing without a description, and one report at a time", async () => {
  let release;
  const r = reporter({ answer: () => new Promise((resolve) => { release = () => resolve(Response.json({ id: "br_2" }, { status: 201 })); }) });
  assert.deepEqual(await r.send({ description: "   ", source: "button" }), { ok: false, error: BUG_REPORT_ERRORS.empty });
  assert.equal(r.calls.length, 0);
  const first = r.send({ description: "Broken", source: "button" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await r.send({ description: "Broken again", source: "button" }), { ok: false, error: BUG_REPORT_ERRORS.busy });
  release();
  assert.deepEqual(await first, { ok: true, id: "br_2" });
  assert.equal(r.sent().length, 1);
  rmSync(r.dir, { recursive: true, force: true });
});

test("the install id is the server's environment id, created once when missing and never replaced when unreadable", () => {
  const existing = dataDir();
  assert.equal(installId(existing), ENV_ID);
  const missing = dataDir(null);
  const made = installId(missing);
  assert.match(made, /^[0-9a-f-]{36}$/);
  assert.equal(installId(missing), made);
  assert.equal(readFileSync(join(missing, "environment-id"), "utf8"), `${made}\n`);
  const broken = dataDir("not-a-uuid");
  const fresh = installId(broken);
  assert.notEqual(fresh, "not-a-uuid");
  assert.equal(readFileSync(join(broken, "environment-id"), "utf8"), "not-a-uuid\n");
  for (const dir of [existing, missing, broken]) rmSync(dir, { recursive: true, force: true });
});

const from = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

test("both channels answer only the local server's page", async () => {
  const handlers = new Map();
  const reached = [];
  registerBugReportIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    send: async (input) => { reached.push(["send", input]); return { ok: true, id: "br_3" }; },
    preview: async (input) => { reached.push(["preview", input]); return { diagnostics: "" }; },
  });
  assert.deepEqual([...handlers.keys()], ["desktop:send-bug-report", "desktop:preview-bug-report"]);
  localOrigin.setLocalOrigin(null);
  assert.throws(() => handlers.get("desktop:send-bug-report")(from(`${LOCAL}/`), { description: "x" }), /only available while using the local server/);
  localOrigin.setLocalOrigin(LOCAL);
  for (const event of [from("https://remote.example.test/"), from("http://127.0.0.1:48994/"), from("about:blank"), {}]) {
    for (const channel of handlers.keys()) {
      assert.throws(() => handlers.get(channel)(event, { description: "x" }), /only available while using the local server/, channel);
    }
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(await handlers.get("desktop:send-bug-report")(from(`${LOCAL}/`), { description: "x" }), { ok: true, id: "br_3" });
  assert.deepEqual(await handlers.get("desktop:preview-bug-report")(from(`${LOCAL}/`), { threadId: "t1" }), { diagnostics: "" });
  assert.deepEqual(reached, [["send", { description: "x" }], ["preview", { threadId: "t1" }]]);
  localOrigin.setLocalOrigin(null);
});

test("main registers the channels only through registerBugReportIpc", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /^registerBugReportIpc\(ipcMain, createBugReporter\(/m);
  assert.equal(/ipcMain\.handle\("desktop:(?:send|preview)-bug-report"/.test(main), false);
});

function loadPreload(origin) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`] },
    location: { origin },
    navigator: {},
    TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync() { return false; }, invoke: (...args) => { invoked.push(args); return Promise.resolve(null); } },
    }),
  });
  return { bridge, invoked };
}

test("the bridge offers sending and previewing to the local page only", async () => {
  const remote = loadPreload("https://remote.example.test");
  assert.equal(remote.bridge.sendBugReport, undefined);
  assert.equal(remote.bridge.previewBugReport, undefined);
  const local = loadPreload(LOCAL);
  await local.bridge.sendBugReport({ description: "x", source: "button" });
  await local.bridge.previewBugReport({ threadId: "t1", includeChatLog: true });
  assert.deepEqual(local.invoked, [
    ["desktop:send-bug-report", { description: "x", source: "button" }],
    ["desktop:preview-bug-report", { threadId: "t1", includeChatLog: true }],
  ]);
});
