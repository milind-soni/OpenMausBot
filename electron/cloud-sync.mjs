// Files, the desktop service: the folders the person shared go to My Cloud, and what Cloud bots make comes to
// Documents/MausBot. This computer decides what is shared (settings.shared); a folder My Cloud names is never synced
// unless this computer registered it. It drives every pass over the Cloud sign-in the window holds.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldKey, safeFolderName, skipped } from "./cloud-sync-rules.mjs";
import { SyncAuthError, createSyncClient } from "./cloud-sync-client.mjs";
import { CloudAsleepError, createCloudPowerGate } from "./cloud-power.mjs";
import { fetchOutputs, newReport, passStopper, shareFolder } from "./cloud-sync-engine.mjs";
import { openSyncState } from "./cloud-sync-state.mjs";
import { watchFolder } from "./cloud-sync-scan.mjs";
import { RECHECK_MS, copiedLent, folderKey as pathKey, lentReport, planLentCopies, reconcileLent, sameFolderOn } from "./lent-folders.mjs";
import { applyStaged } from "./lent-staged.mjs";
import { lentGit } from "./lent-git.mjs";

const FULL_PASS_MS = 5 * 60_000;
const LONG_POLL_MS = 60_000;
const BACKOFF_MS = [1_000, 3_000, 8_000, 15_000, 30_000];
const CHECK_FILES_MAX = 100_000, CHECK_MS = 3_000;
// Keys and settings: never shared, wherever they sit.
// Folders that hold keys or sign-ins, including the AI CLIs' own homes (their login files live there).
const PRIVATE = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".local", ".npm", "Library", "AppData", ".openmausbot", ".claude", ".codex", ".gemini", ".grok"];

const within = (child, parent, platform) => pathKey(child, platform) === pathKey(parent, platform) || pathKey(child, platform).startsWith(`${pathKey(parent, platform)}/`);

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version === 2) return value;
  } catch {}
  return { version: 2, shared: [], outputs: null };
}

function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** A My Cloud from before lent folders' copies answers their calls 404 (no route): lending still works there, live only. */
const older = (error) => error?.status === 404;
/** A lent folder's bookkeeping that failed is this pass's note, never what stops Files. */
const noted = (what) => (error) => {
  if (passStopper(error)) throw error;
  if (!older(error)) console.error(`[files] ${what}: ${error?.message ?? error}`);
};
const KEPT_MAX = 5;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function createCloudFilesService({
  settingsFile, stateFile, documentsDir, localDataDir, homeDir = os.homedir(), platform = process.platform, hostname = os.hostname(),
  cloudOrigin, fetch: fetchImpl, trashItem, markDownloaded, openDashboard = async () => {},
  createClient = createSyncClient, watch = watchFolder, freeBytes, now = Date.now, onChange = () => {}, power = createCloudPowerGate(),
  lending = null, planDisk = () => null,
}) {
  let settings = readSettings(settingsFile);
  const state = openSyncState(stateFile);
  const outputsDir = path.join(documentsDir, "MausBot");
  let closed = false, interval = null, poller = null, cursor = 0, chain = Promise.resolve(), pending = null;
  let status = { phase: "unavailable", lastSyncedAt: null, disk: null, shared: [], outputs: { enabled: true, dir: outputsDir, folders: 0, problem: null } };
  const results = new Map();
  const watchers = new Map();
  /** Lent folders without a copy, as last counted: { at, path, check }. */
  const lentChecks = new Map();

  const save = (next) => { settings = next; writeSettings(settingsFile, next); };
  if (!settings.computerId || !settings.outputs) save({ ...settings, computerId: settings.computerId ?? randomUUID(), outputs: settings.outputs ?? { enabled: true, since: now() } });
  const view = () => ({
    ...status,
    shared: settings.shared.map((folder) => ({ id: folder.id ?? folder.key, name: folder.name, pcPath: folder.pcPath, lent: Boolean(folder.lentId), kept: folder.kept ?? [],
      ...(results.get(folder.key) ?? { status: "copying", files: 0, done: 0, waitingBytes: 0, pendingDeletes: 0, problem: null }) })),
    outputs: { ...status.outputs, enabled: settings.outputs.enabled === true, dir: outputsDir },
  });
  const publish = (next) => { status = { ...status, ...next }; onChange(view()); };
  const client = () => {
    const origin = cloudOrigin();
    return origin ? createClient({ origin, fetch: fetchImpl, power }) : null;
  };
  const sharedBy = (idOrKey) => settings.shared.find((folder) => folder.key === idOrKey || folder.id === idOrKey);
  const update = (key, patch) => save({ ...settings, shared: settings.shared.map((folder) => (folder.key === key ? { ...folder, ...patch } : folder)) });

  /** Whether `pcPath` may be shared, and how much it holds (counted for a moment at most; `partial` past that). */
  async function check(pcPath, self = null) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const name = p.basename(pcPath) || pcPath;
    const refused = (refusal) => ({ name, pcPath, files: 0, bytes: 0, partial: false, refusal });
    let real;
    try { real = fs.realpathSync(pcPath); } catch { return refused("not-a-folder"); }
    if (!fs.statSync(real, { throwIfNoEntry: false })?.isDirectory()) return refused("not-a-folder");
    let home = homeDir;
    try { home = fs.realpathSync(homeDir); } catch {}
    if (real === p.parse(real).root || within(home, real, platform)) return refused("too-broad");
    try { if (fs.statSync(real).dev !== fs.statSync(path.dirname(real)).dev) return refused("too-broad"); } catch {}
    const appDirs = [localDataDir, outputsDir].filter(Boolean);
    if (appDirs.some((dir) => within(real, dir, platform) || within(dir, real, platform))) return refused("app-data");
    const parts = pathKey(p.relative(home, real), platform).split("/");
    if (parts.some((part) => PRIVATE.some((name) => pathKey(name, platform) === part))) return refused("private");
    if (settings.shared.some((folder) => folder.key !== self && (within(real, folder.pcPath, platform) || within(folder.pcPath, real, platform)))) return refused("already-shared");
    let files = 0, bytes = 0, partial = false;
    const deadline = Date.now() + CHECK_MS;
    const walk = (dir) => {
      if (partial) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files >= CHECK_FILES_MAX || Date.now() > deadline) { partial = true; return; }
        if (skipped(entry.name, entry.isDirectory())) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) { files++; bytes += fs.lstatSync(file, { throwIfNoEntry: false })?.size ?? 0; }
      }
    };
    walk(real);
    return { name, pcPath: real, files, bytes, partial, refusal: null };
  }

  /** Bot output folders that hold work from since the person turned this on, each in Documents/MausBot/<bot>/<conversation>. */
  async function outputPlaces(cloud, folders) {
    const places = new Map();
    const taken = (dir) => {
      const names = new Set();
      try { for (const name of fs.readdirSync(dir)) names.add(foldKey(name)); } catch {}
      for (const { local } of state.places()) if (path.dirname(local) === dir) names.add(foldKey(path.basename(local)));
      return names;
    };
    let listed = null;
    for (const folder of folders) {
      let local = state.place(folder.id);
      if (!local) {
        if (!((folder.newestMs ?? 0) >= settings.outputs.since)) continue;
        listed ??= await cloud.bots();
        const bot = listed.bots.find((entry) => entry.id === folder.botId);
        const task = bot?.tasks?.find((entry) => entry.threadId === folder.threadId);
        let botDir = state.meta(`botdir:${folder.botId}`);
        if (!botDir) {
          botDir = path.join(outputsDir, safeFolderName(bot?.name ?? "Bot", taken(outputsDir)));
          state.setMeta(`botdir:${folder.botId}`, botDir);
        }
        local = path.join(botDir, safeFolderName(task?.title || "Conversation", taken(botDir)));
        state.setPlace(folder.id, local);
      }
      places.set(folder.id, local);
    }
    return places;
  }

  function watchShared() {
    const keys = new Set(settings.shared.map((folder) => folder.key));
    for (const [key, close] of watchers) if (!keys.has(key)) { close(); watchers.delete(key); }
    for (const folder of settings.shared) {
      if (watchers.has(folder.key) || !folder.id || !fs.existsSync(folder.pcPath)) continue;
      // By key: a folder shared again on My Cloud gets a new id.
      watchers.set(folder.key, watch(folder.pcPath, () => { const id = sharedBy(folder.key)?.id; void pass(id ? new Set([id]) : null); }));
    }
  }

  /** Passes run one at a time. A call while one waits joins it (its folders added, or all of them) and gets its promise. */
  function pass(only = null) {
    if (closed) return Promise.resolve();
    if (pending) {
      pending.only = pending.only && only ? new Set([...pending.only, ...only]) : null;
      return pending.promise;
    }
    const entry = { only, promise: null };
    entry.promise = chain.then(() => {
      if (pending === entry) pending = null;
      return runPass(entry.only);
    });
    pending = entry;
    chain = entry.promise.catch(() => {});
    return entry.promise;
  }

  async function runPass(only) {
    if (closed) return;
    const origin = cloudOrigin();
    if (!origin) { publish({ phase: "unavailable", disk: null }); return; }
    if (power.asleep()) { publish({ phase: "asleep" }); return; }
    // Another My Cloud (another account): nothing recorded applies; the shared folders are registered there afresh.
    if (settings.origin !== origin) {
      state.reset();
      results.clear();
      save({ ...settings, origin, unregister: [], shared: settings.shared.map((folder) => ({ ...folder, id: null, deletes: null })) });
    }
    const cloud = createClient({ origin, fetch: fetchImpl, power });
    const report = newReport();
    try {
      publish({ phase: "syncing" });
      await unregisterDropped(cloud);
      const summary = await cloud.summary();
      const lent = await reconcileLending(cloud, summary);
      const listed = new Set(summary.folders.map((folder) => folder.id));
      const cloning = new Set();
      for (const folder of settings.shared) {
        if (only && folder.id && !only.has(folder.id)) continue;
        try {
          if (!folder.id || !listed.has(folder.id)) {
            const git = folder.lentId ? lent?.git.get(folder.lentId) : null;
            const registered = await cloud.register({ computerId: settings.computerId, computerName: hostname, pcPath: folder.pcPath, name: folder.name, ...(folder.lentId ? { lent: true } : {}), ...(git ? { git } : {}) });
            if (registered.id !== folder.id) state.dropFolder(folder.id ?? folder.key);
            update(folder.key, { id: registered.id });
            if (registered.cloning) cloning.add(registered.id);
          }
          const current = sharedBy(folder.key);
          if (!current) continue;
          // A GitHub repository's copy starts as My Cloud's own clone: Files sends only what differs, once it is there.
          if (cloning.has(current.id) || summary.folders.find((entry) => entry.id === current.id)?.cloning) {
            results.set(folder.key, { status: "copying", files: 0, done: 0, waitingBytes: 0, pendingDeletes: 0, problem: null });
            continue;
          }
          const approveDeletes = current.deletes === "remove" ? true : current.deletes === "keep" ? false : null;
          // Bots' changes from while this computer was away land first, so this pass carries them up to the copy; while
          // lending is paused they wait on My Cloud, as they do while this computer is away.
          const lentFolder = current.lentId && !lent?.paused ? lent?.folders.find((entry) => entry.id === current.lentId) : null;
          const waiting = summary.folders.find((entry) => entry.id === current.id)?.staged ?? 0;
          const landed = lentFolder && waiting > 0 ? await applyStaged({ client: cloud, folderId: current.id, folder: lentFolder, protectedPaths: lent.protectedPaths,
            now, trashItem, markDownloaded, platform, stopper: passStopper }) : null;
          if (landed?.kept.length) update(folder.key, { kept: [...landed.kept, ...(current.kept ?? [])].slice(0, KEPT_MAX) });
          const result = await shareFolder({ client: cloud, state, folder: { id: current.id }, local: current.pcPath, now, approveDeletes, report });
          if (!sharedBy(folder.key)) continue;
          const inStep = result.status === "synced";
          // A bot's change that can't land here (a name this computer can't hold, a protected place) shows on the folder.
          if (landed?.problem) {
            result.problem ??= landed.problem;
            if (inStep) result.status = "problem";
          }
          results.set(folder.key, result);
          if (current.deletes) update(folder.key, { deletes: null });
          if (current.lentId && inStep) await cloud.synced(current.id).catch(noted("saying the copy is in step"));
        } catch (error) {
          if (passStopper(error)) throw error;
          if (!sharedBy(folder.key)) continue;
          if (error?.status === 410) update(folder.key, { id: null });
          results.set(folder.key, { status: "problem", files: 0, done: 0, waitingBytes: 0, pendingDeletes: 0, problem: String(error?.message ?? error) });
        }
      }
      let outputsProblem = null, outputFolders = 0;
      if (settings.outputs.enabled) {
        try {
          const places = await outputPlaces(cloud, summary.folders.filter((folder) => folder.kind === "bot"));
          outputFolders = places.size;
          for (const [id, local] of places) {
            if (only && !only.has(id)) continue;
            try {
              await fetchOutputs({ client: cloud, state, folder: { id }, local, platform, now, trashItem, markDownloaded, ...(freeBytes ? { freeBytes } : {}), report });
            } catch (error) {
              if (passStopper(error)) throw error;
              if (error?.status !== 410) outputsProblem = String(error?.message ?? error);
            }
          }
        } catch (error) {
          if (passStopper(error)) throw error;
          outputsProblem = String(error?.message ?? error);
        }
      }
      if (lent) await cloud.lent(lentReport({ computerId: settings.computerId, lendingId: lent.lendingId, name: hostname, platform, folders: lent.folders, plan: lent.plan, shared: settings.shared, git: lent.git }))
        .catch(noted("saying what is lent"));
      watchShared();
      const disk = summary.disk;
      const usedBytes = disk.totalBytes - disk.freeBytes;
      publish({
        phase: "idle", lastSyncedAt: now(),
        disk: { totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, usedBytes, sharedBytes: disk.syncedBytes ?? 0, warn: usedBytes >= 0.8 * disk.totalBytes },
        outputs: { ...status.outputs, folders: outputFolders, problem: outputsProblem },
      });
    } catch (error) {
      publish({ phase: error instanceof SyncAuthError ? "signed-out" : error instanceof CloudAsleepError ? "asleep" : "offline" });
      if (!passStopper(error)) console.error(`[files] pass stopped: ${error?.message ?? error}`);
    }
  }

  /** Copies My Cloud no longer keeps (sharing stopped, or the folder no longer lent) go to its trash. */
  async function unregisterDropped(cloud) {
    for (const id of settings.unregister ?? []) {
      await cloud.unregister(id, false).catch((error) => { if (passStopper(error) || error?.status !== 404) throw error; });
      save({ ...settings, unregister: (settings.unregister ?? []).filter((other) => other !== id) });
    }
  }

  /** Lent folders (lent-folders.mjs): Files' list follows what is lent to My Cloud, folders the Files page shared before
   * lending took them become lent folders, and each lent folder that fits gets a copy. Null while lending is unknown. */
  async function reconcileLending(cloud, summary) {
    // A Cloud from before lent copies would keep them where every bot reads them: lending stays live only there.
    const lendingNow = summary.lentCopies === true ? lending?.now() ?? null : null;
    if (!lendingNow) return null;
    // A folder the Files page shared while lending was off joins what is lent, read only, once lending is on.
    if (!lendingNow.off && settings.shared.some((entry) => !entry.lentId && !entry.lendTried)) {
      for (const entry of settings.shared.filter((candidate) => !candidate.lentId && !candidate.lendTried)) {
        await lending.lend(entry.pcPath).catch(() => null);
        update(entry.key, { lendTried: true });
      }
      return reconcileLending(cloud, summary);
    }
    const folders = lendingNow.off ? [] : lendingNow.folders;
    const same = sameFolderOn(platform);
    const copied = copiedLent(settings.shared, folders, same);
    const checks = new Map();
    for (const folder of folders) {
      if (copied.has(folder.id)) continue;
      const known = lentChecks.get(folder.id);
      if (known && known.path === folder.path && now() - known.at < RECHECK_MS) { checks.set(folder.id, known.check); continue; }
      const checked = await check(folder.path);
      lentChecks.set(folder.id, { at: now(), path: folder.path, check: checked });
      checks.set(folder.id, checked);
    }
    const plan = planLentCopies({ folders, checks, copied, disk: summary.disk, planDisk: planDisk() });
    const { shared, dropped } = reconcileLent({ shared: settings.shared, folders, plan, sameFolder: same, now: now() });
    for (const entry of dropped) {
      watchers.get(entry.key)?.();
      watchers.delete(entry.key);
      results.delete(entry.key);
      if (entry.id) state.dropFolder(entry.id);
    }
    save({ ...settings, shared, unregister: [...(settings.unregister ?? []), ...dropped.filter((entry) => entry.id).map((entry) => entry.id)] });
    if (dropped.length) await unregisterDropped(cloud);
    // GitHub repositories among the copied ones: My Cloud clones them, and bots return code work as pull requests.
    const git = new Map(folders.filter((folder) => plan.get(folder.id)?.copy).map((folder) => [folder.id, lentGit(folder.path)]).filter(([, found]) => found));
    return { ...lendingNow, folders, plan, git };
  }

  async function pollLoop(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      if (power.asleep()) {
        if (cloudOrigin()) publish({ phase: "asleep" });
        await power.wait(signal);
        if (!signal.aborted) void pass();
        continue;
      }
      try {
        const cloud = client();
        if (!cloud) { await sleep(30_000, signal); continue; }
        const result = await cloud.changes(cursor, LONG_POLL_MS, AbortSignal.any([signal, power.signal()]));
        const recovered = attempt > 0, known = cursor !== 0;
        attempt = 0;
        cursor = result.cursor;
        // Back online after failures: anything may have changed meanwhile, so look at every folder.
        if (recovered) void pass();
        else if (known && result.folderIds.length) void pass(new Set(result.folderIds));
      } catch {
        if (signal.aborted) return;
        if (power.asleep()) continue;
        await sleep(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)], signal);
      }
    }
  }

  function start() {
    if (closed || interval) return;
    interval = setInterval(() => void pass(), FULL_PASS_MS);
    interval.unref?.();
    poller = new AbortController();
    void pollLoop(poller.signal);
    void pass();
  }

  const api = {
    start,
    pass,
    /** Started, so it calls My Cloud whenever there is one. */
    running: () => Boolean(interval) && !closed,
    state: () => view(),
    check: (pcPath) => check(pcPath),
    async share(pcPath) {
      const checked = await check(pcPath);
      if (checked.refusal) throw new Error(`This folder can't be shared (${checked.refusal}).`);
      const key = randomUUID();
      save({ ...settings, shared: [...settings.shared, { key, id: null, pcPath: checked.pcPath, name: checked.name, deletes: null, addedAt: now() }] });
      results.set(key, { status: "copying", files: checked.files, done: 0, waitingBytes: 0, pendingDeletes: 0, problem: null });
      onChange(view());
      await pass();
      return view();
    },
    /** A folder the Files page just lent: its entry now, so its copy starts at once (lent-folders.mjs). */
    async adopt(folder) {
      if (!settings.shared.some((entry) => entry.lentId === folder.id)) {
        save({ ...settings, shared: [...settings.shared, { key: randomUUID(), id: null, pcPath: folder.path, name: folder.name, lentId: folder.id, write: folder.write === true, deletes: null, addedAt: now() }] });
      }
      onChange(view());
      await pass();
      return view();
    },
    /** The lent folder behind a Files entry, or null for one the Files page shared on its own. */
    lentOf: (idOrKey) => sharedBy(idOrKey)?.lentId ?? null,
    async stopSharing(idOrKey) {
      const folder = sharedBy(idOrKey);
      if (!folder) return view();
      watchers.get(folder.key)?.();
      watchers.delete(folder.key);
      results.delete(folder.key);
      if (folder.id) state.dropFolder(folder.id);
      save({ ...settings, shared: settings.shared.filter((other) => other.key !== folder.key), unregister: folder.id ? [...(settings.unregister ?? []), folder.id] : settings.unregister ?? [] });
      onChange(view());
      void pass();
      return view();
    },
    async answerDeletes(idOrKey, remove) {
      const folder = sharedBy(idOrKey);
      if (!folder) return view();
      update(folder.key, { deletes: remove ? "remove" : "keep" });
      await pass(folder.id ? new Set([folder.id]) : null);
      return view();
    },
    async relocate(idOrKey, pcPath) {
      const folder = sharedBy(idOrKey);
      if (!folder) return view();
      const checked = await check(pcPath, folder.key);
      if (checked.refusal) throw new Error(`This folder can't be shared (${checked.refusal}).`);
      watchers.get(folder.key)?.();
      watchers.delete(folder.key);
      update(folder.key, { pcPath: checked.pcPath });
      await pass(folder.id ? new Set([folder.id]) : null);
      return view();
    },
    async setOutputs(enabled) {
      save({ ...settings, outputs: { enabled, since: settings.outputs.since ?? now() } });
      onChange(view());
      if (enabled) void pass();
      return view();
    },
    localFolder(target) {
      if (target?.outputs) { fs.mkdirSync(outputsDir, { recursive: true }); return outputsDir; }
      return sharedBy(target?.folderId)?.pcPath ?? null;
    },
    openDashboard,
    wake: () => void pass(),
    close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      poller?.abort();
      for (const close of watchers.values()) close();
      watchers.clear();
      state.close();
    },
  };
  return api;
}
