// One folder's pass of Files: read both sides, plan (cloud-sync-plan.mjs), carry each action out, and record the base
// only once both sides hold the same bytes. A shared folder goes this computer → My Cloud; a bot's work My Cloud → this
// computer. A per-file failure is retried next pass; a signed-out or offline Cloud stops the whole pass.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RESERVE_BYTES, clashPath, neverFromCloud, validWirePath, windowsProblem } from "./cloud-sync-rules.mjs";
import { planOutputs, planShare } from "./cloud-sync-plan.mjs";
import { scanPc, sha256File } from "./cloud-sync-scan.mjs";
import { SyncAuthError } from "./cloud-sync-client.mjs";
import { CloudAsleepError } from "./cloud-power.mjs";

const TEMP_TAG = ".omb-sync-";
const TEMP_STALE_MS = 24 * 60 * 60_000;
const CONCURRENCY = 2;

export function newReport() {
  return { folders: new Map(), outputsProblem: null };
}

/** True when the whole pass should stop (signed out, offline, asleep), not just this file. */
export function passStopper(error) {
  return error instanceof SyncAuthError || error instanceof CloudAsleepError || error?.name === "AbortError" || error?.name === "TimeoutError"
    || (error?.name === "TypeError" && /fetch/i.test(String(error.message)));
}

const defaultFree = (dir) => { const stats = fs.statfsSync(dir); return stats.bavail * stats.bsize; };

async function inPool(items, size, work) {
  let next = 0, stop = null;
  const runner = async () => {
    while (next < items.length && !stop) {
      const item = items[next++];
      try { await work(item); } catch (error) { stop ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
  if (stop) throw stop;
}

/** Each action once; a failure is this file's (three in a row show as the folder's problem), unless it stops the pass. */
async function carryOut(ctx, actions, work) {
  await inPool(actions, CONCURRENCY, async (action) => {
    try {
      await work(action);
      ctx.state.cleared(ctx.folder.id, action.path);
    } catch (error) {
      if (passStopper(error)) throw error;
      const message = String(error?.message ?? error);
      if (ctx.state.failed(ctx.folder.id, action.path, message) >= 3) ctx.result.problem ??= `${action.path}: ${message}`;
    }
  });
}

/**
 * A shared folder: this computer's files to My Cloud. Not on this computer (moved, renamed, a drive unplugged): nothing
 * is touched, and the person is asked where it went. Many files gone at once wait for the person (`approveDeletes`).
 */
export async function shareFolder({ client, state, folder, local, now = Date.now, approveDeletes = null, report }) {
  const result = { status: "synced", files: 0, done: 0, waitingBytes: 0, pendingDeletes: 0, problem: null };
  report.folders.set(folder.id, result);
  if (!fs.lstatSync(local, { throwIfNoEntry: false })?.isDirectory()) { result.status = "missing"; return result; }
  const base = state.base(folder.id);
  const { entries: pc, temps, keptDirs } = await scanPc(local, base, { now });
  for (const temp of temps) if (now() - temp.mtimeMs > TEMP_STALE_MS) fs.rmSync(temp.file, { force: true });
  const cloud = new Map((await client.files(folder.id)).filter((file) => validWirePath(file.path)).map((file) => [file.path, file]));
  const plan = planShare({ base, pc, cloud, keptDirs });
  const ctx = { client, state, folder, result };
  result.files = [...pc.values()].filter((file) => !file.kept).length;
  result.done = result.files - plan.uploads.length;
  for (const record of plan.records) state.setBase(folder.id, record.path, record);
  for (const { path: wire } of plan.forgets) state.dropBase(folder.id, wire);
  // Smallest first, so one file that does not fit cannot hold the small ones back.
  await carryOut(ctx, plan.uploads.sort((a, b) => a.size - b.size), async (action) => {
    const sent = await send(ctx, action);
    if (sent === "full") { result.waitingBytes += action.size; return; }
    state.setBase(folder.id, action.path, action);
    result.done++;
  });
  if (plan.deletes.length) {
    if (plan.ask && approveDeletes == null) result.pendingDeletes = plan.deletes.length;
    else if (plan.ask && approveDeletes === false) for (const { path: wire } of plan.deletes) state.dropBase(folder.id, wire);
    else await carryOut(ctx, plan.deletes, async ({ path: wire, baseSha256 }) => {
      const [answer] = await client.ops(folder.id, [{ op: "delete", path: wire, baseSha256 }]);
      if (answer?.ok || answer?.conflict) state.dropBase(folder.id, wire);
    });
  }
  result.status = result.pendingDeletes ? "confirm-deletes" : result.waitingBytes ? "waiting" : result.done < result.files ? "copying" : result.problem ? "problem" : "synced";
  return result;
}

/** This computer's version wins: a change a bot made on My Cloud since the listing is replaced too (its copy goes to the trash there). */
async function send(ctx, action, again = true) {
  const sent = await ctx.client.upload({ folderId: ctx.folder.id, path: action.path, file: action.file, size: action.size, sha256: action.sha256, baseSha256: action.baseSha256 });
  if (sent.ok) return "ok";
  if (sent.full) return "full";
  if (sent.conflict) {
    if (sent.current?.sha256 === action.sha256) return "ok";
    if (again) return send(ctx, { ...action, baseSha256: sent.current?.sha256 ?? null }, false);
    throw new Error("It kept changing on My Cloud; it will be sent again.");
  }
  throw new Error("My Cloud gave an answer this app does not understand.");
}

/**
 * A bot's work: My Cloud's files to this computer, in `local` (Documents/MausBot/<bot>/<conversation>). Never deletes here,
 * never writes a config an agent or tool would obey, and marks each file as downloaded (`markDownloaded`).
 */
export async function fetchOutputs({ client, state, folder, local, platform = process.platform, now = Date.now, trashItem, markDownloaded = async () => {}, freeBytes = defaultFree, report }) {
  const result = { status: "synced", files: 0, done: 0, waitingBytes: 0, pendingDeletes: 0, problem: null };
  report.folders.set(folder.id, result);
  fs.mkdirSync(local, { recursive: true });
  const base = state.base(folder.id);
  const { entries: pc, temps } = await scanPc(local, base, { now });
  for (const temp of temps) if (now() - temp.mtimeMs > TEMP_STALE_MS) fs.rmSync(temp.file, { force: true });
  const listed = (await client.files(folder.id)).filter((file) => validWirePath(file.path) && !neverFromCloud(file.path) && !(platform === "win32" && windowsProblem(file.path)));
  const cloud = new Map(listed.map((file) => [file.path, file]));
  const { downloads, records } = planOutputs({ base, pc, cloud });
  const ctx = { client, state, folder, local, pc, cloud, now, trashItem, markDownloaded, freeBytes, result };
  result.files = cloud.size;
  result.done = cloud.size - downloads.length;
  for (const record of records) state.setBase(folder.id, record.path, record);
  await carryOut(ctx, downloads, async (action) => {
    if (await receive(ctx, action) === "full") { result.waitingBytes += action.size; return; }
    result.done++;
  });
  result.status = result.waitingBytes ? "waiting" : result.done < result.files ? "copying" : result.problem ? "problem" : "synced";
  return result;
}

/** Where a wire path lives in this folder: never outside it, and never through a link or a file in the way. */
function localFile(ctx, wire) {
  if (!validWirePath(wire)) throw new Error("My Cloud sent a path this app will not write.");
  const parts = wire.split("/");
  let current = ctx.local;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`${wire} goes through a link or a file on this computer.`);
  }
  const file = path.join(ctx.local, ...parts);
  if (!file.startsWith(path.join(ctx.local, path.sep))) throw new Error("My Cloud sent a path outside this folder.");
  return file;
}

async function receive(ctx, { path: wire, sha256, size, replace, beside }) {
  const { client, folder, state } = ctx;
  if (ctx.freeBytes(ctx.local) - size < RESERVE_BYTES) return "full";
  let target = localFile(ctx, wire);
  const kept = fs.lstatSync(target, { throwIfNoEntry: false });
  // The person's own edit stays as it is: My Cloud's newer version lands beside it.
  if (beside && kept) {
    const taken = (candidate) => ctx.pc.has(candidate) || ctx.cloud.has(candidate) || fs.existsSync(localFile(ctx, candidate));
    target = localFile(ctx, clashPath(wire, ctx.now(), taken, "new from My Cloud"));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tag = createHash("sha256").update(`${folder.id}\n${wire}`).digest("hex").slice(0, 8);
  const temporary = path.join(path.dirname(target), `.${path.basename(target).slice(0, 180)}${TEMP_TAG}${tag}`);
  const sent = await client.download(folder.id, wire, temporary, size);
  const got = await sha256File(temporary);
  if (got !== (sent.sha256 ?? sha256)) { fs.rmSync(temporary, { force: true }); throw new Error("The download was damaged; it will be fetched again."); }
  await ctx.markDownloaded(temporary);
  const now = fs.lstatSync(target, { throwIfNoEntry: false });
  if (now) {
    // Only a file still exactly as the plan saw it is replaced, and the one it replaces goes to the Recycle Bin first.
    if (!replace || !now.isFile() || now.size !== replace.size || now.mtimeMs !== replace.mtimeMs) { fs.rmSync(temporary, { force: true }); return "skipped"; }
    await ctx.trashItem(target);
  }
  fs.renameSync(temporary, target);
  const stat = fs.statSync(target);
  if (target === localFile(ctx, wire)) state.setBase(folder.id, wire, { sha256: got, size: stat.size, mtimeMs: stat.mtimeMs });
  else {
    const here = ctx.pc.get(wire);
    if (here && !here.unsettled) state.setBase(folder.id, wire, { sha256, size: here.size, mtimeMs: here.mtimeMs });
  }
  return "ok";
}

