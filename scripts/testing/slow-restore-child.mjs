// Test-only slow disk. Run the real bundled server unchanged, but throttle
// reads of one synthetic staged file for 65 seconds. Never loaded by OMB.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const open = fs.openSync;
const read = fs.readSync;
const close = fs.closeSync;
const tracked = new Set();
let started;
fs.openSync = function(path, ...args) {
  const fd = open.call(this, path, ...args);
  if (String(path).endsWith("restore-payload.bin")) tracked.add(fd);
  return fd;
};
fs.closeSync = function(fd) { tracked.delete(fd); return close.call(this, fd); };
fs.readSync = function(fd, buffer, offset, length, position) {
  if (tracked.has(fd)) {
    started ??= Date.now();
    if (Date.now() - started < 65_000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 520);
      length = Math.min(length, 16_384);
    }
  }
  return read.call(this, fd, buffer, offset, length, position);
};
syncBuiltinESMExports();
await import(pathToFileURL(process.argv[2]).href);
