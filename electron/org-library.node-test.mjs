import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOrgLibrary, libraryCapability, libraryRouteLimits, parseLibraryPointer, parseLibraryReportEntries, parseLibraryStateMessage, parseOrgLibraryCatalog, sha256Hex,
} from "./org-library.mjs";
import { createManagedDesktopClient, createManagedDesktopRelay } from "./managed-desktop.mjs";

// Everything here is synthetic: a fake Admin (fetch or fetchBytes), a fake
// runtime (the relay) and a throwaway data folder. No Electron, no keychain,
// no network, no user data. Shapes follow contract 60 §5 and Admin's
// feat/package-registry routes.
const origin = "https://company.example.test";
const DEVICE = "11111111-1111-4111-8111-111111111111", ORG = "22222222-2222-4222-8222-222222222222", PUBLISHER = "33333333-3333-4333-8333-333333333333";
const TEAM = "44444444-4444-4444-8444-444444444444", SKILLS = "55555555-5555-4555-8555-555555555555", OFF = "66666666-6666-4666-8666-666666666666", NEWER = "77777777-7777-4777-8777-777777777777";
const identity = (extra = {}) => ({ portalOrigin: origin, organizationId: ORG, deviceId: DEVICE, expiresAt: Date.now() + 86400_000, ...extra });
// Release bytes as Admin serves them: the canonical document, here the committed fixture.
const teamBytes = readFileSync(new URL("../shared/package-fixtures/full-team.v2.json", import.meta.url));
const skillBytes = readFileSync(new URL("../shared/package-fixtures/library-only.v2.json", import.meta.url));
const release = (bytes, extra = {}) => ({ version: "1.3.0", sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength, formatVersion: 2, publishedAt: 1_758_000_000_000, notes: "First release.\nAdds the deal desk.", ...extra });
const entry = (packageId, extra = {}) => ({ packageId, ref: "acme/sales-desk", name: "Sales desk", tagline: "Qualify leads.", kind: "team",
  publisher: { organizationId: PUBLISHER, name: "Acme Partners", self: false }, mode: "available", offAction: "keep", release: release(teamBytes), withdrawnReleases: [],
  contents: { bots: 3, skills: 2, presets: 0, rooms: 1, routines: 2, connections: 1, botNames: ["Scout", "Closer", "Pixel"] }, scanFindings: 0, ...extra });
const catalogOf = (packages, extra = {}) => ({ format: "openmaus.org-library", version: 1, libraryVersion: 1, organization: { id: ORG, name: "Beta Clinic" }, packages, ...extra });
const standard = (extra = {}) => catalogOf([
  entry(TEAM),
  entry(SKILLS, { ref: "acme/refund-skills", name: "Refund skills", kind: "library", release: release(skillBytes, { version: "2.0.0" }) }),
  // Switched off by this organization, and a format this app cannot read: listed, never fetched.
  entry(OFF, { ref: "acme/old-desk", mode: "off", release: release(Buffer.from("off release bytes")) }),
  entry(NEWER, { ref: "acme/next-desk", release: release(Buffer.from("a version 3 document"), { formatVersion: 3 }) }),
], extra);
const bytesOf = value => Buffer.from(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
// Windows has no POSIX file modes (stat reports 0o666); the 0600 checks run on macOS and Linux.
const mode = async file => process.platform === "win32" ? 0o600 : (await fs.stat(file)).mode & 0o777;
const exists = file => fs.access(file).then(() => true, () => false);

/** A fake Admin behind fetchBytes, a fake runtime behind relay, and a clock. */
async function fixture(t, { catalog = standard(), relayOk = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "omb-org-library-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, "org-library");
  const f = {
    dataDir, clock: Date.now(), relayOk, requests: [], relayed: [], logs: [], timers: [], record: { value: null, writes: [] },
    catalogBytes: bytesOf(catalog), blobs: new Map([[sha256Hex(teamBytes), teamBytes], [sha256Hex(skillBytes), skillBytes]]),
    reports: [], reportFails: false, blobStatus: null, hold: null,
  };
  /** The next request for `route` (or, for "record", the next save of a catalog record) waits until release(); `reached` resolves once it is in flight. */
  f.holdNext = route => {
    let release, arrived;
    const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { arrived = resolve; });
    f.hold = { route, gate, arrived };
    return { reached, release };
  };
  f.digest = () => sha256Hex(f.catalogBytes);
  f.setCatalog = value => { f.catalogBytes = bytesOf(value); return f.digest(); };
  f.library = createOrgLibrary({
    dataDir, appVersion: "0.1.90", log: message => f.logs.push(message), now: () => f.clock,
    setTimer: (callback, delay) => { const timer = { callback, at: f.clock + delay }; f.timers.push(timer); return timer; },
    clearTimer: timer => { f.timers = f.timers.filter(item => item !== timer); },
    store: { read: async () => f.record.value, write: async value => {
      f.record.writes.push(value);
      if (value !== null && f.hold?.route === "record") { const { gate, arrived } = f.hold; f.hold = null; arrived(); await gate; }
      f.record.value = value === null ? null : structuredClone(value);
    } },
    relay: async library => { f.relayed.push(library); if (!f.relayOk) throw new Error("not acknowledged"); },
    fetchBytes: async (route, maxBytes, options) => {
      f.requests.push({ route, maxBytes, options });
      if (f.hold?.route === route) { const { gate, arrived } = f.hold; f.hold = null; arrived(); await gate; }
      if (route === "/api/desktop/library") return f.catalogBytes;
      if (route === "/api/desktop/library/report") {
        if (f.reportFails) throw Object.assign(new Error("unreachable"), { status: 503 });
        f.reports.push(structuredClone(options.body)); return Buffer.from('{"accepted":1,"ignored":0}');
      }
      const sha = /^\/api\/desktop\/library\/blobs\/([a-f0-9]{64})$/.exec(route)?.[1];
      if (f.blobStatus) throw Object.assign(new Error("refused"), { status: f.blobStatus, retryAfter: 120 });
      if (!sha || !f.blobs.has(sha)) throw Object.assign(new Error("Not found."), { status: 404 });
      return f.blobs.get(sha);
    },
  });
  t.after(() => f.library.close());
  f.sync = async (pointer = { version: 1, digest: f.digest() }, extra = {}) => {
    await f.library.synchronized({ identity: identity(), capable: true, pointer, generation: 7, ...extra });
    await f.library.idle();
  };
  f.advance = async ms => {
    f.clock += ms;
    for (const timer of f.timers.filter(item => item.at <= f.clock)) { f.timers = f.timers.filter(item => item !== timer); timer.callback(); }
    await flush(); await f.library.idle();
  };
  f.blobFile = bytes => path.join(dataDir, "blobs", `${sha256Hex(bytes)}.json`);
  f.fetched = prefix => f.requests.filter(request => request.route.startsWith(prefix));
  return f;
}

test("the catalog parser ignores unknown fields, drops a bad entry, and keeps Off and newer-format entries listed", () => {
  const extra = { ...entry(TEAM), future: { anything: true }, release: { ...release(teamBytes), mirror: "https://elsewhere.invalid" } };
  const parsed = parseOrgLibraryCatalog(catalogOf([extra, { ...entry(SKILLS), mode: "pinned" }, entry(OFF, { mode: "off" }), entry(NEWER, { release: release(teamBytes, { formatVersion: 3 }) })], { truncated: true, surprise: 1 }));
  assert.deepEqual(parsed.packages.map(item => item.packageId), [TEAM, OFF, NEWER]);
  assert.equal(parsed.truncated, true);
  assert.equal("surprise" in parsed, false);
  assert.equal("future" in parsed.packages[0], false);
  assert.equal("mirror" in parsed.packages[0].release, false);
  assert.equal(parsed.packages[0].release.notes, "First release.\nAdds the deal desk.", "release notes keep their newlines");
  assert.equal(parsed.packages[2].release.formatVersion, 3);
  // Text, bytes and the object all parse the same.
  assert.deepEqual(parseOrgLibraryCatalog(bytesOf(standard())), parseOrgLibraryCatalog(JSON.stringify(standard())));
  assert.deepEqual(parseOrgLibraryCatalog(bytesOf(standard())), parseOrgLibraryCatalog(standard()));
  assert.equal(parseOrgLibraryCatalog(catalogOf([entry(TEAM, { release: null })])).packages[0].release, null, "every release withdrawn");
});

test("an entry with a control character, a non-string disguised as one or a bad count is dropped alone", () => {
  const bad = [
    entry(TEAM, { name: "Sales\u0007desk" }), entry(TEAM, { packageId: [TEAM] }), entry(TEAM, { tagline: "" }),
    entry(TEAM, { release: release(teamBytes, { notes: "tab\there" }) }), entry(TEAM, { release: release(teamBytes, { sizeBytes: 4 * 1024 * 1024 + 1 }) }),
    entry(TEAM, { release: release(teamBytes, { sha256: "A".repeat(64) }) }), entry(TEAM, { contents: { ...entry(TEAM).contents, bots: -1 } }),
    entry(TEAM, { withdrawnReleases: [{ version: "1.0", sha256: "a".repeat(64) }] }), entry(TEAM, { publisher: { organizationId: PUBLISHER, name: "Acme", self: "no" } }),
    entry(TEAM, { ref: "Acme/Sales" }), entry(TEAM, { contents: { ...entry(TEAM).contents, botNames: Array(13).fill("Bot") } }),
  ];
  for (const item of bad) assert.deepEqual(parseOrgLibraryCatalog(catalogOf([item, entry(SKILLS)])).packages.map(row => row.packageId), [SKILLS], JSON.stringify(item).slice(0, 120));
  // A repeated package keeps its first entry.
  assert.equal(parseOrgLibraryCatalog(catalogOf([entry(TEAM), entry(TEAM, { name: "Second" })])).packages.length, 1);
});

test("a malformed envelope or another organization's catalog is refused whole", () => {
  for (const value of [null, "{", Buffer.from([0xff, 0xfe]), [], catalogOf([], { format: "openmaus.library" }), catalogOf([], { version: 2 }), catalogOf([], { libraryVersion: -1 }),
    catalogOf([], { organization: { id: ORG, name: "" } }), catalogOf([], { organization: { id: "not-a-uuid", name: "Beta" } }), catalogOf({}),
    catalogOf(Array.from({ length: 101 }, () => entry(TEAM)))]) assert.equal(parseOrgLibraryCatalog(value), null);
  assert.equal(parseOrgLibraryCatalog(standard(), { organizationId: PUBLISHER }), null, "a foreign organization's catalog");
  assert.equal(parseOrgLibraryCatalog(catalogOf(Array.from({ length: 100 }, () => entry(TEAM)))).packages.length, 1, "100 entries is the envelope's limit");
});

test("capability, pointer, report entries and the runtime's state message parse strictly", () => {
  assert.equal(libraryCapability({ capabilities: { library: 1 } }), true);
  for (const config of [{}, { capabilities: {} }, { capabilities: { library: true } }, { capabilities: { library: 0 } }, { capabilities: { library: "1" } }, null]) assert.equal(libraryCapability(config), false);
  assert.deepEqual(parseLibraryPointer({ version: 3, digest: "a".repeat(64), extra: 1 }), { version: 3, digest: "a".repeat(64) });
  for (const pointer of [undefined, null, { version: -1, digest: "a".repeat(64) }, { version: 1, digest: "A".repeat(64) }, { version: 1.5, digest: "a".repeat(64) }]) assert.equal(parseLibraryPointer(pointer), null);
  const good = { packageId: TEAM, release: "1.3.0", sha256: "b".repeat(64), state: "installed", secret: "never forwarded" };
  const entries = parseLibraryReportEntries([good, { ...good, packageId: SKILLS, state: "exploded" }, { ...good, packageId: OFF, reason: "Disk full at /Users/me" },
    { ...good, packageId: NEWER, state: "failed", reason: "import_failed", edited: false }, { ...good }]);
  assert.deepEqual(entries, [{ packageId: TEAM, release: "1.3.0", sha256: "b".repeat(64), state: "installed" },
    { packageId: NEWER, release: "1.3.0", sha256: "b".repeat(64), state: "failed", edited: false, reason: "import_failed" }], "free text never leaves the desktop");
  assert.equal(parseLibraryReportEntries(Array.from({ length: 150 }, (_, index) => ({ ...good, packageId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000` }))).length, 100);
  assert.equal(parseLibraryStateMessage({ type: "openmausbot:managed-desktop-result" }), undefined, "another channel's message");
  assert.equal(parseLibraryStateMessage({ type: "openmausbot:managed-library-state", digest: "nope", packages: [] }), null);
  assert.deepEqual(parseLibraryStateMessage({ data: { type: "openmausbot:managed-library-state", digest: "c".repeat(64), packages: [good] } }).packages.length, 1);
});

test("only the fixed library routes exist, each with its own cap", () => {
  assert.deepEqual(libraryRouteLimits("/api/desktop/library"), { method: "GET", maxBytes: 256 * 1024, timeoutMs: 20_000 });
  assert.deepEqual(libraryRouteLimits(`/api/desktop/library/blobs/${"a".repeat(64)}`), { method: "GET", maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000 });
  assert.equal(libraryRouteLimits("/api/desktop/library/report").bodyMaxBytes, 64 * 1024);
  for (const route of ["/api/desktop/library/", "/api/desktop/library/blobs/../session", `/api/desktop/library/blobs/${"A".repeat(64)}`, "/api/desktop/session",
    "/api/desktop/library?x=1", `/api/desktop/library/blobs/${"a".repeat(63)}`, "https://elsewhere.invalid/api/desktop/library"]) assert.equal(libraryRouteLimits(route), null, route);
});

test("a moved pointer fetches the catalog and its release bytes, verifies and saves them owner-only, then relays", async t => {
  const f = await fixture(t);
  await f.sync();
  assert.deepEqual(f.requests.map(request => request.route), ["/api/desktop/library", `/api/desktop/library/blobs/${sha256Hex(teamBytes)}`, `/api/desktop/library/blobs/${sha256Hex(skillBytes)}`],
    "the Off entry and the version 3 entry are never fetched");
  assert.equal(f.requests[0].maxBytes, 256 * 1024);
  assert.equal(f.requests[1].maxBytes, teamBytes.byteLength, "no more than the catalog's size for that release");
  assert.ok(f.requests.every(request => request.options.generation === 7));
  assert.deepEqual(await fs.readFile(f.blobFile(teamBytes)), teamBytes);
  assert.equal(await mode(f.blobFile(teamBytes)), 0o600);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "catalog.json")), f.catalogBytes, "the exact catalog bytes");
  assert.equal(await mode(path.join(f.dataDir, "catalog.json")), 0o600);
  assert.deepEqual(f.record.value, { portalOrigin: origin, organizationId: ORG, deviceId: DEVICE, libraryVersion: 1, digest: f.digest() });
  assert.equal(f.relayed.length, 1);
  const { catalog, ...library } = f.relayed[0];
  assert.deepEqual(library, { adminOrigin: origin, organizationId: ORG, organizationName: "Beta Clinic", digest: f.digest() });
  assert.deepEqual(catalog, parseOrgLibraryCatalog(f.catalogBytes));
  assert.equal(JSON.stringify(f.relayed).includes("omd_"), false, "no device token reaches the runtime");
  // Same pointer: nothing to fetch, nothing to relay again.
  f.requests.length = 0;
  await f.sync();
  assert.deepEqual(f.requests, []);
  assert.equal(f.relayed.length, 1);
});

test("release bytes that do not match the catalog are never written and are retried later", async t => {
  const f = await fixture(t);
  f.blobs.set(sha256Hex(teamBytes), Buffer.concat([teamBytes, Buffer.from(" ")]));
  await f.sync();
  assert.equal(await exists(f.blobFile(teamBytes)), false, "a sha256 mismatch is not written");
  assert.equal(await exists(f.blobFile(skillBytes)), true, "the other release is unaffected");
  assert.equal(f.relayed.length, 1, "the catalog still reaches the runtime; that entry shows as unavailable");
  f.requests.length = 0;
  await f.sync();
  assert.deepEqual(f.fetched("/api/desktop/library/blobs"), [], "not before its retry time");
  f.blobs.set(sha256Hex(teamBytes), teamBytes);
  f.clock += 60_000;
  await f.sync();
  assert.equal(f.fetched("/api/desktop/library/blobs").length, 1);
  assert.deepEqual(await fs.readFile(f.blobFile(teamBytes)), teamBytes);
  // A cached file that no longer matches is replaced after the next new catalog.
  await fs.writeFile(f.blobFile(teamBytes), Buffer.alloc(teamBytes.byteLength, 32));
  const digest = f.setCatalog(standard({ libraryVersion: 2 }));
  await f.sync({ version: 2, digest });
  assert.deepEqual(await fs.readFile(f.blobFile(teamBytes)), teamBytes);
});

test("a download refusal pauses downloads for its retry-after, and other failures back off", async t => {
  const f = await fixture(t);
  f.blobStatus = 429;
  await f.sync();
  assert.equal(f.fetched("/api/desktop/library/blobs").length, 1, "one refusal stops the rest of this pass");
  f.blobStatus = null; f.requests.length = 0; f.clock += 60_000;
  await f.sync();
  assert.equal(f.fetched("/api/desktop/library/blobs").length, 0, "still within retry-after");
  f.clock += 61_000;
  await f.sync();
  assert.equal(f.fetched("/api/desktop/library/blobs").length, 2);
});

test("the digest of the applied bytes wins over the pointer's, so a raced rebuild converges", async t => {
  const f = await fixture(t);
  await f.sync({ version: 1, digest: "d".repeat(64) });
  assert.equal(f.relayed.at(-1).digest, f.digest());
  assert.equal(f.record.value.digest, f.digest());
  f.requests.length = 0;
  await f.sync();
  assert.deepEqual(f.fetched("/api/desktop/library"), [], "the next pointer names what was applied");
});

test("another organization's or a malformed catalog keeps the last good one, and is retried with a growing delay", async t => {
  const f = await fixture(t);
  await f.sync();
  const good = { record: structuredClone(f.record.value), file: await fs.readFile(path.join(f.dataDir, "catalog.json")) };
  for (const bad of [catalogOf([entry(TEAM)], { organization: { id: PUBLISHER, name: "Acme Partners" }, libraryVersion: 2 }), { format: "openmaus.org-library", version: 1 }]) {
    const digest = f.setCatalog(bad);
    f.requests.length = 0;
    await f.sync({ version: 2, digest });
    assert.equal(f.fetched("/api/desktop/library").length, 1);
    assert.equal(f.relayed.length, 1, "nothing new is relayed");
    assert.deepEqual(f.record.value, good.record);
    assert.deepEqual(await fs.readFile(path.join(f.dataDir, "catalog.json")), good.file);
    await f.sync({ version: 2, digest });
    assert.equal(f.fetched("/api/desktop/library").length, 1, "not again on the very next check");
    f.clock += 50_000;
    await f.sync({ version: 2, digest });
    assert.equal(f.fetched("/api/desktop/library").length, 2);
  }
});

test("restore relays the saved catalog before any request, only for the same enrollment and untouched bytes", async t => {
  const first = await fixture(t);
  await first.sync();
  const saved = structuredClone(first.record.value), catalogFile = path.join(first.dataDir, "catalog.json"), bytes = await fs.readFile(catalogFile);
  const restart = async (options = {}) => {
    const f = await fixture(t);
    await fs.mkdir(f.dataDir, { recursive: true });
    await fs.writeFile(path.join(f.dataDir, "catalog.json"), options.bytes ?? bytes);
    f.record.value = { ...saved, ...options.record };
    await f.library.restore(options.identity ?? identity());
    await f.library.idle();
    return f;
  };
  const restored = await restart();
  assert.deepEqual(restored.requests, [], "no network call");
  assert.equal(restored.relayed.length, 1);
  assert.equal(restored.relayed[0].digest, saved.digest);
  // Tampered bytes (one digit of the organization name), another device, another organization, an expired sign-in.
  const tampered = Buffer.from(bytes.toString("utf8").replace("Beta Clinic", "Beta Clinix"));
  for (const options of [{ bytes: tampered }, { identity: identity({ deviceId: "99999999-9999-4999-8999-999999999999" }) }, { record: { organizationId: PUBLISHER } },
    { identity: identity({ expiresAt: Date.now() - 1 }) }, { record: { portalOrigin: "https://other.example.test" } }]) {
    const f = await restart(options);
    assert.deepEqual(f.relayed, [], JSON.stringify(Object.keys(options)));
  }
  // A restored catalog with the same pointer is not fetched again; a missing blob is.
  await fs.rm(path.join(restored.dataDir, "blobs"), { recursive: true, force: true });
  await restored.sync({ version: 1, digest: saved.digest });
  assert.deepEqual(restored.fetched("/api/desktop/library/").length, 2);
  assert.deepEqual(restored.fetched("/api/desktop/library").filter(request => request.route === "/api/desktop/library"), []);
});

test("sign-out, expiry or revocation hides the shelf and forgets the catalog, its record and cached bytes, never the installed copies", async t => {
  const f = await fixture(t);
  await f.sync();
  const runtimeState = path.join(f.dataDir, "state.json"), foreign = path.join(f.dataDir, "blobs", "notes.txt");
  await fs.writeFile(runtimeState, '{"version":1}');
  await fs.writeFile(foreign, "not ours");
  await f.library.clear();
  await f.library.idle();
  assert.equal(f.relayed.at(-1), null, "library: null");
  assert.equal(f.record.value, null);
  assert.equal(await exists(path.join(f.dataDir, "catalog.json")), false);
  assert.equal(await exists(f.blobFile(teamBytes)), false);
  assert.equal(await exists(runtimeState), true, "the runtime's own record of what it installed stays");
  assert.equal(await exists(foreign), true, "only files this channel wrote are removed");
  // A sync after sign-out starts again from nothing.
  f.requests.length = 0;
  await f.sync();
  assert.equal(f.requests.filter(request => request.route === "/api/desktop/library").length, 1);
});

test("a sign-out during a catalog or release download, or while its record is saved, leaves nothing the runtime could be sent again", async t => {
  const newerBytes = Buffer.from('{"format":"a newer release, never parsed by main"}');
  for (const { name, route, before } of [
    { name: "the first catalog download", route: "/api/desktop/library" },
    { name: "a release download for the first catalog", route: `/api/desktop/library/blobs/${sha256Hex(teamBytes)}` },
    { name: "saving the first catalog's record", route: "record" },
    { name: "a release download for a newer catalog", route: `/api/desktop/library/blobs/${sha256Hex(newerBytes)}`, before: async f => {
      await f.sync();
      f.blobs.set(sha256Hex(newerBytes), newerBytes);
      return { version: 2, digest: f.setCatalog(catalogOf([entry(TEAM, { release: release(newerBytes, { version: "1.4.0" }) })], { libraryVersion: 2 })) };
    } },
  ]) {
    const f = await fixture(t);
    const pointer = before ? await before(f) : { version: 1, digest: f.digest() };
    const held = f.holdNext(route);
    const syncing = f.library.synchronized({ identity: identity(), capable: true, pointer, generation: 7 });
    await held.reached;
    const relayedBefore = f.relayed.length, writesBefore = f.record.writes.length - (route === "record" ? 1 : 0);
    // Signed out while that download or save is in flight; it completes afterwards, then the runtime restarts.
    const cleared = f.library.clear();
    held.release();
    await Promise.all([syncing, cleared]); await f.library.idle();
    await f.library.runtimeReady(); await f.library.idle();
    assert.deepEqual(f.relayed.slice(relayedBefore).filter(library => library !== null), [], `${name}: no catalog reaches the runtime after sign-out`);
    assert.equal(f.record.writes.at(-1), null, `${name}: the last word on the record is the sign-out's`);
    if (route !== "record") assert.deepEqual(f.record.writes.slice(writesBefore), [null], `${name}: the record is only cleared, never saved again`);
    assert.equal(f.record.value, null);
    assert.equal(await exists(path.join(f.dataDir, "catalog.json")), false, name);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, "blobs")).catch(() => []), [], `${name}: no release file stays`);
  }
});

test("an Admin that never advertised the library sees no request; one that stops advertising it hides the shelf", async t => {
  const f = await fixture(t);
  await f.library.synchronized({ identity: identity(), capable: false, pointer: null, generation: 1 });
  await f.library.synchronized({ identity: identity(), capable: null, pointer: null, generation: 1 });
  await f.library.idle();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.relayed, []);
  assert.equal(await exists(f.dataDir), false, "nothing is written either");
  await f.sync();
  assert.equal(f.relayed.length, 1);
  await f.library.synchronized({ identity: identity(), capable: false, pointer: null, generation: 1 });
  await f.library.idle();
  assert.equal(f.relayed.at(-1), null);
  assert.equal(f.record.value, null);
});

test("a malformed pointer is ignored: the last catalog stays and nothing is fetched", async t => {
  const f = await fixture(t);
  await f.sync();
  f.requests.length = 0;
  await f.sync({ version: "2", digest: "e".repeat(64) });
  assert.deepEqual(f.fetched("/api/desktop/library"), []);
  assert.equal(f.relayed.length, 1);
});

test("a restarted runtime gets the catalog again; one that did not acknowledge it is retried on the next check", async t => {
  const f = await fixture(t, { relayOk: false });
  const refusals = () => f.logs.filter(line => line.includes("did not take the catalog")).length;
  await f.sync();
  assert.equal(f.relayed.length, 1);
  f.requests.length = 0;
  await f.sync();
  assert.equal(f.relayed.length, 2, "tried again on the next check");
  assert.equal(refusals(), 1, "logged once for this runtime and catalog, not on every check");
  f.relayOk = true;
  await f.sync();
  assert.equal(f.relayed.length, 3);
  assert.deepEqual(f.fetched("/api/desktop/library"), [], "a relay retry needs no new download");
  await f.sync();
  assert.equal(f.relayed.length, 3);
  await f.library.runtimeReady();
  await f.library.idle();
  assert.equal(f.relayed.length, 4);
  assert.equal(f.relayed[3].digest, f.digest());
  // A restarted runtime that refuses too is logged again, once.
  f.relayOk = false;
  await f.library.runtimeReady(); await f.library.idle();
  await f.sync();
  assert.equal(refusals(), 2);
});

test("install reports: 5 s debounce, only the newest snapshot, once per start, and retried on the next check after a failure", async t => {
  const f = await fixture(t);
  await f.sync();
  const state = packages => ({ type: "openmausbot:managed-library-state", digest: f.digest(), packages });
  const installed = (state = "installed", extra = {}) => ({ packageId: TEAM, release: "1.3.0", sha256: sha256Hex(teamBytes), state, ...extra });
  assert.equal(f.library.receive(state([installed("failed", { reason: "import_failed" })])), true);
  assert.equal(f.library.receive(state([installed()])), true);
  await f.advance(4_999);
  assert.deepEqual(f.reports, [], "debounced");
  await f.advance(1);
  assert.deepEqual(f.reports, [{ libraryVersion: 1, digest: f.digest(), appVersion: "0.1.90", packages: [installed()] }], "one post, the newest snapshot");
  // Not again on a regular check: the start report has been sent.
  await f.sync(); await f.advance(10_000);
  assert.equal(f.reports.length, 1);
  // A failed post is retried on the next check (not by time alone), still with only the newest snapshot.
  f.reportFails = true;
  f.library.receive(state([installed("removed", { reason: "removed_locally" })]));
  await f.advance(5_000);
  f.library.receive(state([installed("withdrawn", { reason: "withdrawn_by_publisher" })]));
  await f.advance(5_000);
  assert.equal(f.reports.length, 1);
  f.reportFails = false;
  await f.advance(60_000);
  assert.equal(f.reports.length, 1, "no new snapshot and no check yet");
  await f.sync(); await f.advance(5_000);
  assert.equal(f.reports.length, 2);
  assert.equal(f.reports[1].packages[0].state, "withdrawn");
  await f.sync(); await f.advance(5_000);
  assert.equal(f.reports.length, 2, "delivered: nothing is repeated");
});

test("the first report of an app start waits for a session sync, then goes once", async t => {
  const first = await fixture(t);
  await first.sync();
  const f = await fixture(t);
  await fs.mkdir(f.dataDir, { recursive: true });
  await fs.writeFile(path.join(f.dataDir, "catalog.json"), first.catalogBytes);
  f.record.value = structuredClone(first.record.value);
  await f.library.restore(identity()); await f.library.idle();
  f.library.receive({ type: "openmausbot:managed-library-state", digest: first.digest(), packages: [] });
  await f.advance(5_000);
  assert.deepEqual(f.reports, [], "no report before a successful session sync");
  await f.sync(); await f.advance(5_000);
  assert.deepEqual(f.reports, [{ libraryVersion: 1, digest: first.digest(), appVersion: "0.1.90", packages: [] }]);
});

test("a snapshot for a catalog this desktop did not relay, or a malformed one, is never reported", async t => {
  const f = await fixture(t);
  await f.sync();
  assert.equal(f.library.receive({ type: "openmausbot:managed-library-state", digest: "f".repeat(64), packages: [] }), true);
  assert.equal(f.library.receive({ type: "openmausbot:managed-library-state", digest: f.digest(), packages: "all" }), true);
  assert.equal(f.library.receive({ type: "openmausbot:managed-desktop-result", requestId: "x", ok: true }), false, "left for the relay");
  await f.advance(5_000);
  assert.deepEqual(f.reports, []);
  await f.library.clear(); await f.library.idle();
  f.library.receive({ type: "openmausbot:managed-library-state", digest: f.digest(), packages: [] });
  await f.advance(5_000);
  assert.deepEqual(f.reports, [], "never after sign-out");
});

test("cached release bytes the catalog stopped naming are removed 7 days later", async t => {
  const f = await fixture(t);
  await f.sync();
  const digest = f.setCatalog(catalogOf([entry(SKILLS, { ref: "acme/refund-skills", kind: "library", release: release(skillBytes) })], { libraryVersion: 2 }));
  await f.sync({ version: 2, digest });
  assert.equal(await exists(f.blobFile(teamBytes)), true, "kept for now");
  f.clock += 7 * 86400_000 + 60_000;
  await f.sync({ version: 2, digest });
  assert.equal(await exists(f.blobFile(teamBytes)), false);
  assert.equal(await exists(f.blobFile(skillBytes)), true, "the one still named stays");
});

// ── With the real managed-desktop client ───────────────────────────────

function desktop(t, { capability = 1, pointer = true, catalog = standard(), sessionExtra = {}, configFails = 0 } = {}) {
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); } catch (error) { if (error?.code !== "ERR_INVALID_STATE") throw error; }
  const token = `omd_${"a".repeat(43)}`, modelToken = `omg_${"c".repeat(43)}`;
  const saved = { portalOrigin: origin, token, deviceId: DEVICE, organizationId: ORG, email: "person@example.test", expiresAt: Date.now() + 86400_000 };
  const f = { clock: Date.now(), order: [], requests: [], messages: [], catalogBytes: bytesOf(catalog), blobs: new Map([[sha256Hex(teamBytes), teamBytes], [sha256Hex(skillBytes), skillBytes]]), record: { value: saved }, revoked: false };
  const relay = createManagedDesktopRelay({ timeoutMs: 15_000 });
  // The fake runtime: acknowledges at once, as server/org-library.ts must, and records the message.
  const proc = { postMessage: message => { f.messages.push(message); f.order.push(`relay ${message.library ? "catalog" : "null"}`); queueMicrotask(() => relay.receive(proc, { type: "openmausbot:managed-desktop-result", requestId: message.requestId, ok: true })); } };
  f.fetch = async (url, options) => {
    const route = url.slice(origin.length);
    f.requests.push({ route, options }); f.order.push(route);
    if (route === "/api/public/config" && configFails-- > 0) throw new TypeError("fetch failed");
    if (route === "/api/public/config") return Response.json({ desktopContractVersion: 1, capabilities: { desktopEnrollment: true, deviceRenewal: 1, ...(capability === null ? {} : { library: capability }) } });
    if (route === "/api/desktop/session/renew") return Response.json({ error: "Not found." }, { status: 404 });
    if (route === "/api/desktop/session" && options.method === "DELETE") return Response.json({ ok: true });
    if (route === "/api/desktop/session") {
      if (f.revoked) return Response.json({ error: "This device needs to reconnect to its organization." }, { status: 401 });
      return Response.json({ desktopContractVersion: 1, modelAccessToken: modelToken, device: { id: DEVICE, organizationId: ORG, email: saved.email, revokedAt: null, expiresAt: saved.expiresAt },
        organization: { id: ORG, name: "Beta Clinic" }, providers: [], cloudBackups: false, ...(pointer ? { library: { version: 1, digest: sha256Hex(f.catalogBytes) } } : {}), ...sessionExtra });
    }
    if (route === "/api/desktop/library") return new Response(f.catalogBytes, { headers: { "content-type": "application/json" } });
    if (route === "/api/desktop/library/report") { f.reports = [...(f.reports ?? []), JSON.parse(options.body)]; return Response.json({ accepted: 1, ignored: 0 }); }
    const sha = /^\/api\/desktop\/library\/blobs\/([a-f0-9]{64})$/.exec(route)?.[1];
    if (sha && f.blobs.has(sha)) return new Response(f.blobs.get(sha), { headers: { "x-openmaus-sha256": sha } });
    if (sha) return Response.json({ error: "Not found." }, { status: 404 });
    throw new Error(`Unexpected fixture route ${route}`);
  };
  return f.setup = (async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "omb-org-library-client-"));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    f.dataDir = path.join(home, "org-library");
    const libraryRecord = { value: null };
    f.libraryRecord = libraryRecord;
    let client;
    f.library = createOrgLibrary({ dataDir: f.dataDir, appVersion: "0.1.90",
      store: { read: async () => libraryRecord.value, write: async value => { libraryRecord.value = value === null ? null : structuredClone(value); } },
      fetchBytes: (route, maxBytes, options) => client.fetchLibraryBytes(route, maxBytes, options), relay: library => relay.sendLibrary(proc, library) });
    client = createManagedDesktopClient({ platform: "linux", deviceName: "Fixture laptop", appVersion: "0.1.90", fetch: f.fetch, library: f.library, now: () => f.clock,
      store: { read: async () => f.record.value, write: async value => { f.record.value = value === null ? null : structuredClone(value); } },
      applyConnection: async () => {}, openBrowser: async () => {} });
    t.after(() => { client.close(); f.library.close(); });
    f.client = client;
    f.settle = async () => { await flush(); await f.library.idle(); await flush(); };
    return f;
  })();
}

test("end to end with the managed-desktop client: capability, pointer, catalog, blobs, relay and a report", async t => {
  const f = await desktop(t);
  await f.client.start(); await f.settle();
  assert.equal(f.client.state().status, "connected");
  const library = f.requests.filter(request => request.route.startsWith("/api/desktop/library"));
  assert.deepEqual(library.map(request => request.route), ["/api/desktop/library", `/api/desktop/library/blobs/${sha256Hex(teamBytes)}`, `/api/desktop/library/blobs/${sha256Hex(skillBytes)}`]);
  for (const { options } of library) {
    assert.equal(options.headers.authorization, `Bearer omd_${"a".repeat(43)}`, "the device token, never the model token");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
  }
  const sent = f.messages.filter(message => message.type === "openmausbot:managed-library");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].library.digest, sha256Hex(f.catalogBytes));
  assert.equal(sent[0].library.catalog.packages.length, 4);
  // The runtime's snapshot becomes one report, 5 s later.
  f.library.receive({ type: "openmausbot:managed-library-state", digest: sent[0].library.digest, packages: [{ packageId: TEAM, release: "1.3.0", sha256: sha256Hex(teamBytes), state: "installed" }] });
  t.mock.timers.tick(5_000); await f.settle();
  assert.deepEqual(f.reports, [{ libraryVersion: 1, digest: sent[0].library.digest, appVersion: "0.1.90", packages: [{ packageId: TEAM, release: "1.3.0", sha256: sha256Hex(teamBytes), state: "installed" }] }]);
  const report = f.requests.find(request => request.route === "/api/desktop/library/report");
  assert.equal(report.options.method, "POST");
  assert.equal(report.options.headers["content-type"], "application/json");
  // Revocation: the runtime is told library: null and the saved catalog goes.
  f.revoked = true;
  await f.client.refresh(); await f.settle();
  assert.equal(f.client.state().status, "reauth-required");
  assert.equal(f.messages.filter(message => message.type === "openmausbot:managed-library").at(-1).library, null);
  assert.equal(f.libraryRecord.value, null);
  assert.equal(await exists(path.join(f.dataDir, "catalog.json")), false);
});

test("at start the saved catalog reaches the runtime before any request to Admin", async t => {
  const first = await desktop(t);
  await first.client.start(); await first.settle();
  const f = await desktop(t);
  await fs.mkdir(f.dataDir, { recursive: true });
  await fs.writeFile(path.join(f.dataDir, "catalog.json"), await fs.readFile(path.join(first.dataDir, "catalog.json")));
  f.libraryRecord.value = structuredClone(first.libraryRecord.value);
  await f.client.start(); await f.settle();
  assert.equal(f.order[0], "relay catalog");
  assert.equal(f.requests.filter(request => request.route === "/api/desktop/library").length, 0, "the same pointer: nothing to fetch");
});

test("a desktop that could not read the config at start learns the capability later, asking at most every 10 minutes", async t => {
  const f = await desktop(t, { configFails: 2 });
  await f.client.start(); await f.settle();
  assert.equal(f.client.state().status, "connected");
  assert.equal(f.requests.filter(request => request.route === "/api/public/config").length, 2, "renew's read, then one retry");
  assert.deepEqual(f.requests.filter(request => request.route.startsWith("/api/desktop/library")), []);
  f.clock += 60_000; t.mock.timers.tick(60_000); await f.settle();
  assert.equal(f.requests.filter(request => request.route === "/api/public/config").length, 2);
  f.clock += 10 * 60_000; t.mock.timers.tick(60_000); await f.settle();
  assert.equal(f.requests.filter(request => request.route === "/api/public/config").length, 3);
  assert.equal(f.requests.filter(request => request.route === "/api/desktop/library").length, 1);
  assert.equal(f.messages.filter(message => message.type === "openmausbot:managed-library").length, 1);
});

test("an Admin without the library capability never sees a library request, even with a pointer on the session", async t => {
  const f = await desktop(t, { capability: null });
  await f.client.start(); await f.settle();
  await f.client.refresh(); await f.settle();
  assert.equal(f.client.state().status, "connected");
  assert.deepEqual(f.requests.filter(request => request.route.startsWith("/api/desktop/library")), []);
  assert.equal(f.requests.filter(request => request.route === "/api/public/config").length, 1, "the config renew() reads once per start");
  assert.deepEqual(f.messages.filter(message => message.type === "openmausbot:managed-library"), []);
});

test("sign-out tells the runtime library: null; no account means no library activity", async t => {
  const f = await desktop(t);
  await f.client.start(); await f.settle();
  await f.client.disconnect(); await f.settle();
  assert.equal(f.messages.filter(message => message.type === "openmausbot:managed-library").at(-1).library, null);
  const none = await desktop(t);
  none.record.value = null;
  await none.client.start(); await none.settle();
  assert.equal(none.client.state().status, "signed-out");
  assert.deepEqual(none.requests, []);
  assert.deepEqual(none.messages, []);
});

test("fetchLibraryBytes: fixed routes, the current connection, and caps of 4 MiB per release, 256 KiB per catalog and 64 KiB per report", async t => {
  const f = await desktop(t, { pointer: false });
  await f.client.start(); await f.settle();
  for (const route of ["/api/desktop/session", "/api/desktop/backups", "/api/desktop/library/other", `/api/desktop/library/blobs/${"a".repeat(63)}`]) {
    await assert.rejects(f.client.fetchLibraryBytes(route, 1024), /Unsupported organization library operation/);
  }
  await assert.rejects(f.client.fetchLibraryBytes("/api/desktop/library", 1024, { generation: 999 }), /connection changed/);
  const exact = Buffer.alloc(4 * 1024 * 1024, 97), over = Buffer.alloc(4 * 1024 * 1024 + 1, 97);
  f.blobs.set(sha256Hex(exact), exact); f.blobs.set(sha256Hex(over), over);
  assert.equal((await f.client.fetchLibraryBytes(`/api/desktop/library/blobs/${sha256Hex(exact)}`, 4 * 1024 * 1024)).byteLength, exact.byteLength);
  await assert.rejects(f.client.fetchLibraryBytes(`/api/desktop/library/blobs/${sha256Hex(over)}`, 8 * 1024 * 1024), /too large/, "a caller cannot raise the cap");
  await assert.rejects(f.client.fetchLibraryBytes(`/api/desktop/library/blobs/${sha256Hex(exact)}`, 1024), /too large/, "a caller can lower it");
  f.catalogBytes = Buffer.alloc(256 * 1024 + 1, 32);
  await assert.rejects(f.client.fetchLibraryBytes("/api/desktop/library", 1024 * 1024), /too large/);
  await assert.rejects(f.client.fetchLibraryBytes("/api/desktop/library/report", 1024, { body: { pad: "x".repeat(64 * 1024) } }), /report is too large/);
  const missing = await f.client.fetchLibraryBytes(`/api/desktop/library/blobs/${"0".repeat(64)}`, 1024).catch(error => error);
  assert.equal(missing.status, 404);
  // The session keeps its own 512 KiB cap.
  const big = await desktop(t, { sessionExtra: { padding: "x".repeat(512 * 1024) } });
  await big.client.start(); await big.settle();
  assert.equal(big.client.state().status, "unavailable");
  await f.client.disconnect(); await f.settle();
  await assert.rejects(f.client.fetchLibraryBytes("/api/desktop/library", 1024), /Reconnect your organization/);
});
