// Move to Cloud's desktop half against in-memory fakes of this computer's
// server and the Cloud: resuming a dropped upload, refusing a full Cloud,
// stopping before anything is replaced, and the bridge and IPC guards. The
// whole move between two real servers is server/cloud-move.e2e.test.ts.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import environments from "./environments.cjs";
import localOrigin from "./local-origin.cjs";
import { cloudPageSenderAllowed, createCloudMove } from "./cloud-move.mjs";

const ORIGIN = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const UUID = () => "3f9c2a4e-8b1d-4c6e-9a7f-" + randomBytes(6).toString("hex");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** This computer's server: an estimate, an export and its download. */
function desktop({ bytes = 5000, busy = false, exportError = null } = {}) {
  const archive = Buffer.concat([MAGIC, randomBytes(bytes - MAGIC.length)]), calls = [];
  const id = UUID();
  return {
    archive, calls,
    request: async (route, init) => {
      calls.push([init.method, route, init.body ? JSON.parse(init.body) : undefined]);
      if (route === "/api/cloud-move/estimate") return json(200, { bots: 3, rooms: 1, chats: 7, bytes, files: 12 });
      if (route === "/api/workspace-backup/status") return json(200, { busy, pendingRestore: false });
      if (route === "/api/workspace-backup/export") {
        if (exportError) return json(400, { error: exportError });
        return busy ? json(409, { error: "busy" }) : json(200, { id, bytes, summary: { bots: 3, files: 12, messages: 40 } });
      }
      if (route === `/api/workspace-backup/download/${id}`) return new Response(archive, { status: 200, headers: { "content-length": String(bytes) } });
      return json(404, {});
    },
  };
}

/** The Cloud: pairing, the upload slot, jobs, and a restart. */
function cloudFake({ freeBytes = 1024 ** 4, empty = true, failPut = () => false, dropAnswer = () => false, loseAt = 0, busyRestores = 0, storedPart = 0, previewBots = 3 } = {}) {
  const state = { upload: storedPart ? { sha256: "e".repeat(64), bytes: storedPart } : null, received: Buffer.alloc(storedPart), job: null, lastRestoreId: null, restarting: 0,
      previous: null, contents: { bots: 1, rooms: 0, chats: 0 }, empty, discards: 0, restoreAsks: [] },
    log = [], tokens = new Set();
  let lost = false;
  const fetchImpl = async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const { pathname, searchParams } = new URL(url);
    const auth = new Headers(init.headers).get("authorization");
    log.push([init.method ?? "GET", pathname]);
    if (pathname === "/api/auth/pair") {
      assert.equal(JSON.parse(init.body).code, "ABCD-EFGH-JKLM");
      const token = `omb_sess_${randomBytes(8).toString("hex")}`; tokens.add(token);
      return json(200, { token });
    }
    if (!tokens.has(auth?.slice("Bearer ".length))) return json(401, { error: "unauthorized" });
    if (pathname === "/api/auth/logout") { tokens.delete(auth.slice("Bearer ".length)); return json(200, { ok: true }); }
    if (state.restarting > 0) { state.restarting--; throw new TypeError("fetch failed"); }
    if (pathname === "/api/cloud-move" && (init.method ?? "GET") === "GET") {
      return json(200, { contents: state.contents, empty: state.empty, freeBytes, previous: state.previous, job: state.job, pendingRestore: false, busy: false,
        lastRestoreId: state.lastRestoreId, rolledBackId: null, partBytes: 1024,
        upload: state.upload && { ...state.upload, received: state.received.length } });
    }
    const body = init.body && !(init.body instanceof Uint8Array) ? JSON.parse(init.body) : undefined;
    if (pathname === "/api/cloud-move/discard") { state.discards++; if (state.job?.kind === "preview") state.job = null; return json(200, { ok: true }); }
    if (pathname === "/api/cloud-move/upload") {
      if (3 * body.bytes > freeBytes + state.received.length) return json(507, { error: "full", freeBytes, neededBytes: 3 * body.bytes });
      if (state.upload?.sha256 !== body.sha256) { state.upload = { sha256: body.sha256, bytes: body.bytes }; state.received = Buffer.alloc(0); }
      return json(200, { received: state.received.length, partBytes: 1024 });
    }
    if (pathname.startsWith("/api/cloud-move/upload/")) {
      const offset = Number(searchParams.get("offset")), part = Buffer.from(init.body);
      if (failPut(offset)) throw new TypeError("fetch failed");
      if (offset + part.length <= state.received.length) return json(200, { received: state.received.length });
      if (offset !== state.received.length) return json(409, { error: "elsewhere", received: state.received.length });
      state.received = Buffer.concat([state.received, part]);
      const received = state.received.length;
      // Stored, but the answer never arrives: the app sends the part again.
      if (dropAnswer(offset)) throw new TypeError("fetch failed");
      // Answered, then lost (a restart mid-upload): the next part is refused with where it stands.
      if (loseAt && received === loseAt && !lost) { lost = true; state.received = state.received.subarray(0, received - part.length); }
      return json(200, { received });
    }
    if (pathname === "/api/cloud-move/preview") {
      const hash = createHash("sha256").update(state.received).digest("hex");
      assert.equal(hash, state.upload.sha256);
      assert.ok(body.password.length >= 12);
      state.job = { kind: "preview", state: "done", id: UUID(), summary: { bots: previewBots, messages: 40 } };
      return json(202, { job: { kind: "preview", state: "running" } });
    }
    if (pathname === "/api/cloud-move/restore") {
      state.restoreAsks.push(body.id);
      if (busyRestores-- > 0) return json(409, { error: "Another move step is running on your Cloud. Wait for it to finish." });
      assert.equal(body.id, state.job.id);
      state.previous = state.empty ? null : { createdAt: new Date().toISOString(), bots: 2, rooms: 0, chats: 4 };
      state.job = null; state.restarting = 2; state.lastRestoreId = body.id;
      state.contents = { bots: 3, rooms: 1, chats: 7 }; state.empty = false;
      return json(202, { job: { kind: "restore", state: "running" } });
    }
    return json(404, {});
  };
  return { state, log, tokens, fetchImpl };
}

function harness(options = {}) {
  const temp = mkdtempSync(join(tmpdir(), "omb-cloud-move-test-"));
  const local = desktop(options.desktop), cloud = cloudFake(options.cloud), states = [];
  const move = createCloudMove({
    localRequest: local.request, fetchImpl: cloud.fetchImpl, tempRoot: join(temp, "move"),
    pairHome: options.pairHome ?? (async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 })),
    availableBytes: async () => options.localFree ?? 1024 ** 4, sleep: async (_ms, signal) => signal?.throwIfAborted(), pollMs: 0, retryDelaysMs: [0, 0],
    onState: state => { states.push(state); options.onState?.(state, move); },
  });
  return { temp, local, cloud, states, move, done: () => rmSync(temp, { recursive: true, force: true }) };
}

test("moves this computer's archive in parts, waits out the restart, signs its session out and leaves no temporary file", async () => {
  const f = harness();
  try {
    const result = await f.move.move();
    assert.deepEqual(result, { phase: "done", action: "move", moved: { bots: 3, rooms: 1, chats: 7 }, previous: false });
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.deepEqual([...new Set(f.states.map(state => state.phase))], ["preparing", "exporting", "uploading", "checking", "replacing", "restarting", "done"]);
    assert.equal(f.cloud.log.filter(([method, path]) => method === "PUT" && path.startsWith("/api/cloud-move/upload/")).length, 5);
    // The export carried no drafts or window state, and a random password.
    const exported = f.local.calls.find(([, route]) => route === "/api/workspace-backup/export")[2];
    assert.deepEqual(exported.clientState, {});
    assert.ok(exported.password.length >= 40);
    assert.equal(f.cloud.tokens.size, 0, "the move's session was signed out");
    assert.deepEqual(readdirSync(join(f.temp, "move")), []);
  } finally { f.done(); }
});

const puts = f => f.cloud.log.filter(([method, path]) => method === "PUT" && path.startsWith("/api/cloud-move/upload/")).length;
test("continues a dropped upload: a part whose answer was lost is sent again without being stored twice", async () => {
  let drops = 1;
  const f = harness({ cloud: { dropAnswer: offset => offset === 2048 && drops-- > 0 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.equal(puts(f), 6); // 0, 1024, 2048 (answer lost), 2048 again, 3072, 4096
  } finally { f.done(); }
});

test("continues from where the Cloud stands when it lost a part", async () => {
  const f = harness({ cloud: { loseAt: 2048 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.equal(puts(f), 7); // 0, 1024 (then lost), 2048 refused at 1024, 1024, 2048, 3072, 4096
  } finally { f.done(); }
});

test("an upload that keeps failing stops resumable, and moving again continues it without a second export", async () => {
  let failing = true;
  const f = harness({ cloud: { failPut: offset => failing && offset >= 3072 } });
  try {
    const first = await f.move.move();
    assert.equal(first.phase, "failed");
    assert.equal(first.error.code, "upload_failed");
    assert.equal(first.resumable, true);
    assert.equal(f.cloud.state.lastRestoreId, null, "nothing was replaced");
    assert.equal(f.cloud.tokens.size, 0);
    failing = false;
    const second = await f.move.move();
    assert.equal(second.phase, "done", JSON.stringify(second));
    assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 1);
    assert.ok(f.cloud.state.received.equals(f.local.archive));
  } finally { f.done(); }
});

test("refuses a Cloud without room before anything is uploaded, saying how much it needs", async () => {
  const f = harness({ cloud: { freeBytes: 10_000 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "failed");
    assert.equal(result.error.code, "cloud_full");
    assert.equal(result.error.freeBytes, 10_000);
    assert.ok(result.error.neededBytes > 10_000);
    assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 0);
    assert.equal(f.cloud.log.some(([method]) => method === "PUT"), false);
  } finally { f.done(); }
});

test("a busy computer, a missing Cloud and a stop all end before the Cloud replaces anything", async () => {
  const busy = harness({ desktop: { busy: true } });
  try { assert.equal((await busy.move.move()).error.code, "busy"); } finally { busy.done(); }
  const missing = harness({ pairHome: async () => { throw new Error("Your Cloud is not ready to connect yet."); } });
  try {
    assert.equal((await missing.move.move()).error.code, "cloud_unavailable");
    assert.deepEqual(missing.cloud.log, []);
  } finally { missing.done(); }
  const stopped = harness({ onState: (state, move) => { if (state.phase === "uploading") move.cancel(); } });
  try {
    const result = await stopped.move.move();
    assert.equal(result.phase, "failed");
    assert.equal(result.error.code, "cancelled");
    assert.equal(stopped.cloud.log.some(([, path]) => path === "/api/cloud-move/restore"), false);
  } finally { stopped.done(); }
});

test("says a Cloud from before Move to Cloud has to update first", async () => {
  const f = harness();
  const fetchImpl = f.cloud.fetchImpl;
  const outdated = createCloudMove({
    localRequest: f.local.request, tempRoot: join(f.temp, "move"), availableBytes: async () => 1024 ** 4, sleep: async () => {}, pollMs: 0,
    pairHome: async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 }),
    fetchImpl: (url, init) => new URL(url).pathname === "/api/cloud-move" ? Promise.resolve(json(404, { error: "not found" })) : fetchImpl(url, init),
  });
  try {
    const result = await outdated.move();
    assert.equal(result.error.code, "cloud_outdated");
    assert.equal(f.local.calls.some(([, route]) => route === "/api/workspace-backup/export"), false);
  } finally { f.done(); }
});

test("asks a busy Cloud again with the same staged workspace, instead of uploading it twice", async () => {
  const f = harness({ cloud: { busyRestores: 2 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.equal(f.cloud.state.restoreAsks.length, 3);
    assert.equal(new Set(f.cloud.state.restoreAsks).size, 1);
    assert.equal(f.cloud.log.filter(([, path]) => path === "/api/cloud-move/preview").length, 1);
  } finally { f.done(); }
});

test("a Cloud that stays busy, a stop while it checks, and a mismatch each drop what the move staged there", async () => {
  const busy = harness({ cloud: { busyRestores: 10 } });
  try {
    const result = await busy.move.move();
    assert.equal(result.error.code, "cloud_busy");
    assert.equal(busy.cloud.state.discards, 1);
    assert.equal(busy.cloud.state.lastRestoreId, null);
  } finally { busy.done(); }
  const stopped = harness({ onState: (state, move) => { if (state.phase === "checking") move.cancel(); } });
  try {
    const result = await stopped.move.move();
    assert.equal(result.error.code, "cancelled");
    assert.match(result.error.message, /was not replaced/);
    assert.equal(stopped.cloud.state.discards, 1);
  } finally { stopped.done(); }
  const different = harness({ cloud: { previewBots: 2 } });
  try {
    const result = await different.move.move();
    assert.equal(result.error.code, "invalid_backup");
    assert.equal(different.cloud.state.discards, 1);
    assert.equal(different.cloud.state.restoreAsks.length, 0);
  } finally { different.done(); }
});

test("credits a stored part of an earlier upload when checking the Cloud's room", async () => {
  // 3 × 5000 bytes plus the margin is more than is free, until the stored part is counted.
  const f = harness({ cloud: { freeBytes: 256 * 1024 ** 2 + 12_000, storedPart: 4_000 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
  } finally { f.done(); }
});

test("says why this computer's server could not export, in its own words, on one line", async () => {
  const f = harness({ desktop: { exportError: "Cannot back up user-created symbolic link; replace it with regular files first: workspaces/bot/link\n\u0007" } });
  try {
    const result = await f.move.move();
    assert.equal(result.error.code, "export_failed");
    assert.equal(result.error.message, "Cannot back up user-created symbolic link; replace it with regular files first: workspaces/bot/link");
  } finally { f.done(); }
});

test("reports a replaced Cloud's backup", async () => {
  const f = harness({ cloud: { empty: false } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done");
    assert.equal(result.previous, true);
    assert.equal(f.states.find(state => state.phase === "replacing").replacing, true);
  } finally { f.done(); }
});

test("only the verified Cloud, open as this window's active server, counts as the Cloud page", () => {
  const frame = { url: `${ORIGIN}/` }, contents = { mainFrame: frame };
  const context = { contents, homeOrigin: ORIGIN, activeOrigin: ORIGIN };
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, context), true);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: { url: `${ORIGIN}/` } }, context), false, "a subframe");
  assert.equal(cloudPageSenderAllowed({ sender: {}, senderFrame: frame }, context), false, "another window");
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, activeOrigin: "https://other.example.test" }), false);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, homeOrigin: null }), false, "signed out of Cloud");
  const evil = { url: "https://evil.example.test/" }, evilContents = { mainFrame: evil };
  assert.equal(cloudPageSenderAllowed({ sender: evilContents, senderFrame: evil }, { contents: evilContents, homeOrigin: ORIGIN, activeOrigin: ORIGIN }), false);
});

const LOCAL = "http://127.0.0.1:48993";
function preload({ remote = false, activation = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? ORIGIN : LOCAL }, navigator: { userActivation: { isActive: activation } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ phase: "idle" }); } } }),
  });
  return { bridge, invoked };
}
test("the bridge forwards no arguments, and a remote page starts a move only from the person's click", async () => {
  const local = preload();
  for (const method of ["state", "start", "cancel", "restorePrevious", "dismiss"]) await local.bridge.cloudMove[method]({ origin: "https://evil.example.test", token: "forged" });
  assert.deepEqual(local.invoked, [["cloud-move:state"], ["cloud-move:start"], ["cloud-move:cancel"], ["cloud-move:restore-previous"], ["cloud-move:dismiss"]]);
  const page = preload({ remote: true });
  assert.ok(page.bridge.cloudMove, "the Cloud's card can reach it; main decides whether to answer");
  assert.equal(page.bridge.cloudAccount, undefined);
  await assert.rejects(page.bridge.cloudMove.start(), /Choose Move/);
  assert.deepEqual(page.invoked, []);
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudMove.start();
  assert.deepEqual(clicked.invoked, [["cloud-move:start"]]);
});

test("production IPC answers the local window, and the verified Cloud page only for its card", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("/** Local Settings, and (for the card)"), end = source.indexOf("// ── end Move to Cloud ──", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), calls = [];
  const localFrame = { url: `${LOCAL}/` }, localContents = { mainFrame: localFrame };
  const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
  localOrigin.setLocalOrigin(LOCAL);
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: localContents },
    environmentsState: { environments: [], activeId: "local" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }) },
    ensureCloudMove: () => ({ move: async (...args) => { calls.push(["move", ...args]); return { phase: "idle" }; }, cancel: (...args) => calls.push(["cancel", ...args]),
      restorePrevious: async (...args) => { calls.push(["restorePrevious", ...args]); return { phase: "idle" }; } }),
    cloudMoveOverview: onCloudPage => { calls.push(["overview", onCloudPage]); return { suggest: false }; },
    dismissCloudMove: () => calls.push(["dismiss"]), connectCloudHome: async () => {}, slog: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  const channels = ["cloud-move:state", "cloud-move:start", "cloud-move:cancel", "cloud-move:dismiss", "cloud-move:restore-previous"];
  for (const channel of channels) await handlers.get(channel)({ sender: localContents, senderFrame: localFrame }, { origin: "https://evil.example.test" });
  assert.deepEqual(calls, [["overview", false], ["move"], ["cancel"], ["dismiss"], ["overview", false], ["restorePrevious"]]);
  // The person's Cloud, open in this window: its card, not Restore previous Cloud.
  calls.length = 0;
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: [{ id: "cloud", name: "My Cloud", origin: ORIGIN }], activeId: "cloud" };
  for (const channel of channels.slice(0, 4)) await handlers.get(channel)({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(calls, [["overview", true], ["move"], ["cancel"], ["dismiss"], ["overview", true]]);
  assert.throws(() => handlers.get("cloud-move:restore-previous")({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
  // Any other server, a subframe, or a Cloud that is not this window's active one.
  const other = { url: "https://other.example.test/" };
  for (const event of [{ sender: cloudContents, senderFrame: other }, { sender: cloudContents, senderFrame: { url: `${ORIGIN}/` } }, { sender: {}, senderFrame: cloudFrame }]) {
    for (const channel of channels) assert.throws(() => handlers.get(channel)(event), /only available/);
  }
  context.environmentsState = { environments: [{ id: "other", name: "Other", origin: "https://other.example.test" }], activeId: "other" };
  assert.throws(() => handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
  context.environmentsState = { environments: [{ id: "cloud", name: "My Cloud", origin: ORIGIN }], activeId: "cloud" };
  context.desktopRemoteAccess = true;
  assert.throws(() => handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
});

test("the Cloud's setup checklist can open the lending switch here, and nothing else can", async () => {
  // The bridge carries no arguments, and the Cloud's own page gets it.
  const local = preload();
  await local.bridge.cloudLending.open({ origin: "https://evil.example.test", folders: ["/"] });
  assert.deepEqual(local.invoked, [["cloud-lending:open"]]);
  const page = preload({ remote: true });
  assert.ok(page.bridge.cloudLending);
  assert.deepEqual(Object.keys(page.bridge.cloudLending), ["open"]);
  // Main opens Settings → OMB Cloud for this window's local page or the
  // person's verified Cloud in it, and refuses any other page.
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("/** Local Settings, and (for the card)"), end = source.indexOf("// ── end Move to Cloud ──", start);
  const handlers = new Map(), opened = [];
  const localFrame = { url: `${LOCAL}/` }, localContents = { mainFrame: localFrame };
  const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
  localOrigin.setLocalOrigin(LOCAL);
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: localContents },
    environmentsState: { environments: [], activeId: "local" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }) },
    openLendingSettings: async (...args) => { opened.push(args); },
  });
  vm.runInContext(source.slice(start, end), context);
  const open = handlers.get("cloud-lending:open");
  await open({ sender: localContents, senderFrame: localFrame }, { origin: "https://evil.example.test" });
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: [{ id: "cloud", name: "My Cloud", origin: ORIGIN }], activeId: "cloud" };
  await open({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(opened, [[], []]);
  for (const event of [{ sender: cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: cloudFrame }]) {
    assert.throws(() => open(event), /only available/);
  }
  context.environmentsState = { environments: [{ id: "other", name: "Other", origin: "https://other.example.test" }], activeId: "other" };
  assert.throws(() => open({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
  assert.equal(opened.length, 2);
});
