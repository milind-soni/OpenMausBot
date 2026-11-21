// Ask a CUA Driver executable for its version, and say exactly what happened when it does not give one: the
// packaging scripts used to turn every failure (a start Windows refused, a crash, a timeout, other output) into
// "does not report version", which hid the cause. The sha256 pin stays the integrity check; this only reports.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { release, version as osVersion } from "node:os";
import { join } from "node:path";

const OUTPUT_SHOWN = 2_000;

/** Windows NTSTATUS exit codes a process that never ran its own code ends with. */
const NTSTATUS = {
  0xc0000005: "STATUS_ACCESS_VIOLATION: it crashed",
  0xc000007b: "STATUS_INVALID_IMAGE_FORMAT: a wrong-architecture or damaged executable or DLL",
  0xc0000135: "STATUS_DLL_NOT_FOUND: a DLL it needs is missing",
  0xc0000139: "STATUS_ENTRYPOINT_NOT_FOUND: a DLL it loads lacks a function it needs",
  0xc0000142: "STATUS_DLL_INIT_FAILED: a DLL it loads failed to start",
  0xc0000409: "STATUS_STACK_BUFFER_OVERRUN: it ended itself on a fatal error (fail fast or abort)",
  0xc0000374: "STATUS_HEAP_CORRUPTION: it crashed",
  0xc000001d: "STATUS_ILLEGAL_INSTRUCTION: it uses an instruction this CPU lacks",
};

/** An exit code as Windows means it: a large one is an NTSTATUS, shown in hex with what it stands for. */
export function describeExitCode(code) {
  const unsigned = code >>> 0;
  if (unsigned < 0x80000000) return String(code);
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`;
  const meaning = NTSTATUS[unsigned];
  return `${unsigned} (${hex}${meaning ? `, ${meaning}` : ""})`;
}

const shown = (text) => {
  const trimmed = String(text ?? "").trim();
  return JSON.stringify(trimmed.length > OUTPUT_SHOWN ? `${trimmed.slice(0, OUTPUT_SHOWN)}…` : trimmed);
};

/** What one `--version` run did, in a line: started or not, how it ended, and everything it printed. */
export function describeRun({ error, stdout, stderr, elapsedMs }, timeoutMs) {
  let ended;
  if (!error) ended = "exited with code 0";
  else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") ended = "printed more than 256 KiB and was ended";
  else if (error.killed && (error.signal || error.code === null)) ended = `timed out after ${timeoutMs} ms and was ended with ${error.signal ?? "a kill"}`;
  else if (typeof error.code === "string") ended = `could not run: ${error.code}${error.syscall ? ` (${error.syscall})` : ""}${error.errno !== undefined ? ` errno ${error.errno}` : ""}`;
  else if (typeof error.code === "number") ended = `exited with code ${describeExitCode(error.code)}`;
  else if (error.signal) ended = `was ended by ${error.signal}`;
  else ended = `failed: ${error.message}`;
  return `${ended} after ${elapsedMs} ms; stdout ${shown(stdout)}; stderr ${shown(stderr)}`;
}

const VERSION = /cua-driver\s+([\d.]+)/;

function runOnce(binary, { timeoutMs, env }) {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(binary, ["--version"], {
      encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, ...(env ? { env } : {}),
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

/**
 * Runs `<binary> --version` until it reports a version, a few times with a short wait between (a freshly written
 * executable can be held by a scan on its first start). Returns the version, or null with `why`: every attempt, said.
 */
export async function probeCuaVersion(binary, { attempts = 3, timeoutMs = 20_000, retryWaitMs = 2_000, env, run = runOnce, sleep } = {}) {
  if (!binary) return { version: null, why: "no executable was named" };
  if (!existsSync(binary)) return { version: null, why: `${binary} does not exist` };
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tries = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await run(binary, { timeoutMs, env });
    const version = result.error ? null : String(result.stdout ?? "").match(VERSION)?.[1] ?? null;
    if (version) {
      if (attempt > 1) console.log(`${binary} reported its version on attempt ${attempt}; before that it ${tries.join("; then it ")}`);
      return { version, why: null };
    }
    tries.push(describeRun(result, timeoutMs));
    if (attempt < attempts) await wait(retryWaitMs);
  }
  return { version: null, why: `\`${binary} --version\` gave no version in ${attempts} attempts: it ${tries.map((line, index) => `(${index + 1}) ${line}`).join("; ")}` };
}

/** The facts about this Windows machine and the extracted release that decide whether its executable can start. */
export function windowsRunnerFacts(folder) {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const runtimes = ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "MSVCP140.dll", "d3d11.dll", "dwmapi.dll", "oleacc.dll", "wtsapi32.dll"]
    .map((dll) => `${dll} ${existsSync(join(system32, dll)) ? "present" : "MISSING"}`);
  let files;
  try {
    files = readdirSync(folder).map((name) => {
      const path = join(folder, name);
      const marked = existsSync(`${path}:Zone.Identifier`) ? " (has a Zone.Identifier mark)" : "";
      return `${name} ${statSync(path).size} bytes${marked}`;
    });
  } catch (error) {
    files = [`(could not list ${folder}: ${error instanceof Error ? error.message : String(error)})`];
  }
  return [
    `Windows ${release()} (${osVersion()}), node ${process.version} ${process.arch}`,
    `System32 DLLs: ${runtimes.join(", ")}`,
    `${folder}: ${files.join(", ")}`,
  ].join("\n");
}
