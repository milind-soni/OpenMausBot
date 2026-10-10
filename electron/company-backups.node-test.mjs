import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCompanyBackups } from "./company-backups.mjs";

const PART_BYTES = 64 * 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const BACKUP_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_ID = "33333333-3333-4333-8333-333333333333";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const PASSWORD = "fixture-only backup password";
const SUMMARY = { format: "openmaus.workspace-backup", version: 1, id: UPLOAD_ID, bytes: 4096, bots: 1, conversations: 2, messages: 3 };
const partEtag = partNumber => `"${partNumber.toString(16).padStart(32, "0")}"`;

// These are synthetic opaque container bytes, not a real encrypted workspace.
// The real encryption and replacement workflow is tested by the server fixture.
function archiveChunk(offset, length) {
  const chunk = Buffer.alloc(length, 0xa5);
  if (offset < MAGIC.length) MAGIC.copy(chunk, 0, offset, Math.min(MAGIC.length, offset + length));
  return chunk;
}

function archiveHash(size, start = 0) {
  const hash = createHash("sha256");
  for (let offset = start; offset < start + size; offset += 65536) {
    hash.update(archiveChunk(offset, Math.min(65536, start + size - offset)));
  }
  return hash.digest("hex");
}

function archiveStream(size, { transform, onRead, onCancel } = {}) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= size) return controller.close();
      const length = Math.min(65536, size - offset);
      let chunk = archiveChunk(offset, length);
      if (transform) chunk = transform(chunk, offset);
      offset += length;
      onRead?.(length);
      controller.enqueue(chunk);
    },
    cancel() { onCancel?.(); },
  }, { highWaterMark: 0 });
}

async function inspectBody(body) {
  const hash = createHash("sha256");
  let size = 0;
  let prefix = Buffer.alloc(0);
  const chunks = typeof body === "string" || ArrayBuffer.isView(body) || body instanceof ArrayBuffer
    ? [typeof body === "string" ? Buffer.from(body) : body instanceof ArrayBuffer ? Buffer.from(body) : body]
    : body instanceof Blob ? body.stream() : body;
  for await (const value of chunks) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    hash.update(chunk);
    if (prefix.length < 100) prefix = Buffer.concat([prefix, chunk.subarray(0, 100 - prefix.length)]);
  }
  return { size, sha256: hash.digest("hex"), prefix };
}

function jsonBody(options) {
  return typeof options.body === "string" ? JSON.parse(options.body) : options.body;
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omb-company-backups-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  await fs.writeFile(path.join(root, "keep.txt"), "unrelated temporary content");
  await fs.mkdir(path.join(root, "unrelated"));
  await fs.writeFile(path.join(root, "unrelated", "keep.txt"), "unrelated directory content");
  const size = overrides.size ?? 4096;
  const sha256 = archiveHash(size);
  const localCalls = [], portalCalls = [], storageCalls = [], uploaded = [], progress = [];
  let created;
  const ready = () => ({ id: BACKUP_ID, status: "ready", sizeBytes: size, sha256, passwordRequired: false });
  const f = {
    root, size, sha256, localCalls, portalCalls, storageCalls, uploaded, progress, ready,
    archiveResponse: (bytes = size, options = {}) => new Response(archiveStream(bytes, options), {
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes) },
    }),
    async clean() {
      assert.deepEqual((await fs.readdir(root)).sort(), ["keep.txt", "unrelated"]);
      assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "unrelated temporary content");
      assert.equal(await fs.readFile(path.join(root, "unrelated", "keep.txt"), "utf8"), "unrelated directory content");
    },
  };
  f.client = createCompanyBackups({
    tempRoot: root,
    availableBytes: overrides.availableBytes ?? (async () => 1_000_000_000_000),
    allowLoopbackForTests: overrides.allowLoopbackForTests ?? false,
    async localRequest(route, options = {}) {
      localCalls.push({ route, options });
      const result = await overrides.local?.(route, options, f);
      if (result !== undefined) return result;
      if (route === "/api/workspace-backup/export") return Response.json({ id: EXPORT_ID, bytes: size, summary: SUMMARY });
      if (route === `/api/workspace-backup/download/${EXPORT_ID}`) return f.archiveResponse();
      if (route === "/api/workspace-backup/upload") {
        uploaded.push(await inspectBody(options.body));
        return Response.json({ id: UPLOAD_ID });
      }
      if (route === "/api/workspace-backup/preview") return Response.json({ id: UPLOAD_ID, summary: SUMMARY });
      throw new Error(`Unexpected local fixture request: ${route}`);
    },
    async portalRequest(route, options = {}) {
      portalCalls.push({ route, options });
      const result = await overrides.portal?.(route, options, f);
      if (result !== undefined) return result;
      if (route === "/api/desktop/backups") {
        created = jsonBody(options);
        return { ...ready(), ...created, status: "uploading", partSizeBytes: PART_BYTES, partCount: Math.ceil(size / PART_BYTES) };
      }
      const part = route.match(new RegExp(`^/api/desktop/backups/${BACKUP_ID}/parts/(\\d+)$`));
      if (part) {
        const partNumber = Number(part[1]);
        const sizeBytes = Math.min(PART_BYTES, size - (partNumber - 1) * PART_BYTES);
        return { url: `${R2_ORIGIN}/fixture/object?partNumber=${partNumber}&signature=fixture`, headers: { "content-length": String(sizeBytes) }, sizeBytes, partNumber, expiresAt: Date.now() + 300_000 };
      }
      if (route === `/api/desktop/backups/${BACKUP_ID}/complete`) return { ...ready(), ...created, status: "ready" };
      if (route === `/api/desktop/backups/${BACKUP_ID}/abort`) return { ok: true };
      if (route === `/api/desktop/backups/${BACKUP_ID}/download`) return { ...ready(), unlockKey: PASSWORD, url: `${R2_ORIGIN}/fixture/object?signature=fixture`, expiresAt: Date.now() + 300_000 };
      throw new Error(`Unexpected portal fixture request: ${route}`);
    },
    async fetchImpl(input, options = {}) {
      const url = String(input);
      storageCalls.push({ url, options });
      const result = await overrides.storage?.(url, options, f);
      if (result !== undefined) return result;
      assert.equal(new URL(url).origin, R2_ORIGIN, "No real network is permitted by this fixture");
      if (options.method === "PUT") {
        const partNumber = Number(new URL(url).searchParams.get("partNumber"));
        uploaded.push({ partNumber, ...await inspectBody(options.body) });
        return new Response(null, { status: 200, headers: { etag: partEtag(partNumber) } });
      }
      assert.equal(options.method ?? "GET", "GET");
      return f.archiveResponse();
    },
  });
  f.backup = (signal, input = {}) => f.client.backup(input, signal, value => progress.push(value));
  f.restore = signal => f.client.prepareRestore({ id: BACKUP_ID }, signal, value => progress.push(value));
  return f;
}

function assertStorageIsolation(calls) {
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    const headers = new Headers(options.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
  }
}

test("backup generates a native key, sends it only to Admin, and never exposes it in returned metadata or progress", async t => {
  const f = await fixture(t);
  const clientState = { fixtureDraft: "private local draft" };
  const ready = await f.backup(undefined, { clientState, appVersion: "0.0.0-fixture" });
  assert.equal(ready.id, BACKUP_ID);
  assert.equal(ready.status, "ready");
  const password = jsonBody(f.localCalls[0].options).password;
  assert.match(password, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(jsonBody(f.localCalls[0].options), { password, clientState });
  const create = f.portalCalls.find(call => call.route === "/api/desktop/backups");
  assert.deepEqual(jsonBody(create.options), { sizeBytes: f.size, sha256: f.sha256, appVersion: "0.0.0-fixture", unlockKey: password });
  assert(!JSON.stringify(ready).includes(password));
  assert(!JSON.stringify(f.progress).includes(password));
  assert(!JSON.stringify(f.storageCalls).includes(password));
  assert.equal(f.uploaded.length, 1);
  assert.equal(f.uploaded[0].size, f.size);
  assert.equal(f.uploaded[0].sha256, f.sha256);
  assert.deepEqual(f.uploaded[0].prefix.subarray(0, MAGIC.length), MAGIC);
  const complete = f.portalCalls.find(call => call.route.endsWith("/complete"));
  assert.deepEqual(jsonBody(complete.options), { parts: [{ partNumber: 1, etag: partEtag(1) }] });
  assert(!JSON.stringify(f.portalCalls).includes(PASSWORD));
  assert(!JSON.stringify(f.portalCalls).includes(clientState.fixtureDraft));
  assert(!JSON.stringify(f.progress).includes(PASSWORD));
  assert(f.progress.length > 0);
  assertStorageIsolation(f.storageCalls);
  await f.clean();
});

test("multipart backup streams exact 64 MiB boundaries without collecting the archive in the test", async t => {
  const f = await fixture(t, { size: PART_BYTES + 713 });
  await f.backup();
  assert.deepEqual(f.uploaded.map(({ partNumber, size, sha256 }) => ({ partNumber, size, sha256 })), [
    { partNumber: 1, size: PART_BYTES, sha256: archiveHash(PART_BYTES) },
    { partNumber: 2, size: 713, sha256: archiveHash(713, PART_BYTES) },
  ]);
  const complete = f.portalCalls.find(call => call.route.endsWith("/complete"));
  assert.deepEqual(jsonBody(complete.options).parts, [
    { partNumber: 1, etag: partEtag(1) },
    { partNumber: 2, etag: partEtag(2) },
  ]);
  assertStorageIsolation(f.storageCalls);
  await f.clean();
});

test("older Admin cannot silently accept an archive without retaining its automatic key", async t => {
  const f = await fixture(t, { portal: route => route === "/api/desktop/backups" ? {
    id: BACKUP_ID, status: "uploading", sizeBytes: 4096, sha256: archiveHash(4096), partSizeBytes: PART_BYTES, partCount: 1,
  } : undefined });
  await assert.rejects(f.backup(), { code: "update_required" });
  assert.equal(f.storageCalls.length, 0);
  assert(f.portalCalls.some(call => call.route.endsWith("/abort")));
});

test("legacy password archives still restore, while managed archives require the service key", async t => {
  const f = await fixture(t, { portal: (route, _options, state) => route.endsWith("/download") ? {
    ...state.ready(), passwordRequired: true, url: `${R2_ORIGIN}/fixture/object`, expiresAt: Date.now() + 300_000,
  } : undefined });
  await assert.rejects(f.restore(), { code: "invalid_password" });
  await f.client.prepareRestore({ id: BACKUP_ID, password: PASSWORD });
  assert.equal(jsonBody(f.localCalls.at(-1).options).password, PASSWORD);
  const missing = await fixture(t, { portal: (route, _options, state) => route.endsWith("/download") ? {
    ...state.ready(), url: `${R2_ORIGIN}/fixture/object`, expiresAt: Date.now() + 300_000,
  } : undefined });
  await assert.rejects(missing.client.prepareRestore({ id: BACKUP_ID, password: PASSWORD }), { code: "invalid_password" });
  assert.equal(missing.storageCalls.length, 0);
});

test("restore verifies the downloaded archive and prepares only a local preview, never replacement", async t => {
  const f = await fixture(t);
  const preview = await f.restore();
  assert.deepEqual(preview, { id: UPLOAD_ID, summary: SUMMARY });
  assert.equal(f.uploaded.length, 1);
  assert.equal(f.uploaded[0].size, f.size);
  assert.equal(f.uploaded[0].sha256, f.sha256);
  assert.deepEqual(f.localCalls.map(call => call.route), ["/api/workspace-backup/upload", "/api/workspace-backup/preview"]);
  assert.deepEqual(jsonBody(f.localCalls[1].options), { id: UPLOAD_ID, password: PASSWORD });
  assert.equal(new Headers(f.localCalls[0].options.headers).get("content-type"), "application/octet-stream");
  assert(!JSON.stringify(f.portalCalls).includes(PASSWORD));
  assert(!f.localCalls.some(call => /\/restore(?:\/|$)/.test(call.route)));
  assertStorageIsolation(f.storageCalls);
  await f.clean();
});

for (const corruption of ["short", "long", "hash", "magic"]) {
  test(`restore rejects ${corruption} download before any local upload or preview`, async t => {
    const f = await fixture(t, {
      storage: (_url, _options, state) => {
        if (corruption === "short") return state.archiveResponse(state.size - 1);
        if (corruption === "long") return state.archiveResponse(state.size + 1);
        return state.archiveResponse(state.size, { transform: (chunk, offset) => {
          if (offset === 0) chunk[corruption === "magic" ? 0 : 100] ^= 1;
          return chunk;
        } });
      },
    });
    await assert.rejects(f.restore());
    assert.deepEqual(f.localCalls, []);
    await f.clean();
  });
}

for (const bytes of [59, MAX_BYTES + 1, -1, 2.5]) {
  test(`invalid export size ${bytes} is rejected before fetching bytes or creating cloud state`, async t => {
    const f = await fixture(t, {
      local: route => route.endsWith("/export") ? Response.json({ id: EXPORT_ID, bytes, summary: SUMMARY }) : undefined,
    });
    await assert.rejects(f.backup());
    assert.equal(f.localCalls.length, 1);
    assert.deepEqual(f.portalCalls, []);
    assert.deepEqual(f.storageCalls, []);
    await f.clean();
  });
}

test("local export JSON responses are bounded before parsing", async t => {
  let readBytes = 0;
  let cancelled = false;
  const f = await fixture(t, {
    local: route => route.endsWith("/export") ? new Response(archiveStream(8 * 1024 * 1024, {
      transform: chunk => Buffer.alloc(chunk.length, 0x20),
      onRead: bytes => { readBytes += bytes; }, onCancel: () => { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }) : undefined,
  });
  await assert.rejects(f.backup());
  assert(readBytes < 8 * 1024 * 1024, "Stop reading oversized JSON before its entire body arrives");
  assert.equal(cancelled, true);
  assert.deepEqual(f.portalCalls, []);
  await f.clean();
});

test("a local archive that exceeds its declared size is rejected before cloud creation", async t => {
  const f = await fixture(t, {
    local: (route, _options, state) => route.includes("/download/") ? new Response(archiveStream(state.size + 1)) : undefined,
  });
  await assert.rejects(f.backup());
  assert.deepEqual(f.portalCalls, []);
  await f.clean();
});

for (const url of [
  "https://attacker.example.test/object",
  `${R2_ORIGIN}.attacker.example.test/object`,
  "https://r2.cloudflarestorage.com/object",
  `${R2_ORIGIN.replace("https:", "http:")}/object`,
  `https://user:password@${new URL(R2_ORIGIN).host}/object`,
  `${R2_ORIGIN}:444/object`,
  "http://127.0.0.1:9987/object",
  "file:///tmp/fixture.ombbackup",
]) {
  test(`cloud restore refuses untrusted storage URL ${url}`, async t => {
    const f = await fixture(t, {
      portal: (route, _options, state) => route.endsWith("/download") ? { ...state.ready(), url, expiresAt: Date.now() + 300_000 } : undefined,
    });
    await assert.rejects(f.restore());
    assert.deepEqual(f.storageCalls, []);
    assert.deepEqual(f.localCalls, []);
    await f.clean();
  });
}

test("an invalid signed upload URL triggers an abort without fetching that URL", async t => {
  const f = await fixture(t, {
    portal: (route, _options, state) => route.includes("/parts/") ? {
      url: "https://attacker.example.test/upload", headers: { "content-length": String(state.size) },
      sizeBytes: state.size, partNumber: 1, expiresAt: Date.now() + 300_000,
    } : undefined,
  });
  await assert.rejects(f.backup());
  assert.deepEqual(f.storageCalls, []);
  assert(f.portalCalls.some(call => call.route.endsWith("/abort")));
  assert(!f.portalCalls.some(call => call.route.endsWith("/complete")));
  await f.clean();
});

for (const [name, mutation] of [
  ["expired download", { expiresAt: 1 }],
  ["non-ready download", { status: "uploading" }],
  ["different backup ID", { id: EXPORT_ID }],
  ["oversized archive", { sizeBytes: MAX_BYTES + 1 }],
  ["undersized archive", { sizeBytes: 59 }],
  ["invalid SHA-256", { sha256: "not-a-checksum" }],
]) {
  test(`restore rejects ${name} metadata without fetching storage`, async t => {
    const f = await fixture(t, {
      portal: (route, _options, state) => route.endsWith("/download") ? {
        ...state.ready(), url: `${R2_ORIGIN}/fixture/object`, expiresAt: Date.now() + 300_000, ...mutation,
      } : undefined,
    });
    await assert.rejects(f.restore());
    assert.deepEqual(f.storageCalls, []);
    assert.deepEqual(f.localCalls, []);
    await f.clean();
  });
}

for (const [name, mutation] of [
  ["expired signature", { expiresAt: 1 }],
  ["different part number", { partNumber: 2 }],
  ["different part size", { sizeBytes: 4000 }],
  ["different content length", { headers: { "content-length": "4000" } }],
]) {
  test(`upload rejects ${name} before sending bytes`, async t => {
    const f = await fixture(t, {
      portal: (route, _options, state) => route.includes("/parts/") ? {
        url: `${R2_ORIGIN}/fixture/object?partNumber=1`, headers: { "content-length": String(state.size) },
        sizeBytes: state.size, partNumber: 1, expiresAt: Date.now() + 300_000, ...mutation,
      } : undefined,
    });
    await assert.rejects(f.backup());
    assert.deepEqual(f.storageCalls, []);
    assert(f.portalCalls.some(call => call.route.endsWith("/abort")));
    assert(!f.portalCalls.some(call => call.route.endsWith("/complete")));
    await f.clean();
  });
}

test("the portal cannot select a different multipart chunk size", async t => {
  const f = await fixture(t, {
    portal: (route, _options, state) => route === "/api/desktop/backups" ? {
      ...state.ready(), status: "uploading", partSizeBytes: 128 * 1024 * 1024, partCount: 1,
    } : undefined,
  });
  await assert.rejects(f.backup());
  assert.deepEqual(f.storageCalls, []);
  assert(!f.portalCalls.some(call => call.route.includes("/parts/") || call.route.endsWith("/complete")));
  await f.clean();
});

test("signed storage metadata cannot inject authorization or cookie headers into uploads", async t => {
  const f = await fixture(t, {
    portal: (route, _options, state) => route.includes("/parts/") ? {
      url: `${R2_ORIGIN}/fixture/object?partNumber=1`,
      headers: { "content-length": String(state.size), authorization: "Bearer fixture-secret", cookie: "session=fixture-secret" },
      sizeBytes: state.size, partNumber: 1, expiresAt: Date.now() + 300_000,
    } : undefined,
  });
  await assert.rejects(f.backup());
  assert.deepEqual(f.storageCalls, []);
  assert(f.portalCalls.some(call => call.route.endsWith("/abort")));
  await f.clean();
});

for (const operation of ["backup", "restore"]) {
  test(`${operation} does not follow storage redirects or forward authority`, async t => {
    const f = await fixture(t, {
      storage: () => new Response(null, { status: 307, headers: { location: "https://attacker.example.test/steal" } }),
    });
    await assert.rejects(f[operation]());
    assert.equal(f.storageCalls.length, 1);
    assertStorageIsolation(f.storageCalls);
    assert(!f.storageCalls.some(call => call.url.includes("attacker")));
    assert(!f.localCalls.some(call => call.route.endsWith("/upload") || call.route.endsWith("/preview")));
    if (operation === "backup") assert(f.portalCalls.some(call => call.route.endsWith("/abort")));
    await f.clean();
  });
}

test("cancelled upload attempts a fresh-signal best-effort abort even if portal cleanup fails", async t => {
  const controller = new AbortController();
  const f = await fixture(t, {
    storage: async (_url, options) => {
      await inspectBody(options.body);
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    },
    portal: (route, options) => {
      if (route.endsWith("/abort")) {
        assert.notEqual(options.signal?.aborted, true, "Cleanup must not reuse the cancelled transfer signal");
        throw new Error("Fixture portal temporarily unavailable");
      }
    },
  });
  await assert.rejects(f.backup(controller.signal));
  assert.equal(f.portalCalls.filter(call => call.route.endsWith("/abort")).length, 1);
  assert(!f.portalCalls.some(call => call.route.endsWith("/complete")));
  await f.clean();
});

test("an already-cancelled operation makes no local or portal requests", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.backup(controller.signal));
  await assert.rejects(f.restore(controller.signal));
  assert.deepEqual(f.localCalls, []);
  assert.deepEqual(f.portalCalls, []);
  assert.deepEqual(f.storageCalls, []);
  await f.clean();
});

for (const operation of ["backup", "restore"]) {
  test(`${operation} fails safely when free temporary storage is insufficient`, async t => {
    const f = await fixture(t, { availableBytes: async () => 0 });
    await assert.rejects(f[operation]());
    assert.deepEqual(f.storageCalls, []);
    assert(!f.localCalls.some(call => call.route.includes("/download/") || call.route.endsWith("/upload") || call.route.endsWith("/preview")));
    assert(!f.portalCalls.some(call => call.route === "/api/desktop/backups"));
    await f.clean();
  });
}

test("space is rechecked after export size is known and before downloading its bytes", async t => {
  const f = await fixture(t, { availableBytes: async () => PART_BYTES + 100 });
  await assert.rejects(f.backup());
  assert.equal(f.localCalls.filter(call => call.route.endsWith("/export")).length, 1);
  assert(!f.localCalls.some(call => call.route.includes("/download/")));
  assert.deepEqual(f.portalCalls, []);
  await f.clean();
});

for (const [stage, checkNumber, multiplier, localUploads, storageRequests] of [
  ["download", 2, 4, 0, 0],
  ["local upload", 3, 3, 0, 1],
  ["preview", 4, 2, 1, 1],
]) {
  test(`restore reserves simultaneous archive copies before ${stage}`, async t => {
    let checks = 0;
    const f = await fixture(t, {
      availableBytes: async () => ++checks === checkNumber ? PART_BYTES + 4096 * multiplier - 1 : 1_000_000_000_000,
    });
    await assert.rejects(f.restore(), { code: "no_space" });
    assert.equal(f.storageCalls.length, storageRequests);
    assert.equal(f.localCalls.filter(call => call.route.endsWith("/upload")).length, localUploads);
    assert(!f.localCalls.some(call => call.route.endsWith("/preview")));
    await f.clean();
  });
}

for (const [stage, limit] of [["upload", 4096], ["preview", 2 * 1024 * 1024]]) {
  test(`restore bounds the local ${stage} JSON response and cancels its oversized stream`, async t => {
    const totalBytes = Math.max(limit * 4, 1024 * 1024);
    let readBytes = 0;
    let cancelled = false;
    const f = await fixture(t, {
      local: async (route, options) => {
        if (!route.endsWith(`/${stage}`)) return;
        if (stage === "upload") await inspectBody(options.body);
        return new Response(archiveStream(totalBytes, {
          transform: chunk => Buffer.alloc(chunk.length, 0x20),
          onRead: bytes => { readBytes += bytes; }, onCancel: () => { cancelled = true; },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    await assert.rejects(f.restore(), { code: "invalid_response" });
    // Stream adapters may prefetch a chunk, but cannot consume the entire body.
    assert(readBytes < totalBytes);
    assert.equal(cancelled, true);
    if (stage === "upload") assert(!f.localCalls.some(call => call.route.endsWith("/preview")));
    assert(!f.localCalls.some(call => /\/restore(?:\/|$)/.test(call.route)));
    await f.clean();
  });
}

test("restore cancellation while reading storage never sends local upload or preview", async t => {
  const controller = new AbortController();
  const f = await fixture(t, {
    storage: (_url, _options, state) => state.archiveResponse(state.size, { onRead: () => controller.abort() }),
  });
  await assert.rejects(f.restore(controller.signal), { code: "cancelled" });
  assert.deepEqual(f.localCalls, []);
  await f.clean();
});

test("temporary operation files and directories are private while upload is in progress", async t => {
  const f = await fixture(t, {
    storage: async (_url, options, state) => {
      const entries = await fs.readdir(state.root, { withFileTypes: true });
      const owned = entries.filter(entry => !["keep.txt", "unrelated"].includes(entry.name));
      assert(owned.length > 0, "Expected an operation-private staging directory");
      for (const entry of owned) {
        const target = path.join(state.root, entry.name);
        const stat = await fs.lstat(target);
        assert.equal(stat.isSymbolicLink(), false);
        if (process.platform !== "win32") assert.equal(stat.mode & 0o077, 0);
        if (entry.isDirectory()) {
          for (const child of await fs.readdir(target)) {
            const childStat = await fs.lstat(path.join(target, child));
            if (process.platform !== "win32") assert.equal(childStat.mode & 0o077, 0);
          }
        }
      }
      await inspectBody(options.body);
      return new Response(null, { headers: { etag: partEtag(1) } });
    },
  });
  await f.backup();
  await f.clean();
});

test("progress callback exceptions cannot prevent successful transfer or private cleanup", async t => {
  const f = await fixture(t);
  const ready = await f.client.backup({ password: PASSWORD }, undefined, () => { throw new Error("Fixture UI closed"); });
  assert.equal(ready.status, "ready");
  await f.clean();
});
