// Loaded with --import into a fixture server that scripts/bench-desktop.ts starts, never into the app: it counts
// timer callbacks and file writes, and on SIGUSR2 writes the running totals, CPU and memory to $OMB_BENCH_TALLY.
import fs from "node:fs";
import module from "node:module";
import { basename, dirname } from "node:path";
import timers from "node:timers";

const out = process.env.OMB_BENCH_TALLY;
delete process.env.OMB_BENCH_TALLY;

const fired = new Map();
const intervals = new Map();
const writes = new Map();
const fdPaths = new Map();
let fsyncs = 0;
let renames = 0;

const fileKey = (path) => {
  const name = basename(String(path))
    .replace(/\.\d+\.[0-9a-f-]{36}\.tmp$/, "")
    .replace(/\.tmp$/, "")
    .replace(/^[0-9a-f-]{36}(?=\.)/, "<id>")
    .replace(/^[0-9a-f]{8,}(?=\.)/, "<id>");
  const folder = basename(dirname(String(path)));
  return name.startsWith("<id>") ? `${folder}/${name}` : name;
};
const byteLength = (data) => typeof data === "string" ? Buffer.byteLength(data) : data?.byteLength ?? 0;
const tallyWrite = (target, data) => {
  const path = typeof target === "number" ? fdPaths.get(target) : target;
  if (path === undefined) return;
  const key = fileKey(path);
  const entry = writes.get(key) ?? { bytes: 0, calls: 0 };
  entry.bytes += byteLength(data);
  entry.calls += 1;
  writes.set(key, entry);
};

const countFire = (key) => fired.set(key, (fired.get(key) ?? 0) + 1);
const siteOf = () => {
  const line = new Error().stack?.split("\n").slice(3).find((frame) => !frame.includes("bench-server-tally") && !frame.includes("node:internal"));
  return line?.trim().replace(/^at /, "").replace(/^.*\((.*)\)$/, "$1").replace(/^file:\/\/.*?\/(server|shared)\//, "$1/") ?? "?";
};
const wrapTimer = (original, kind) => function (callback, delay, ...args) {
  if (typeof callback !== "function") return original.call(this, callback, delay, ...args);
  const ms = Math.round(Number(delay) || 0);
  const key = kind === "interval" ? `interval:${ms}:${siteOf()}` : `timeout:${ms < 1000 ? ms : `${Math.round(ms / 1000)}s`}`;
  if (kind === "interval") intervals.set(key, (intervals.get(key) ?? 0) + 1);
  return original.call(this, function (...inner) { countFire(key); return callback.apply(this, inner); }, delay, ...args);
};
globalThis.setTimeout = timers.setTimeout = wrapTimer(timers.setTimeout, "timeout");
globalThis.setInterval = timers.setInterval = wrapTimer(timers.setInterval, "interval");

// appendFileSync and appendFile go through fs.writeFileSync and fs.writeFile, so they are counted there.
const { openSync, closeSync, writeFileSync, writeSync, fsyncSync, renameSync } = fs;
fs.openSync = function (path, ...rest) { const fd = openSync.call(this, path, ...rest); fdPaths.set(fd, String(path)); return fd; };
fs.closeSync = function (fd) { fdPaths.delete(fd); return closeSync.call(this, fd); };
fs.writeFileSync = function (target, data, ...rest) { tallyWrite(target, data); return writeFileSync.call(this, target, data, ...rest); };
fs.writeSync = function (fd, data, ...rest) { tallyWrite(fd, data); return writeSync.call(this, fd, data, ...rest); };
fs.fsyncSync = function (fd) { fsyncs += 1; return fsyncSync.call(this, fd); };
fs.renameSync = function (...args) { renames += 1; return renameSync.apply(this, args); };
const { writeFile, appendFile } = fs.promises;
fs.promises.writeFile = function (target, data, ...rest) { if (typeof target !== "object") tallyWrite(target, data); return writeFile.call(this, target, data, ...rest); };
fs.promises.appendFile = function (target, data, ...rest) { if (typeof target !== "object") tallyWrite(target, data); return appendFile.call(this, target, data, ...rest); };
const callbackWriteFile = fs.writeFile;
fs.writeFile = function (target, data, ...rest) { if (typeof target !== "object") tallyWrite(target, data); return callbackWriteFile.call(this, target, data, ...rest); };
const handle = await fs.promises.open(process.platform === "win32" ? "NUL" : "/dev/null", "r");
const FileHandle = Object.getPrototypeOf(handle);
await handle.close();
const { open } = fs.promises;
const handlePaths = new WeakMap();
fs.promises.open = async function (path, ...rest) { const opened = await open.call(this, path, ...rest); handlePaths.set(opened, String(path)); return opened; };
for (const method of ["write", "writeFile", "appendFile"]) {
  const original = FileHandle[method];
  FileHandle[method] = function (data, ...rest) { const path = handlePaths.get(this); if (path) tallyWrite(path, data); return original.call(this, data, ...rest); };
}
module.syncBuiltinESMExports();

if (out) {
  process.on("SIGUSR2", () => {
    writeFileSync(out, JSON.stringify({
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      uptimeMs: Math.round(process.uptime() * 1000),
      fired: Object.fromEntries(fired),
      intervals: Object.fromEntries(intervals),
      writes: Object.fromEntries(writes),
      fsyncs,
      renames,
    }));
  });
}
