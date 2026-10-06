// Copy this computer here, the desktop's half (docs/copy-workspace.md),
// against in-memory fakes of this computer's server and the destination (the
// Cloud, or any server the person added): resuming a dropped upload, refusing
// a full server, refusing before anything is exported, stopping before
// anything is replaced, and the bridge and IPC guards. The whole copy between
// real servers is server/cloud-move.e2e.test.ts.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import environments from "./environments.cjs";
import localOrigin from "./local-origin.cjs";
import { cloudPageSenderAllowed, createCloudMove, mintOwnerCode, moveBlocked, moveFit, moveRefusal, moveSenderDestination, olderVersion, parseMoveEstimate } from "./cloud-move.mjs";
import { cloudPlanSnapshot } from "./cloud-account.mjs";
import { cloudPlanDisk, isCloudHomeEntry } from "./cloud-home.mjs";

const ORIGIN = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const UUID = () => "3f9c2a4e-8b1d-4c6e-9a7f-" + randomBytes(6).toString("hex");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** This computer's server: an estimate, an export and its download. */
function desktop({ bytes = 5000, busy = false, exportError = null, routines, identity = {} } = {}) {
  const archive = Buffer.concat([MAGIC, randomBytes(bytes - MAGIC.length)]), calls = [];
  const id = UUID();
  return {
    archive, calls,
    request: async (route, init) => {
      calls.push([init.method, route, init.body ? JSON.parse(init.body) : undefined]);
      if (route === "/api/cloud-move/estimate") return json(200, { bots: 3, rooms: 1, chats: 7, bytes, files: 12, ...(routines === undefined ? {} : { routines }), ...identity });
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

/** The destination: pairing, the upload slot, jobs, and a restart. */
function cloudFake({ freeBytes = 1024 ** 4, volumeBytes, empty = true, failPut = () => false, dropAnswer = () => false, loseAt = 0, busyRestores = 0, storedPart = 0, previewBots = 3, identity = {}, refuse = null,
  partBytes = 1024, proxyLimit = Infinity } = {}) {
  const state = { freeBytes, upload: storedPart ? { sha256: "e".repeat(64), bytes: storedPart } : null, received: Buffer.alloc(storedPart), job: null, lastRestoreId: null, restarting: 0,
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
    if (refuse && pathname.startsWith("/api/cloud-move")) return json(refuse.status, refuse.body);
    if (pathname === "/api/cloud-move" && (init.method ?? "GET") === "GET") {
      return json(200, { ...identity, contents: state.contents, empty: state.empty, freeBytes: state.freeBytes, ...(volumeBytes ? { volumeBytes } : {}), previous: state.previous, job: state.job, pendingRestore: false, busy: false,
        lastRestoreId: state.lastRestoreId, rolledBackId: null, partBytes: 1024,
        upload: state.upload && { ...state.upload, received: state.received.length } });
    }
    const body = init.body && !(init.body instanceof Uint8Array) ? JSON.parse(init.body) : undefined;
    if (pathname === "/api/cloud-move/discard") { state.discards++; if (state.job?.kind === "preview") state.job = null; return json(200, { ok: true }); }
    if (pathname === "/api/cloud-move/upload") {
      if (3 * body.bytes > state.freeBytes + state.received.length) return json(507, { error: "full", freeBytes: state.freeBytes, neededBytes: 3 * body.bytes });
      if (state.upload?.sha256 !== body.sha256) { state.upload = { sha256: body.sha256, bytes: body.bytes }; state.received = Buffer.alloc(0); }
      return json(200, { received: state.received.length, partBytes });
    }
    if (pathname.startsWith("/api/cloud-move/upload/")) {
      const offset = Number(searchParams.get("offset")), part = Buffer.from(init.body);
      state.puts = [...(state.puts ?? []), part.length];
      // A proxy in front (nginx: client_max_body_size), before the server sees anything.
      if (part.length > proxyLimit) return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", { status: 413, headers: { "content-type": "text/html" } });
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

const CLOUD = { id: "cloud", name: "My Cloud", origin: ORIGIN, kind: "cloud" };
/** The person's Cloud, as main describes it: the Admin's grant, the plan's disk. */
function cloudDestination(options = {}) {
  return { ...CLOUD, grant: options.pairHome ?? (async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 })),
    disk: options.cloudDisk ?? (() => null), grow: options.growCloud ?? (async () => ({ supported: false })) };
}
function harness(options = {}) {
  const temp = mkdtempSync(join(tmpdir(), "omb-cloud-move-test-"));
  const local = desktop(options.desktop), cloud = cloudFake(options.cloud), states = [];
  const dest = options.dest ?? cloudDestination(options);
  const engine = createCloudMove({
    localRequest: local.request, fetchImpl: cloud.fetchImpl, tempRoot: join(temp, "move"),
    availableBytes: async () => options.localFree ?? 1024 ** 4, sleep: async (_ms, signal) => signal?.throwIfAborted(), pollMs: 0, retryDelaysMs: [0, 0],
    ...(options.now ? { now: options.now } : {}), ...(options.growTimeoutMs !== undefined ? { growTimeoutMs: options.growTimeoutMs } : {}),
    onState: state => { states.push(state); options.onState?.(state, move); },
  });
  const move = { ...engine, move: copy => engine.move(dest, copy), restorePrevious: () => engine.restorePrevious(dest) };
  return { temp, local, cloud, states, move, engine, dest, done: () => rmSync(temp, { recursive: true, force: true }) };
}

test("moves this computer's archive in parts, waits out the restart, signs its session out and leaves no temporary file", async () => {
  const f = harness();
  try {
    const result = await f.move.move();
    assert.deepEqual(result, { phase: "done", action: "move", moved: { bots: 3, rooms: 1, chats: 7 }, previous: false, destination: CLOUD });
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

test("a proxy that refuses large parts gets smaller ones; one that refuses even 512 KB is named, with what to change, and the copy continues later", async () => {
  const MB = 1024 ** 2;
  // nginx's default client_max_body_size, 1 MB, in front of a server that asks for 4 MB parts.
  const behind = harness({ desktop: { bytes: 8 * MB + 5000 }, cloud: { partBytes: 4 * MB, proxyLimit: MB } });
  try {
    const result = await behind.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result.error));
    assert.ok(behind.cloud.state.received.equals(behind.local.archive));
    assert.deepEqual(behind.cloud.state.puts.slice(0, 3), [4 * MB, 2 * MB, MB]);
    assert.ok(behind.cloud.state.puts.slice(2).every(size => size <= MB), "every later part fits");
  } finally { behind.done(); }
  // A proxy allowing 256 KB: parts halve to 512 KB at the least, then the copy says what refused it.
  const tight = harness({ desktop: { bytes: 4 * MB }, cloud: { partBytes: 3 * MB, proxyLimit: 256 * 1024 } });
  try {
    const result = await tight.move.move();
    assert.equal(result.phase, "failed");
    assert.equal(result.error.code, "proxy_limit");
    assert.equal(result.error.partBytes, 512 * 1024);
    assert.match(result.error.message, /^A proxy in front of My Cloud refused a 512 KB upload\. Raise its request size limit \(nginx: client_max_body_size 64m\), then copy again\.$/);
    assert.deepEqual(tight.cloud.state.puts, [3 * MB, 1.5 * MB, 768 * 1024, 512 * 1024]);
    // Nothing was replaced, and the prepared archive waits: copying again (limit raised) continues without a second export.
    assert.equal(result.resumable, true);
    assert.equal(tight.cloud.state.restoreAsks.length, 0);
    assert.equal(tight.cloud.tokens.size, 0);
  } finally { tight.done(); }
  // The server's own 413 to the declaration (over 10 GB) stays "too large".
  const declared = harness({ cloud: { refuse: null } });
  try {
    const fetchImpl = declared.cloud.fetchImpl;
    const big = createCloudMove({ localRequest: declared.local.request, tempRoot: join(declared.temp, "move"), availableBytes: async () => 1024 ** 4, sleep: async () => {}, pollMs: 0,
      fetchImpl: (url, init) => new URL(url).pathname === "/api/cloud-move/upload" ? Promise.resolve(json(413, { error: "This workspace is larger than the 10 GB a copy can carry." })) : fetchImpl(url, init) });
    assert.equal((await big.move(cloudDestination())).error.code, "too_large");
  } finally { declared.done(); }
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

const GB = 1024 ** 3, MARGIN = 256 * 1024 ** 2;
test("a move is measured against the plan's largest disk when the disk grows, and against today's when it cannot", () => {
  // The audit's case: about 3.4 GB here, 8.9 GB free on a new 10 GB Cloud.
  const local = 3.4 * GB, free = 8.9 * GB;
  assert.deepEqual(moveFit({ localBytes: 1 * GB, freeBytes: free }), { fit: "now", neededBytes: 3 * GB + MARGIN, freeBytes: free });
  const grow = moveFit({ localBytes: local, freeBytes: free, disk: { maxBytes: 100 * GB, startBytes: 10 * GB } });
  assert.equal(grow.fit, "grow"); assert.equal(grow.sizeGb, 20); assert.equal(grow.maxBytes, 100 * GB);
  // Personal's disk does not grow: it truly cannot fit, and says the plan's size.
  assert.deepEqual(moveFit({ localBytes: local, freeBytes: free, disk: { maxBytes: 10 * GB, startBytes: 10 * GB } }),
    { fit: "never", neededBytes: 3 * local + MARGIN, freeBytes: free, maxBytes: 10 * GB });
  // The top plan says so, so nobody is pointed at a larger one.
  assert.equal(moveFit({ localBytes: 40 * GB, freeBytes: 5 * GB, volumeBytes: 10 * GB, disk: { maxBytes: 100 * GB, volumeBytes: 10 * GB, largest: true } }).largest, true);
  // No plan known: today's free space is all there is; the Cloud's own disk size says why.
  assert.deepEqual(moveFit({ localBytes: local, freeBytes: free }), { fit: "never", neededBytes: 3 * local + MARGIN, freeBytes: free });
  assert.deepEqual(moveFit({ localBytes: local, freeBytes: free, volumeBytes: 10 * GB }), { fit: "never", neededBytes: 3 * local + MARGIN, freeBytes: free, volumeBytes: 10 * GB });
  // The Cloud's own volume size wins over the plan's starting size; the ask never passes the plan.
  assert.equal(moveFit({ localBytes: 10 * GB, freeBytes: 15 * GB, volumeBytes: 40 * GB, disk: { maxBytes: 100 * GB, startBytes: 10 * GB } }).sizeGb, 60);
  assert.equal(moveFit({ localBytes: 28 * GB, freeBytes: 15 * GB, volumeBytes: 20 * GB, disk: { maxBytes: 100 * GB, startBytes: 10 * GB } }).sizeGb, 90);
  assert.equal(moveFit({ localBytes: 40 * GB, freeBytes: 5 * GB, volumeBytes: 10 * GB, disk: { maxBytes: 100 * GB } }).fit, "never");
  // A stored part of an earlier upload counts as room.
  assert.equal(moveFit({ localBytes: 1 * GB, freeBytes: 2 * GB, uploadReceived: 2 * GB }).fit, "now");
  assert.deepEqual(parseMoveEstimate({ bots: 1, rooms: 0, chats: 2, bytes: 10, files: 1, routines: 4 }).routines, 4);
  assert.equal(parseMoveEstimate({ bots: 1, rooms: 0, chats: 2, bytes: 10, files: 1, routines: -1 }).routines, undefined);
});

const OVERVIEW_START = "async function cloudMoveOverview(", IPC_START = "// ── Who asks, and where to", IPC_END = "// ── end Copy this computer here ──";
/** main's cloudMoveOverview, run against fakes of what it asks. */
async function mainOverview({ dest, peek, local = { bots: 3, rooms: 1, chats: 12, bytes: 3.4 * GB, files: 100 }, state = { phase: "idle" }, running = false, onServerPage = true }) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(OVERVIEW_START), end = source.indexOf(IPC_START, start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ moveFit, moveBlocked, cloudMoveDismissed: () => false, peekCloudMove: async () => peek,
    ensureCloudMove: () => ({ estimate: async () => local, state: () => state, running: () => running }) });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.cloudMoveOverview = cloudMoveOverview;`, context);
  // Made in main's own realm: compared as plain data.
  return JSON.parse(JSON.stringify(await context.cloudMoveOverview(dest, onServerPage)));
}
test("a server's card offers a copy only when it can fit and nothing blocks it: Cloud growth counts only when the Admin says the disk grows", async () => {
  // The audit's case: 3.4 GB here, 8.9 GB free on a new 10 GB Max Cloud.
  const max = machine => ({ status: "connected", account: { id: "a1", email: "p@example.test" },
    entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1, version: 1 }, machine });
  const peek = { status: { empty: true, freeBytes: 8.9 * GB, uploadReceived: 0, volumeBytes: 10 * GB, contents: { bots: 0, rooms: 0, chats: 0 }, previous: null }, refusal: null };
  const cloud = machine => ({ ...CLOUD, disk: () => cloudPlanDisk(max(machine)) });
  // Today's Admin says nothing about the disk: today's free space decides, so no card offers a copy it would refuse.
  let result = await mainOverview({ dest: cloud({ status: "ready", origin: ORIGIN }), peek });
  assert.equal(result.fit.fit, "never"); assert.equal(result.fit.volumeBytes, 10 * GB); assert.equal(result.suggest, false);
  // An Admin that says the disk grows to 100 GB: the copy fits once it grows, and the card offers it.
  result = await mainOverview({ dest: cloud({ status: "ready", origin: ORIGIN, disk: { gb: 10, maxGb: 100 } }), peek });
  assert.equal(result.fit.fit, "grow"); assert.equal(result.suggest, true); assert.deepEqual(result.destination, CLOUD); assert.equal(result.blocked, null);
  // A server's disk never grows, whatever it is asked: its own free space decides.
  const roomy = { ...peek, status: { ...peek.status, freeBytes: 50 * GB } };
  const server = { ...VPS_ENTRY, disk: () => { throw new Error("a server has no plan"); } };
  result = await mainOverview({ dest: server, peek });
  assert.equal(result.fit.fit, "never"); assert.equal(result.suggest, false);
  result = await mainOverview({ dest: server, peek: roomy });
  assert.equal(result.suggest, true); assert.deepEqual(result.destination, VPS_ENTRY);
  // Each reason a copy cannot start blocks the card, and says which.
  for (const [blocked, input] of [
    ["owner_needed", { peek: { status: null, refusal: "owner_needed" } }],
    ["shared_workspace", { peek: { status: null, refusal: "shared_workspace" } }],
    ["outdated", { peek: { status: null, refusal: "outdated" } }],
    ["unreachable", { peek: { status: null, refusal: "unreachable" } }],
    ["same_computer", { peek: { ...roomy, status: { ...roomy.status, environmentId: "env-1" } }, local: { bots: 3, rooms: 1, chats: 12, bytes: GB, files: 1, environmentId: "env-1" } }],
  ]) {
    result = await mainOverview({ dest: server, ...input });
    assert.equal(result.blocked, blocked); assert.equal(result.suggest, false);
    // A server's page learns nothing that identifies this computer.
    assert.equal(JSON.stringify(result).includes("env-1"), false);
  }
  // A copy running to the Cloud: this server waits, and is not shown the Cloud's progress.
  result = await mainOverview({ dest: server, peek: roomy, running: true, state: { phase: "uploading", action: "move", destination: CLOUD } });
  assert.equal(result.blocked, "busy_elsewhere"); assert.equal(result.busyWith, "My Cloud"); assert.equal(result.phase, "idle"); assert.equal(result.suggest, false);
  // A finished copy to the Cloud does not keep this server's card away.
  result = await mainOverview({ dest: server, peek: roomy, state: { phase: "done", action: "move", destination: CLOUD } });
  assert.equal(result.phase, "idle"); assert.equal(result.suggest, true);
  // No session on the Cloud in this window yet is no block: the Admin opens one.
  result = await mainOverview({ dest: cloud({ status: "ready", origin: ORIGIN }), peek: { status: null, refusal: "owner_needed" }, onServerPage: false });
  assert.equal(result.blocked, null); assert.equal(result.cloud, null);
  // This computer's own page, without a server named: what is here, nothing more.
  result = await mainOverview({ dest: null, peek });
  assert.deepEqual([result.destination, result.blocked, result.suggest], [null, null, false]);
});

test("a Cloud whose plan's disk grows makes room first, then the move continues", async () => {
  const asked = [];
  const f = harness({ desktop: { bytes: 5000, routines: 4 }, cloud: { freeBytes: 10_000, volumeBytes: 1_000_000 },
    cloudDisk: () => ({ maxBytes: 100 * GB, startBytes: 10 * GB }),
    growCloud: async sizeGb => { asked.push(sizeGb); f.cloud.state.freeBytes = GB; return { supported: true, disk: { gb: sizeGb, maxGb: 100 } }; } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done"); assert.equal(result.routines, 4);
    assert.deepEqual(asked, [10]);
    assert.ok(f.states.some(state => state.phase === "growing"));
    assert.ok(f.cloud.state.received.equals(f.local.archive));
  } finally { f.done(); }
});

test("when the disk cannot grow for the move (an Admin without it, too slow, or over the plan), it says so and moves nothing", async () => {
  const cases = [
    // An Admin that cannot grow a disk: its own code, so the text never says "try again".
    ["cloud_grow_unsupported", async () => ({ supported: false })],
    ["cloud_grow_unavailable", async () => { throw new Error("offline"); }],
    ["cloud_full", async () => ({ supported: true, refused: true })],
  ];
  for (const [code, growCloud] of cases) {
    const f = harness({ cloud: { freeBytes: 10_000 }, cloudDisk: () => ({ maxBytes: 100 * GB, startBytes: 10 * GB }), growCloud });
    try {
      const result = await f.move.move();
      assert.equal(result.phase, "failed"); assert.equal(result.error.code, code); assert.equal(result.error.maxBytes, 100 * GB);
      assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 0);
      assert.equal(f.cloud.log.some(([method]) => method === "PUT"), false);
    } finally { f.done(); }
  }
  let clock = 0;
  const slow = harness({ cloud: { freeBytes: 10_000 }, cloudDisk: () => ({ maxBytes: 100 * GB, startBytes: 10 * GB }), growTimeoutMs: 5,
    now: () => (clock += 2), growCloud: async () => ({ supported: true, disk: { gb: 20, maxGb: 100 } }) });
  try { assert.equal((await slow.move.move()).error.code, "cloud_grow_unavailable"); } finally { slow.done(); }
});

test("a disk that does not grow refuses a move it cannot hold, naming the plan's disk", async () => {
  let grown = 0;
  const f = harness({ cloud: { freeBytes: 10_000 }, cloudDisk: () => ({ maxBytes: 10_000, startBytes: 10_000 }), growCloud: async () => { grown++; return { supported: true }; } });
  try {
    const result = await f.move.move();
    assert.equal(result.error.code, "cloud_full"); assert.equal(result.error.maxBytes, 10_000); assert.equal(grown, 0);
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

test("says a Cloud from before any server could receive a copy has to update first", async () => {
  const f = harness();
  const fetchImpl = f.cloud.fetchImpl;
  const outdated = createCloudMove({
    localRequest: f.local.request, tempRoot: join(f.temp, "move"), availableBytes: async () => 1024 ** 4, sleep: async () => {}, pollMs: 0,
    fetchImpl: (url, init) => new URL(url).pathname === "/api/cloud-move" ? Promise.resolve(json(404, { error: "not found" })) : fetchImpl(url, init),
  });
  try {
    const result = await outdated.move(cloudDestination());
    assert.equal(result.error.code, "outdated");
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

// ── Any server the person added, through the same engine ──────────────
const VPS = "https://bots.example.test";
const VPS_ENTRY = { id: "vps", name: "bots.example.test", origin: VPS, kind: "server" };
/** This window's own session on a self-hosted server (Chromium's cookie jar, session.defaultSession.fetch). */
function windowSession({ session = { kind: "session", id: "s1", scopes: ["admin", "client"] }, status = 200, pairing = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method ?? "GET", pathname, credentials: init.credentials, origin: new Headers(init.headers).get("origin"), body: init.body ? JSON.parse(init.body) : undefined });
    if (pathname === "/api/auth/session") return json(status, status === 200 ? session : { error: "unauthorized" });
    if (pathname === "/api/auth/pairing" && init.method === "POST") return pairing ?? json(200, { code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    return json(404, {});
  };
  return { fetch, calls };
}
const serverDestination = (cookie, extra = {}) => ({ ...VPS_ENTRY, grant: () => mintOwnerCode(cookie.fetch, VPS), ...extra });

test("a self-hosted server receives the copy through the same engine: the window's owner session mints the code, the copy's own session signs out", async () => {
  const cookie = windowSession();
  const f = harness({ desktop: { routines: 2 }, dest: serverDestination(cookie) });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.deepEqual(result.destination, VPS_ENTRY);
    assert.equal(result.routines, 2);
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.ok(f.states.every(state => state.destination?.origin === VPS), "every state names where it goes");
    // The cookie only asked who it is and minted one admin code, from this origin.
    assert.deepEqual(cookie.calls.map(call => `${call.method} ${call.pathname}`), ["GET /api/auth/session", "POST /api/auth/pairing"]);
    assert.ok(cookie.calls.every(call => call.credentials === "include" && call.origin === VPS));
    assert.deepEqual(cookie.calls[1].body.scopes, ["admin", "client"]);
    // The copy's bearer session was signed out; the window's session was never touched.
    assert.equal(f.cloud.tokens.size, 0);
    assert.ok(f.cloud.log.some(([method, path]) => method === "POST" && path === "/api/auth/logout"));
    assert.equal(cookie.calls.some(call => call.pathname === "/api/auth/logout"), false);
  } finally { f.done(); }
});

const exportsOf = f => f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length;
test("refuses before exporting anything: another origin's grant, an old server, a shared one, this computer itself, an older version, or work a page may not replace", async () => {
  const cases = [
    ["cloud_unavailable", { dest: { ...VPS_ENTRY, grant: async () => ({ origin: "https://elsewhere.example.test", code: "ABCD-EFGH-JKLM" }) } }],
    ["outdated", { cloud: { refuse: { status: 404, body: { error: "Unknown" } } } }],
    ["shared_workspace", { cloud: { refuse: { status: 403, body: { error: "This server is shared with other people.", code: "shared_workspace" } } } }],
    ["same_computer", { desktop: { identity: { environmentId: "env-1", appVersion: "0.1.96" } }, cloud: { identity: { environmentId: "env-1", appVersion: "0.1.96" } } }],
    ["outdated", { desktop: { identity: { environmentId: "env-1", appVersion: "0.1.96" } }, cloud: { identity: { environmentId: "env-2", appVersion: "0.1.95" } } }],
    ["not_empty", { cloud: { empty: false }, copy: { requireEmpty: true } }],
  ];
  for (const [code, options] of cases) {
    const f = harness({ dest: serverDestination(windowSession()), ...options });
    try {
      const result = await f.move.move(options.copy);
      assert.equal(result.phase, "failed", `${code}: ${JSON.stringify(result)}`);
      assert.equal(result.error.code, code);
      assert.equal(exportsOf(f), 0, `${code}: nothing exported`);
      assert.equal(f.cloud.log.some(([method]) => method === "PUT"), false);
      assert.equal(f.cloud.tokens.size, 0, `${code}: the copy's session was signed out`);
      if (options.dest) assert.deepEqual(f.cloud.log, [], "never signed in anywhere else");
    } finally { f.done(); }
  }
  const older = harness({ dest: serverDestination(windowSession()), desktop: { identity: { appVersion: "0.1.96" } }, cloud: { identity: { appVersion: "0.1.95" } } });
  try {
    const result = await older.move.move();
    assert.deepEqual([result.error.destVersion, result.error.localVersion], ["0.1.95", "0.1.96"]);
    assert.match(result.error.message, /^bots\.example\.test runs 0\.1\.95; this computer runs 0\.1\.96/);
  } finally { older.done(); }
  // The same versions, an empty server from its own page: it copies.
  const same = harness({ dest: serverDestination(windowSession()), desktop: { identity: { appVersion: "0.1.96", environmentId: "env-1" } }, cloud: { identity: { appVersion: "0.1.96", environmentId: "env-2" } } });
  try { assert.equal((await same.move.move({ requireEmpty: true })).phase, "done"); } finally { same.done(); }
});

test("only the Cloud grows its disk: a server's copy never asks for the plan's disk or growth", async () => {
  let asked = 0;
  const dest = { ...serverDestination(windowSession()), disk: () => { asked++; return { maxBytes: 100 * GB, startBytes: 10 * GB }; }, grow: async () => { asked++; return { supported: true }; } };
  const full = harness({ dest, cloud: { freeBytes: 10_000, volumeBytes: 1_000_000 } });
  try {
    const result = await full.move.move();
    assert.equal(result.error.code, "cloud_full");
    assert.equal(result.error.maxBytes, undefined);
    assert.equal(full.states.some(state => state.phase === "growing"), false);
  } finally { full.done(); }
  const roomy = harness({ dest });
  try { assert.equal((await roomy.move.move()).phase, "done"); } finally { roomy.done(); }
  assert.equal(asked, 0);
});

test("the window's session mints an owner code only when it is a signed-in owner of a server only they use", async () => {
  const minted = windowSession();
  assert.deepEqual(Object.keys(await mintOwnerCode(minted.fetch, VPS)).sort(), ["code", "expiresAt", "origin"]);
  assert.equal((await mintOwnerCode(minted.fetch, VPS)).origin, VPS);
  for (const [code, options] of [
    ["owner_needed", { session: { kind: "session", id: "s1", scopes: ["client"] } }],
    ["owner_needed", { status: 401 }],
    ["owner_needed", { session: { kind: "loopback", scopes: ["admin", "client"] } }],
    ["shared_workspace", { session: { kind: "session", id: "s1", scopes: ["admin", "client"], hosted: true } }],
  ]) {
    const refused = windowSession(options);
    await assert.rejects(mintOwnerCode(refused.fetch, VPS), error => error.code === code);
    assert.equal(refused.calls.some(call => call.method === "POST"), false, `${code}: no code minted`);
  }
  const managed = windowSession({ pairing: json(403, { error: "Your organisation turned off remote access.", code: "managed_policy" }) });
  await assert.rejects(mintOwnerCode(managed.fetch, VPS), error => error.code === "cloud_refused" && error.message === "Your organisation turned off remote access.");
  const offline = { fetch: async () => { throw new TypeError("fetch failed"); } };
  await assert.rejects(mintOwnerCode(offline.fetch, VPS), error => error.code === "network");
});

test("says why a server cannot receive a copy before one starts, one reason each", () => {
  assert.equal(moveRefusal(403, { code: "shared_workspace" }), "shared_workspace");
  assert.equal(moveRefusal(404, {}), "outdated");
  assert.equal(moveRefusal(401, {}), "owner_needed");
  assert.equal(moveRefusal(403, { error: "forbidden" }), "owner_needed");
  assert.equal(moveRefusal(502, {}), "unreachable");
  assert.equal(olderVersion("0.1.95", "0.1.96"), true);
  assert.equal(olderVersion("0.2.0", "0.1.96"), false);
  assert.equal(olderVersion("0.1.96", "0.1.96"), false);
  assert.equal(olderVersion(null, "0.1.96"), false);
  const local = { appVersion: "0.1.96", environmentId: "env-1" };
  assert.equal(moveBlocked({ kind: "server", local, cloud: { appVersion: "0.1.96", environmentId: "env-2" } }), null);
  assert.equal(moveBlocked({ kind: "server", local, cloud: { appVersion: "0.1.96", environmentId: "env-1" } }), "same_computer");
  assert.equal(moveBlocked({ kind: "server", local, cloud: { appVersion: "0.1.90", environmentId: "env-2" } }), "outdated");
  assert.equal(moveBlocked({ kind: "server", refusal: "owner_needed", local }), "owner_needed");
  assert.equal(moveBlocked({ kind: "server", refusal: "unreachable", local }), "unreachable");
  // The Cloud's Admin opens the session itself: no session in this window yet is not a block there.
  assert.equal(moveBlocked({ kind: "cloud", refusal: "owner_needed", local }), null);
  assert.equal(moveBlocked({ kind: "cloud", refusal: "unreachable", local }), null);
  assert.equal(moveBlocked({ kind: "cloud", refusal: "shared_workspace", local }), "shared_workspace");
  assert.equal(moveBlocked({ kind: "server", local, busyElsewhere: true }), "busy_elsewhere");
});

test("where a copy goes comes from main: this computer's page names a saved server, a server's page gets only itself", () => {
  const LOCAL_PAGE = "http://127.0.0.1:48993";
  const saved = [{ id: "vps", name: "VPS", origin: VPS }, { id: "cloud-entry", name: "My Cloud", origin: ORIGIN }];
  const localFrame = { url: `${LOCAL_PAGE}/settings` }, localContents = { mainFrame: localFrame };
  const onLocal = { environments: saved, activeId: "local" };
  const ask = (event, context) => moveSenderDestination(event, { contents: localContents, environments: onLocal, localOrigin: LOCAL_PAGE, cloudHomeOrigin: ORIGIN, ...context });
  const local = { sender: localContents, senderFrame: localFrame };
  assert.deepEqual(ask(local, { id: "vps" }), { entry: saved[0], remote: false });
  assert.deepEqual(ask(local, {}), { entry: null, remote: false });
  // "cloud": the Cloud's saved entry when there is one, else the verified Cloud by name.
  assert.deepEqual(ask(local, { id: "cloud" }), { entry: { ...saved[1], cloud: true }, remote: false });
  assert.deepEqual(ask(local, { id: "cloud", environments: { environments: [saved[0]], activeId: "local" } }), { entry: { id: "cloud", name: "My Cloud", origin: ORIGIN, cloud: true }, remote: false });
  assert.equal(ask(local, { id: "nope" }), null, "an unknown id");
  assert.equal(ask(local, { id: { origin: "https://evil.example.test" } }), null, "not an id");
  // The server open in this window asks about itself, and names nothing.
  const vpsFrame = { url: `${VPS}/` }, vpsContents = { mainFrame: vpsFrame };
  const onVps = { environments: saved, activeId: "vps" };
  const page = { sender: vpsContents, senderFrame: vpsFrame };
  assert.deepEqual(moveSenderDestination(page, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE }), { entry: saved[0], remote: true });
  assert.equal(moveSenderDestination(page, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE, id: "cloud-entry" }), null, "a server's page naming a destination");
  assert.equal(moveSenderDestination(page, { contents: vpsContents, environments: onLocal, localOrigin: LOCAL_PAGE }), null, "while Local is active");
  assert.equal(moveSenderDestination(page, { contents: vpsContents, environments: { environments: saved, activeId: "cloud-entry" }, localOrigin: LOCAL_PAGE }), null, "another server is active");
  assert.equal(moveSenderDestination({ sender: vpsContents, senderFrame: { url: `${VPS}/` } }, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE }), null, "a subframe");
  assert.equal(moveSenderDestination({ sender: {}, senderFrame: vpsFrame }, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE }), null, "another window");
  const evil = { url: "https://evil.example.test/" }, evilContents = { mainFrame: evil };
  assert.equal(moveSenderDestination({ sender: evilContents, senderFrame: evil }, { contents: evilContents, environments: onVps, localOrigin: LOCAL_PAGE }), null, "a page that is not the saved server");
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
  let bridge; const invoked = [], listeners = new Map();
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? ORIGIN : LOCAL }, navigator: { userActivation: { isActive: activation } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, handler) => listeners.set(channel, handler), removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ phase: "idle" }); } } }),
  });
  return { bridge, invoked, listeners };
}
test("the bridge forwards only a saved server's id, only from this computer's page; a server's page names nothing and starts a copy only from the person's click", async () => {
  const local = preload();
  for (const method of ["state", "start", "cancel", "restorePrevious", "dismiss"]) await local.bridge.cloudMove[method]({ origin: "https://evil.example.test", token: "forged" });
  assert.deepEqual(local.invoked, [["cloud-move:state"], ["cloud-move:start"], ["cloud-move:cancel"], ["cloud-move:restore-previous"], ["cloud-move:dismiss"]]);
  local.invoked.length = 0;
  for (const method of ["state", "start", "cancel", "restorePrevious", "dismiss"]) await local.bridge.cloudMove[method]("vps");
  assert.deepEqual(local.invoked, [["cloud-move:state", "vps"], ["cloud-move:start", "vps"], ["cloud-move:cancel"], ["cloud-move:restore-previous", "vps"], ["cloud-move:dismiss", "vps"]]);
  const page = preload({ remote: true });
  assert.ok(page.bridge.cloudMove, "a server's card can reach it; main decides whether to answer");
  assert.equal(page.bridge.cloudAccount, undefined);
  await assert.rejects(page.bridge.cloudMove.start(), /Choose Copy/);
  assert.deepEqual(page.invoked, []);
  await page.bridge.cloudMove.state("vps"); await page.bridge.cloudMove.dismiss("vps");
  assert.deepEqual(page.invoked, [["cloud-move:state"], ["cloud-move:dismiss"]]);
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudMove.start("cloud");
  assert.deepEqual(clicked.invoked, [["cloud-move:start"]]);
  // Main opens Settings → Servers on a server's copy panel: only "copy" is a panel name.
  const seen = [];
  local.bridge.environments.onOpenSettings((id, panel) => seen.push([id, panel]));
  for (const panel of ["copy", "evil", undefined]) local.listeners.get("workspaces:open-settings")({}, "vps", panel);
  assert.deepEqual(seen, [["vps", "copy"], ["vps", undefined], ["vps", undefined]]);
});

/** main's copy IPC, run against fakes of what it calls. */
function mainIpc(extra = {}) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(IPC_START), end = source.indexOf(IPC_END, start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), calls = [];
  let engineState = { phase: "idle" };
  localOrigin.setLocalOrigin(LOCAL);
  const describe = dest => ({ id: dest.id, name: dest.name, origin: dest.origin, kind: dest.kind, grant: typeof dest.grant, grows: typeof dest.grow === "function" });
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed, moveSenderDestination,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: localContents },
    environmentsState: { environments: SAVED, activeId: "local" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }) }, isCloudHomeEntry, cloudPlanDisk, mintOwnerCode,
    session: { defaultSession: { fetch: async () => { throw new Error("no network in this test"); } } },
    ensureCloudAccount: () => ({ pairHome: async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM" }), state: () => ({}) }),
    ensureCloudMove: () => ({
      // What main passes is made in its own realm: compared as plain data.
      move: async (dest, options) => { calls.push(["move", describe(dest), JSON.parse(JSON.stringify(options))]); return context.result ?? { phase: "idle" }; },
      cancel: () => { calls.push(["cancel"]); return engineState; }, state: () => engineState,
      restorePrevious: async dest => { calls.push(["restorePrevious", describe(dest)]); return context.result ?? { phase: "idle" }; } }),
    cloudMoveOverview: (dest, onServerPage) => { calls.push(["overview", dest && describe(dest), onServerPage]); return { suggest: false }; },
    dismissCloudMove: origin => calls.push(["dismiss", origin]),
    connectCloudHome: async () => calls.push(["connectCloudHome"]), switchEnvironment: async id => calls.push(["switch", id]),
    navigateMainWindow: url => calls.push(["navigate", url]), slog: () => {},
    openWorkspaceSettings: (id, panel) => calls.push(["openSettings", id, panel]),
    ...extra,
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, handlers, calls, setState: next => { engineState = next; } };
}
const SAVED = [{ id: "vps", name: "VPS", origin: "https://bots.example.test" }, { id: "cloud-entry", name: "My Cloud", origin: ORIGIN }];
const localFrame = { url: `${LOCAL}/` }, localContents = { mainFrame: localFrame };
const vpsFrame = { url: "https://bots.example.test/" }, vpsContents = { mainFrame: vpsFrame };
const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
const VPS_DEST = { id: "vps", name: "VPS", origin: "https://bots.example.test", kind: "server", grant: "function", grows: false };
const CLOUD_DEST = { id: "cloud-entry", name: "My Cloud", origin: ORIGIN, kind: "cloud", grant: "function", grows: true };

test("production IPC: this computer's page names a saved server or the Cloud, and each gets its own way in", async () => {
  const { handlers, calls } = mainIpc();
  const local = { sender: localContents, senderFrame: localFrame };
  await handlers.get("cloud-move:state")(local, "vps");
  await handlers.get("cloud-move:start")(local, "vps");
  await handlers.get("cloud-move:start")(local, "cloud");
  await handlers.get("cloud-move:restore-previous")(local, "vps");
  await handlers.get("cloud-move:dismiss")(local, "vps");
  await handlers.get("cloud-move:cancel")(local);
  await handlers.get("cloud-move:state")(local);
  assert.deepEqual(calls, [
    ["overview", VPS_DEST, false], ["move", VPS_DEST, { requireEmpty: false }], ["move", CLOUD_DEST, { requireEmpty: false }], ["restorePrevious", VPS_DEST],
    ["dismiss", VPS_DEST.origin], ["overview", VPS_DEST, false], ["cancel"], ["overview", null, false],
  ]);
  // A copy needs a server; an id must be one of this app's saved servers.
  assert.throws(() => handlers.get("cloud-move:start")(local), /Choose a server/);
  for (const id of ["nope", { origin: "https://evil.example.test" }]) assert.throws(() => handlers.get("cloud-move:start")(local, id), /only available/);
});

test("production IPC: the Cloud is the Cloud even before its address is known, and nothing is local until this computer's origin is", async () => {
  const { context, handlers, calls } = mainIpc();
  const local = { sender: localContents, senderFrame: localFrame };
  // Signed out of OMB Cloud, or not ready: still the Admin's way in, which then says why it cannot.
  context.cloudAccount = { homeTarget: () => null };
  context.environmentsState = { environments: [SAVED[0]], activeId: "local" };
  await handlers.get("cloud-move:start")(local, "cloud");
  assert.deepEqual(calls, [["move", { id: "cloud", name: "My Cloud", origin: null, kind: "cloud", grant: "function", grows: true }, { requireEmpty: false }]]);
  // Until main knows this computer's own origin, its page is not this computer's: fail closed.
  context.senderIsLocal = () => false;
  for (const channel of ["cloud-move:state", "cloud-move:start", "cloud-move:restore-previous"]) assert.throws(() => handlers.get(channel)(local, "vps"), /only available/);
  assert.throws(() => handlers.get("cloud-move:state")(local), /only available/);
});

test("production IPC: a server's own page gets only itself, never starts a copy to itself (only the verified Cloud's does, while empty), and cannot swap back", async () => {
  const { context, handlers, calls, setState } = mainIpc();
  context.mainWindow.webContents = vpsContents;
  context.environmentsState = { environments: SAVED, activeId: "vps" };
  const page = { sender: vpsContents, senderFrame: vpsFrame };
  await handlers.get("cloud-move:state")(page);
  // What it says about itself (owner, empty) is its own word: its Copy opens
  // this computer's Settings → Servers on its copy, and sends nothing.
  assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get("cloud-move:start")(page))), { phase: "idle" });
  await handlers.get("cloud-move:dismiss")(page);
  assert.deepEqual(calls, [["overview", VPS_DEST, true], ["openSettings", "vps", "copy"], ["dismiss", VPS_DEST.origin], ["overview", VPS_DEST, true]]);
  // A server at the Cloud's address that this app has not verified (signed out of OMB Cloud): the same.
  calls.length = 0;
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: SAVED, activeId: "cloud-entry" };
  context.cloudAccount = { homeTarget: () => null };
  await handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(calls, [["openSettings", "cloud-entry", "copy"]]);
  context.cloudAccount = { homeTarget: () => ({ origin: ORIGIN }) };
  // Even were a server taken for the Cloud, its page starts nothing unless it is the verified Cloud's page.
  calls.length = 0;
  context.mainWindow.webContents = vpsContents;
  context.environmentsState = { environments: SAVED, activeId: "vps" };
  context.isCloudHomeEntry = () => true;
  await handlers.get("cloud-move:start")(page);
  assert.deepEqual(calls, [["openSettings", "vps", "copy"]]);
  context.isCloudHomeEntry = isCloudHomeEntry;
  context.mainWindow.webContents = vpsContents;
  context.environmentsState = { environments: SAVED, activeId: "vps" };
  // It names no destination, and never swaps back.
  assert.throws(() => handlers.get("cloud-move:start")(page, "cloud-entry"), /only available/);
  assert.throws(() => handlers.get("cloud-move:restore-previous")(page), /only available/);
  // It stops only a copy to itself.
  calls.length = 0;
  setState({ phase: "uploading", destination: { origin: ORIGIN } });
  await handlers.get("cloud-move:cancel")(page);
  setState({ phase: "uploading", destination: { origin: "https://bots.example.test" } });
  await handlers.get("cloud-move:cancel")(page);
  assert.deepEqual(calls, [["cancel"]]);
  // The person's Cloud, open in this window: the Cloud's way in, the same rule.
  calls.length = 0;
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: SAVED, activeId: "cloud-entry" };
  await handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(calls, [["move", CLOUD_DEST, { requireEmpty: true }]]);
  // A subframe, another window, a page that is not the active server, or a companion: nothing.
  for (const event of [{ sender: cloudContents, senderFrame: { url: `${ORIGIN}/` } }, { sender: {}, senderFrame: cloudFrame }, { sender: cloudContents, senderFrame: { url: "https://evil.example.test/" } }]) {
    for (const channel of ["cloud-move:state", "cloud-move:start", "cloud-move:cancel", "cloud-move:dismiss", "cloud-move:restore-previous"]) assert.throws(() => handlers.get(channel)(event), /only available/);
  }
  context.desktopRemoteAccess = true;
  assert.throws(() => handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
});

test("production IPC: a finished copy opens the server it went to", async () => {
  const { context, handlers, calls } = mainIpc();
  context.result = { phase: "done", action: "move" };
  const local = { sender: localContents, senderFrame: localFrame };
  await handlers.get("cloud-move:start")(local, "vps");
  // The Cloud without a saved entry yet: the Cloud's own connection adds and opens it.
  context.environmentsState = { environments: [SAVED[0]], activeId: "local" };
  await handlers.get("cloud-move:start")(local, "cloud");
  // Already open (the verified Cloud's own page started it): it reloads.
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: SAVED, activeId: "cloud-entry" };
  const cloudPage = { sender: cloudContents, senderFrame: cloudFrame };
  await handlers.get("cloud-move:start")(cloudPage);
  assert.deepEqual(calls.filter(([kind]) => kind !== "move"), [["switch", "vps"], ["connectCloudHome"], ["navigate", ORIGIN]]);
  calls.length = 0;
  context.result = { phase: "failed", error: { code: "network" } };
  await handlers.get("cloud-move:start")(cloudPage);
  assert.deepEqual(calls.filter(([kind]) => kind !== "move"), []);
});

test("a server's Copy opens this computer's Settings → Servers on that server's copy, in this window or by switching it to this computer", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("function openWorkspaceSettings("), end = source.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({ LOCAL_ID: "local", rendererOrigin: () => LOCAL, environmentsState: { environments: SAVED, activeId: "vps" },
    withActive: (state, id) => ({ ...state, activeId: id }), persistEnvironments: state => calls.push(["persist", state.activeId]),
    navigateMainWindow: url => calls.push(["navigate", url]), senderIsLocal: ({ sender }) => sender === localContents,
    mainWindow: { isDestroyed: () => false, webContents: { ...vpsContents, send: (...args) => calls.push(["send", ...args]) } } });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.openWorkspaceSettings = openWorkspaceSettings;`, context);
  // On a server's page: this window switches to this computer, on that server's copy panel.
  context.openWorkspaceSettings("vps", "copy");
  context.openWorkspaceSettings("vps");
  assert.deepEqual(calls, [["persist", "local"], ["navigate", `${LOCAL}/?desktop-settings=workspaces&copy-to=vps`],
    ["persist", "local"], ["navigate", `${LOCAL}/?desktop-settings=workspaces&share-computer=vps`]]);
  // Already on this computer's page: one message names the server and the panel.
  calls.length = 0;
  const send = (...args) => calls.push(["send", ...args]);
  context.mainWindow = { isDestroyed: () => false, webContents: localContents };
  localContents.send = send;
  try {
    context.openWorkspaceSettings("vps", "copy");
    context.openWorkspaceSettings("vps");
  } finally { delete localContents.send; }
  assert.deepEqual(calls, [["send", "workspaces:open-settings", "vps", "copy"], ["send", "workspaces:open-settings", "vps"]]);
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
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(IPC_START), end = source.indexOf(IPC_END, start);
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

test("Settings on the person's own Cloud shows the plan read only, and can only open the dashboard or switch back", async () => {
  const page = preload({ remote: true });
  assert.deepEqual(Object.keys(page.bridge.cloudPlan), ["state", "manage", "useThisComputer"]);
  assert.equal(page.bridge.cloudAccount, undefined, "no account, credential or address reaches the Cloud's page");
  await page.bridge.cloudPlan.state({ origin: "https://evil.example.test" });
  await assert.rejects(page.bridge.cloudPlan.manage(), /Choose Manage/);
  await assert.rejects(page.bridge.cloudPlan.useThisComputer(), /Choose Use this computer/);
  assert.deepEqual(page.invoked, [["cloud-plan:state"]]);
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudPlan.manage("https://evil.example.test"); await clicked.bridge.cloudPlan.useThisComputer("vps");
  assert.deepEqual(clicked.invoked, [["cloud-plan:manage"], ["cloud-plan:local"]]);

  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(IPC_START), end = source.indexOf(IPC_END, start);
  const handlers = new Map(), calls = [];
  const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
  localOrigin.setLocalOrigin(LOCAL);
  const account = { status: "connected", account: { id: "a1", email: "person@example.test" }, deviceId: "d1",
    entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1, version: 1 }, machine: { status: "ready", origin: ORIGIN } };
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: cloudContents },
    environmentsState: { environments: [{ id: "cloud", name: "My Cloud", origin: ORIGIN }], activeId: "cloud" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }), state: () => account }, cloudPlanSnapshot, LOCAL_ID: environments.LOCAL_ID, rememberedHome: null,
    ensureCloudAccount: () => ({ openDashboard: async (...args) => { calls.push(["dashboard", ...args]); return account; } }),
    workspaceMenuAction: action => action(), switchEnvironment: id => { calls.push(["switch", id]); },
  });
  vm.runInContext(source.slice(start, end), context);
  const event = { sender: cloudContents, senderFrame: cloudFrame };
  assert.deepEqual(await handlers.get("cloud-plan:state")(event, { tier: "personal" }), { status: "paid", tier: "max" });
  assert.equal(await handlers.get("cloud-plan:manage")(event, "https://evil.example.test"), undefined);
  await handlers.get("cloud-plan:local")(event, "vps");
  assert.deepEqual(calls, [["dashboard"], ["switch", environments.LOCAL_ID]]);
  for (const sender of [{ sender: cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: cloudFrame }]) {
    for (const channel of ["cloud-plan:state", "cloud-plan:manage", "cloud-plan:local"]) assert.throws(() => handlers.get(channel)(sender), /only available/);
  }
  // The sign-in is being checked, or has ended: there is no verified Cloud to
  // connect to, but the one this account last verified still answers, never an error.
  let current = { status: "reauth-required", message: "expired", account: account.account, lastPlan: { tier: "max", active: true } };
  context.cloudAccount = { homeTarget: () => null, state: () => current };
  assert.throws(() => handlers.get("cloud-plan:state")(event), /only available/);
  context.rememberedHome = { accountId: "a1", origin: ORIGIN };
  assert.deepEqual(await handlers.get("cloud-plan:state")(event), { status: "signin", tier: "max" });
  current = { status: "unavailable", account: account.account, lastPlan: { tier: "max", active: true } };
  assert.deepEqual(await handlers.get("cloud-plan:state")(event), { status: "checking", tier: "max" });
  await handlers.get("cloud-plan:local")(event);
  assert.deepEqual(calls.at(-1), ["switch", environments.LOCAL_ID]);
  // Only this account's Cloud, and only on that Cloud's own page; Move and lending are not widened.
  context.rememberedHome = { accountId: "someone-else", origin: ORIGIN };
  assert.throws(() => handlers.get("cloud-plan:state")(event), /only available/);
  context.rememberedHome = { accountId: "a1", origin: ORIGIN };
  assert.throws(() => handlers.get("cloud-plan:state")({ sender: cloudContents, senderFrame: { url: "https://other.example.test/" } }), /only available/);
  assert.throws(() => handlers.get("cloud-lending:open")(event), /only available/);
  context.cloudAccount = { homeTarget: () => ({ origin: ORIGIN }), state: () => account };
  assert.deepEqual(cloudPlanSnapshot({ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }), { status: "signin", tier: "pro" });
  assert.deepEqual(cloudPlanSnapshot({ status: "reauth-required", message: "access-ended", lastPlan: { active: true } }), { status: "signin", tier: "pro" });
  assert.deepEqual(cloudPlanSnapshot({ status: "reauth-required", message: "access-ended" }), { status: "signin" });
  assert.deepEqual(cloudPlanSnapshot({ status: "unavailable", lastPlan: { tier: "pro", active: true } }), { status: "checking", tier: "pro" });
  assert.deepEqual(cloudPlanSnapshot({ ...account, entitlement: { ...account.entitlement, status: "inactive" } }), { status: "attention", tier: "max" });
  assert.deepEqual(cloudPlanSnapshot({ status: "signed-out" }), { status: "none" });
});
