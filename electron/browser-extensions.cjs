// Loads reviewed browser extensions into the sessions behind the built-in
// browser, and keeps every live session converged on what the person chose.
//
// The server owns the decision (server/browser-extensions.ts): what is
// installed, what a person reviewed, what is enabled. This module owns the
// act of loading, and it deliberately trusts none of that on faith. Before
// the first load of an (id, version) in this process it re-reads the tree and
// recomputes the hash the server recorded. Two independent checks on opposite
// sides of a process boundary is the point: a state file a person never
// reviewed, or bytes edited after they did, must not become running code
// inside pages that hold their live logins.
//
// Dependency-free on purpose. Electron main modules ship with no
// node_modules, so validation here is hand-rolled rather than zod.
//
// Three rules the rest of the file keeps:
//
//   Persistent sessions only. Electron throws "Extensions cannot be loaded
//   in a temporary session" on an in-memory partition, which is exactly what
//   a Guest profile is. Guest gets nothing, and that is a feature: a
//   throwaway session must not inherit a durable identity.
//
//   Never throw at a caller. A broken extension must not break browsing.
//   Every entry point returns a result and reports errors as text the
//   surface turns into page notices.
//
//   Paths come from validated ids and versions, never from the state file.
//   A tampered record can name a bad id; it cannot point the loader at an
//   arbitrary directory.
"use strict";

const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join, relative, sep } = require("node:path");

/** Mirrors server/browser-extension-crx.ts. Both walks must agree or every
 * hash check fails — and a cap that is tighter here than there is the
 * dangerous direction: the server would install a large extension happily,
 * and this side would refuse to hash it and quietly never load it. The
 * exported values let a test assert the two stay equal. */
const UNPACKED_MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
// `_metadata` is Chrome's reserved store-verification directory, which
// Chromium deletes from an unpacked extension on first load — so it must be
// outside the hash on both sides. See the server's SKIPPED_ENTRIES.
const SKIPPED_DIRECTORY_ENTRIES = new Set([".git", ".DS_Store", "node_modules", "_metadata"]);

const LOCAL_ID = /^local-[0-9a-f]{12}$/;
const STORE_ID = /^[a-p]{32}$/;
const VERSION = /^\d+(\.\d+){0,3}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** Only a persistent partition can hold an extension. */
const PERSISTENT = /^persist:/;

const MESSAGE_TYPE = "openmausbot:browser-extensions-changed";

function isValidId(value) {
  return typeof value === "string" && (LOCAL_ID.test(value) || STORE_ID.test(value));
}

/**
 * The tree hash, byte-identical to hashExtensionFiles in
 * server/browser-extension-crx.ts: sorted posix paths, and for each file
 * `${path}\0${sha256hex(bytes)}\n`.
 *
 * IMPORTANT: the server computes the same digest from the same rules. If one
 * side changes — the walk's skip list, the separator, the sort — the other
 * must change in the same commit, or every extension stops loading.
 *
 * @returns {string|null} null when the tree cannot be read under those rules
 */
function hashExtensionDir(root) {
  /** @type {Array<{path: string, inner: string}>} */
  const files = [];
  let total = 0;

  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return false;
    }
    for (const entry of entries.sort()) {
      if (SKIPPED_DIRECTORY_ENTRIES.has(entry)) continue;
      const absolute = join(directory, entry);
      let stats;
      try {
        stats = lstatSync(absolute);
      } catch {
        continue;
      }
      // Symlinks are skipped in both implementations; following one here
      // would hash bytes the reviewer never saw.
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (!walk(absolute)) return false;
        continue;
      }
      if (!stats.isFile()) continue;
      if (files.length >= MAX_ENTRIES) return false;
      total += stats.size;
      if (total > UNPACKED_MAX_BYTES) return false;
      let bytes;
      try {
        bytes = readFileSync(absolute);
      } catch {
        continue;
      }
      files.push({
        path: relative(root, absolute).split(sep).join("/"),
        inner: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return true;
  };

  try {
    if (!lstatSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!walk(root)) return null;
  if (!files.length) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.path}\0${file.inner}\n`);
  return digest.digest("hex");
}

/**
 * The extension loader and session converger.
 *
 * @param {object} options
 * @param {string} options.dataDir where the server wrote its state
 * @param {(message: string) => void} [options.log]
 * @param {(root: string) => string|null} [options.hashDir] test seam
 */
function createBrowserExtensionCoordinator({ dataDir, log, hashDir = hashExtensionDir }) {
  const note = log instanceof Function ? log : () => {};
  const statePath = join(dataDir, "browser-extensions.json");
  const rootDir = join(dataDir, "browser-extensions");

  /** Sessions we have ever loaded into, so syncAll can reach all of them. */
  const tracked = new Set();
  /** session -> { applied: Map<id, {version, contentSha256, runtimeId}>, revision, chain } */
  const state = new WeakMap();
  /** Integrity verdicts already reached this process, keyed by id, version
   * AND recorded hash. Including the hash matters: a store extension can be
   * removed and reinstalled at the same id and version, and keying on those
   * alone would serve a stale "verified" for different bytes. Failures are
   * cached too, so re-checking a broken tree costs nothing. */
  const integrity = new Map();

  /** The desired set, hand-validated. A malformed file yields nothing rather
   * than throwing: no extensions is a safe outcome, a crash is not. */
  const readDesired = () => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return [];
    if (!Array.isArray(parsed.extensions)) return [];
    const desired = [];
    const seen = new Set();
    for (const record of parsed.extensions) {
      if (!record || typeof record !== "object") continue;
      if (record.enabled !== true) continue;
      const { id, version, contentSha256 } = record;
      if (!isValidId(id) || seen.has(id)) continue;
      if (typeof version !== "string" || !VERSION.test(version)) continue;
      if (typeof contentSha256 !== "string" || !SHA256.test(contentSha256)) continue;
      seen.add(id);
      // Derived, never read from the record: a tampered path cannot redirect
      // the loader outside the managed directory.
      desired.push({ id, version, contentSha256, path: join(rootDir, id, version) });
      if (desired.length >= 64) break;
    }
    return desired;
  };

  /** A cheap token for "did the desired set move". */
  const revisionOf = (desired) => {
    const digest = createHash("sha256");
    for (const entry of desired) digest.update(`${entry.id}\0${entry.version}\0${entry.contentSha256}\n`);
    return digest.digest("hex").slice(0, 16);
  };

  /** Re-read and re-hash before the first load of an (id, version) this
   * process. Cached afterwards: the bytes cannot change under a running
   * Chromium without the version, and therefore the path, changing too. */
  const passesIntegrity = (entry) => {
    const key = `${entry.id}\0${entry.version}\0${entry.contentSha256}`;
    const cached = integrity.get(key);
    if (cached !== undefined) return cached;
    const actual = hashDir(entry.path);
    const ok = actual === entry.contentSha256;
    integrity.set(key, ok);
    if (!ok) {
      note(
        actual === null
          ? `browser extension ${entry.id} could not be read from ${entry.path}; skipping`
          : `browser extension ${entry.id} does not match the hash recorded at review; skipping`,
      );
    }
    return ok;
  };

  const stateFor = (ses) => {
    let existing = state.get(ses);
    if (!existing) {
      existing = { applied: new Map(), revision: null, chain: Promise.resolve(), partition: "" };
      state.set(ses, existing);
    }
    return existing;
  };

  const converge = async (ses, desired, revision) => {
    const current = stateFor(ses);
    const errors = [];
    const wanted = new Map(desired.map((entry) => [entry.id, entry]));

    // Remove first: anything the person no longer wants, and anything whose
    // bytes have moved, must be unloaded before its replacement loads, or
    // Chromium keeps serving the old one. The comparison is on the recorded
    // hash as well as the version — a republished build can carry the same
    // id and version as the one already loaded, and version alone would let
    // the stale copy keep running. Collected before removal so the map is
    // never mutated mid-iteration.
    const stale = [];
    for (const [id, applied] of current.applied) {
      const target = wanted.get(id);
      const moved = !target
        || target.version !== applied.version
        || target.contentSha256 !== applied.contentSha256;
      if (moved) stale.push([id, applied]);
    }
    for (const [id, applied] of stale) {
      try {
        ses.extensions.removeExtension(applied.runtimeId);
      } catch (error) {
        errors.push(`could not unload an extension: ${error?.message ?? error}`);
      }
      current.applied.delete(id);
    }

    for (const entry of desired) {
      if (current.applied.has(entry.id)) continue;
      if (!passesIntegrity(entry)) {
        errors.push("An installed extension changed after it was reviewed and was not loaded.");
        continue;
      }
      try {
        // allowFileAccess stays false: the built-in browser refuses file://
        // for pages, and an extension must not be the way around that.
        const loaded = await ses.extensions.loadExtension(entry.path, { allowFileAccess: false });
        current.applied.set(entry.id, {
          version: entry.version,
          contentSha256: entry.contentSha256,
          runtimeId: loaded.id,
        });
      } catch (error) {
        errors.push(`An installed extension could not be loaded: ${error?.message ?? error}`);
      }
    }

    // Only a clean pass earns the fast path. Recording the revision after a
    // failure would mean a transient loadExtension error is never retried:
    // every later ensureSession would short-circuit on the matching
    // revision, and the extension would stay unloaded until the person
    // changed something or restarted the app. Re-running is cheap — a
    // deterministic integrity failure answers from the cache above.
    current.revision = errors.length === 0 ? revision : null;
    return { loaded: current.applied.size, errors };
  };

  /**
   * Bring one session in line with the desired set.
   *
   * Serialized per session: two views on one named profile share a session,
   * and overlapping converges would double-load. Never throws.
   *
   * @returns {Promise<{loaded: number, errors: string[], skipped?: string}>}
   */
  const ensureSession = (ses, partition) => {
    if (!ses || !ses.extensions || typeof ses.extensions.loadExtension !== "function") {
      return Promise.resolve({ loaded: 0, errors: [], skipped: "unsupported" });
    }
    // A Guest partition is in-memory, and Electron throws there. Skipping is
    // the intended behaviour, not a failure worth reporting to the person.
    if (typeof partition !== "string" || !PERSISTENT.test(partition)) {
      return Promise.resolve({ loaded: 0, errors: [], skipped: "not-persistent" });
    }
    tracked.add(ses);
    const current = stateFor(ses);
    current.partition = partition;
    return queueConverge(ses, current);
  };

  /** The convergence itself, with the persistence check already made.
   * syncAll reaches this directly rather than re-deriving a partition. */
  const queueConverge = (ses, current) => {
    const run = current.chain.then(async () => {
      const desired = readDesired();
      const revision = revisionOf(desired);
      if (current.revision === revision) return { loaded: current.applied.size, errors: [] };
      try {
        return await converge(ses, desired, revision);
      } catch (error) {
        note(`browser extension convergence failed: ${error?.message ?? error}`);
        return { loaded: current.applied.size, errors: [`Extensions could not be updated: ${error?.message ?? error}`] };
      }
    });
    // The chain must never reject, or every later ensureSession inherits it.
    current.chain = run.then(() => {}, () => {});
    return run;
  };

  /** Re-converge every session we have loaded into. Called when the person
   * installs, enables, disables or removes something. A session is only in
   * `tracked` because it already passed the persistence check. */
  const syncAll = async () => {
    const sessions = [...tracked];
    const errors = [];
    for (const ses of sessions) {
      const result = await queueConverge(ses, stateFor(ses));
      errors.push(...result.errors);
    }
    return { sessions: sessions.length, errors };
  };

  /** Decode the server's private message. Accepts the bare message or the
   * port's `{ data }` wrapper, the same way the other desktop receivers do. */
  const handlePrivateMessage = (raw) => {
    const message = raw?.data ?? raw;
    if (message?.type !== MESSAGE_TYPE) return false;
    void syncAll();
    return true;
  };

  /** How many extensions are loaded in this session. The surface uses it to
   * tell the model that the page it is reading may have been changed by
   * something other than the site — without naming what, which would be both
   * a fingerprint and an instruction-injection surface. */
  const sessionLoadedCount = (ses) => {
    const current = state.get(ses);
    return current ? current.applied.size : 0;
  };

  /** Is this runtime id an extension we loaded into this session? The
   * request policy uses it to let an extension's own resources through
   * without opening `chrome-extension:` to anything else. */
  const sessionHasExtension = (ses, runtimeId) => {
    if (!runtimeId || !ses?.extensions?.getExtension) return false;
    try {
      return Boolean(ses.extensions.getExtension(runtimeId));
    } catch {
      return false;
    }
  };

  return {
    ensureSession,
    syncAll,
    handlePrivateMessage,
    sessionHasExtension,
    sessionLoadedCount,
  };
}

module.exports = {
  MAX_ENTRIES,
  MESSAGE_TYPE,
  UNPACKED_MAX_BYTES,
  createBrowserExtensionCoordinator,
  hashExtensionDir,
};
