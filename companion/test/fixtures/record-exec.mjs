// Preloaded into a sidecar under test: every execFile is recorded and refused, so no real program (Tailscale above
// all) ever runs on the machine running the tests.
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const childProcess = createRequire(import.meta.url)("node:child_process");
childProcess.execFile = (file, args, options, callback) => {
  appendFileSync(process.env.RECORD_EXEC_FILE, `${JSON.stringify([file, ...(Array.isArray(args) ? args : [])])}\n`);
  const done = [args, options, callback].find((value) => typeof value === "function");
  queueMicrotask(() => done?.(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", ""));
  return { kill() {}, on() {}, once() {} };
};
syncBuiltinESMExports();
