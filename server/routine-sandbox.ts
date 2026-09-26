// Scripted routine sandbox runtime (ADR: docs/design/adr-d2-scripted-routine-sandbox.md).
//
// Executes a reviewed routine script in a fresh child of the server's own
// Node binary with the permission model on and zero --allow-* flags. The
// child's whole world is a fixed bootstrap: neutered process internals, no
// eval/Function/WebAssembly/dynamic-import, an injected fetch shim that
// speaks a size-capped framed channel to this host, and a state shim. All
// network policy (allowlist, DNS resolution, address-range denial,
// credentials, budgets, caps) is re-derived here, never trusted from the
// child. v1 is server-only behind features.scriptedRoutines; the
// Electron-embedded parent stays dark until its packaged build passes the
// runtime canary (ADR section 10).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIPv4 } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

/** Address ranges a host may resolve into that are denied unless the
 * allowlist entry opts in by name (ADR section 4). */
export type ScriptedDeniedRangeName =
  | "loopback"
  | "unspecified"
  | "private"
  | "link_local"
  | "cloud_metadata"
  | "cgnat"
  | "multicast"
  | "benchmark";

export const DENIED_RANGE_NAMES: readonly ScriptedDeniedRangeName[] = [
  "loopback",
  "unspecified",
  "private",
  "link_local",
  "cloud_metadata",
  "cgnat",
  "multicast",
  "benchmark",
];

export interface ScriptedRoutineAllowlistEntry {
  /** Exact hostname. No wildcards, IP literals, userinfo or trailing dot. */
  host: string;
  /** Defaults to https; http needs an explicit entry. */
  scheme?: "http" | "https";
  /** Custom ports must be declared. */
  port?: number;
  /** Bearer credential resolved host-side at call time. */
  credentialId?: string;
  /** Reviewed opt-in for sending the bearer over plain http. The runtime
   * still requires the pinned resolved address to be loopback, so this can
   * never become a plaintext credential to an external peer. */
  allowHttpCredential?: boolean;
  /** Reviewed opt-in for otherwise-denied address ranges. */
  allow?: ScriptedDeniedRangeName[];
}

/** The stored scripted definition on a routine record. Server-private like
 * installedPackage; validated on load and dropped defensively when invalid. */
export interface ScriptedRoutineScript {
  source: string;
  /** sha256 of source, hex. Verified pre-run; mismatch refuses to execute. */
  version: string;
  /** Approved is the only executable state; staged or missing refuses. */
  reviewState?: "staged" | "approved";
  networkAllowlist?: ScriptedRoutineAllowlistEntry[];
  timeoutSeconds?: number;
  rssLimitBytes?: number;
}

export type ScriptedFailureKind =
  | "timeout"
  | "crash"
  | "policy_violation"
  | "request_limit"
  | "script_error"
  | "state_error"
  | "response_too_large";

export interface ScriptedRunFailure {
  kind: ScriptedFailureKind;
  detail: string;
  deniedHost?: string;
}

export interface ScriptedRunOutcome {
  ok: boolean;
  value?: unknown;
  logs: string[];
  warnings: string[];
  logTruncated: boolean;
  exitCode: number | null;
  durationMs: number;
  scriptVersion: string;
  deterministic: true;
  failure?: ScriptedRunFailure;
}

export interface ScriptedRoutineRunOptions {
  resolveCredential?: (credentialId: string) => string | undefined;
  resolveDns?: (host: string) => Promise<string[]>;
  stateDir?: string;
  /** Aborts the sandbox child cooperatively; the abort reason becomes the
   * crash detail on the session's done receipt. */
  abortSignal?: AbortSignal;
  /** Test seam: replaces the shipped bootstrap with a hostile child.
   * Never set in production wiring; the runtime canary always uses the
   * real BOOTSTRAP_SOURCE regardless of this option. */
  bootstrapSource?: string;
}

export interface RuntimeCanaryResult {
  checks: Record<string, boolean>;
  diagnostics: Record<string, string>;
  envKeys: string[];
}

export type RuntimeCanaryOutcome =
  | { ok: true; result: RuntimeCanaryResult }
  | { ok: false; detail: string; result?: RuntimeCanaryResult };

const ENVELOPE_MAX_BYTES = 64 * 1024;
/** One line of slack for the newline plus encode rounding; the child-side
 * finish() already refuses to emit an envelope over the hard cap. */
const ENVELOPE_READER_MAX_BYTES = 64 * 1024 + 1024;
const STDERR_MAX_BYTES = 4 * 1024;
const FRAME_MAX_BYTES = 256 * 1024;
const STATE_MAX_BYTES = 64 * 1024;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
/** Worst-case size of one host-to-child fetch-response line: a body at the
 * RESPONSE_MAX_BYTES cap can expand sixfold under JSON escaping (every code
 * unit can become a \uXXXX escape), plus header and framing slack. The
 * child's stdin buffer cap mirrors this number verbatim, so anything the
 * host admitted always fits. */
const HOST_CHANNEL_MAX_BYTES = RESPONSE_MAX_BYTES * 6 + 1024 * 1024;
const MAX_OUTSTANDING_REQUESTS = 4;
const MAX_TOTAL_REQUESTS = 50;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_RSS_LIMIT_BYTES = 512 * 1024 * 1024;
const MIN_RSS_LIMIT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_500;
const MAX_ALLOWLIST_ENTRIES = 32;
const RSS_SAMPLE_INTERVAL_MS = 2_000;
const CANARY_TIMEOUT_MS = 20_000;
const MAX_REQUEST_HEADERS = 32;
const MAX_RESPONSE_HEADERS = 64;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const ROUTINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

const REQUEST_STRIP_HEADERS = new Set([
  "authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "cookie",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

const RESPONSE_STRIP_HEADERS = new Set([
  "set-cookie",
  "www-authenticate",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Maps an AbortSignal's reason onto the crash detail of the run receipt. */
function abortReasonText(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return typeof reason === "string" && reason !== "" ? reason : "aborted";
}

/** Normalizes a DNS-resolved address before any range check (ADR N-6):
 * lowercases, strips IPv6 zone ids and brackets, and unwraps IPv4-mapped
 * IPv6 (both dotted and hex 32-bit tail forms) so a mapped 127.0.0.1 hits
 * the loopback check. */
export function normalizeResolvedAddress(address: string): string {
  let value = address.trim().toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.startsWith("::ffff:")) {
    const tail = value.slice("::ffff:".length);
    if (isIPv4(tail)) return tail;
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hexMatch) {
      const high = Number.parseInt(hexMatch[1]!, 16);
      const low = Number.parseInt(hexMatch[2]!, 16);
      return ((high >> 8) & 0xff) + "." + (high & 0xff) + "." + ((low >> 8) & 0xff) + "." + (low & 0xff);
    }
  }
  return value;
}

function deniedRangeForAddress(address: string): ScriptedDeniedRangeName | null {
  const value = normalizeResolvedAddress(address);
  if (isIPv4(value)) {
    const parts = value.split(".");
    const a = Number.parseInt(parts[0]!, 10);
    const b = Number.parseInt(parts[1]!, 10);
    if (a === 127) return "loopback";
    if (a === 0) return "unspecified";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 169 && b === 254) {
      // Cloud metadata is named before the enclosing link-local range.
      return value === "169.254.169.254" ? "cloud_metadata" : "link_local";
    }
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";
    if (a >= 224 && a <= 239) return "multicast";
    if (a === 198 && (b === 18 || b === 19)) return "benchmark";
    return null;
  }
  if (value === "::1") return "loopback";
  if (value === "::" || value === "0:0:0:0:0:0:0:0") return "unspecified";
  const head = value.split(":")[0] ?? "";
  const first = head === "" ? 0 : Number.parseInt(head, 16);
  if (Number.isNaN(first)) return null;
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link_local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  return null;
}

/** Returns the denied range for an address, or null when the entry's
 * reviewed opt-ins cover it. */
export function deniedRangeFor(
  address: string,
  optIns?: readonly ScriptedDeniedRangeName[],
): ScriptedDeniedRangeName | null {
  const range = deniedRangeForAddress(address);
  if (range !== null && optIns?.includes(range)) return null;
  return range;
}

function normalizeAllowlistHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

function isValidAllowlistHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.includes("@") || host.includes(":") || host.includes("/") || host.includes("\\")) return false;
  if (host.endsWith(".")) return false;
  if (host.startsWith("-") || host.endsWith("-")) return false;
  if (isIPv4(host)) return false;
  if (/^[0-9a-f:]+$/i.test(host) && host.includes(":")) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)) return false;
  return true;
}

const allowlistEntrySchema = z.strictObject({
  host: z.string().trim().min(1).max(253),
  scheme: z.enum(["http", "https"]).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  credentialId: z.string().trim().min(1).max(128).optional(),
  allowHttpCredential: z.boolean().optional(),
  allow: z.array(z.enum(DENIED_RANGE_NAMES)).max(DENIED_RANGE_NAMES.length).optional(),
}).superRefine((entry, ctx) => {
  // A bearer over plain http is only reviewable for a loopback service;
  // the opt-in is the review record, the runtime pins the address class.
  if (entry.scheme === "http" && entry.credentialId !== undefined && entry.allowHttpCredential !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "http entries with a credential must set allowHttpCredential (loopback only)",
    });
  }
});

const scriptedRoutineScriptSchema = z.strictObject({
  source: z.string().min(1).max(512 * 1024),
  version: z.string().regex(/^[0-9a-f]{64}$/),
  reviewState: z.enum(["staged", "approved"]).optional(),
  networkAllowlist: z.array(allowlistEntrySchema).max(MAX_ALLOWLIST_ENTRIES).optional(),
  timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
  rssLimitBytes: z.number().int().min(MIN_RSS_LIMIT_BYTES).optional(),
});

/** Validates a persisted scripted definition; returns undefined on any
 * invalid shape so the routine still loads without its script (defensive
 * drop, mirroring loadInstalledPackage). */
export function loadScriptedRoutineScript(value: unknown): ScriptedRoutineScript | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const parsed = scriptedRoutineScriptSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const entries = parsed.data.networkAllowlist ?? [];
  for (const entry of entries) {
    if (!isValidAllowlistHost(entry.host)) return undefined;
  }
  const script: ScriptedRoutineScript = { ...parsed.data };
  if (script.networkAllowlist === undefined) delete script.networkAllowlist;
  return script;
}

/** Reads length-prefixed-by-newline frames from a hostile stream with the
 * cap enforced WHILE buffering, before any newline arrives (ADR N-2): a
 * newline-less flood aborts at the cap instead of growing server memory. */
export class FramedLineReader {
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;
  // Parameter properties (TS-only syntax) are deliberately avoided across
  // server/: the server boots under Node's native type stripping, which
  // rejects them at import time (strip-only mode).
  private readonly maxLineBytes: number;
  private readonly onLine: (line: string) => void;
  private readonly onOverflow: () => void;

  constructor(maxLineBytes: number, onLine: (line: string) => void, onOverflow: () => void) {
    this.maxLineBytes = maxLineBytes;
    this.onLine = onLine;
    this.onOverflow = onOverflow;
  }

  push(chunk: Buffer): void {
    if (this.done || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxLineBytes) {
          this.done = true;
          this.onOverflow();
        }
        return;
      }
      if (newline > this.maxLineBytes) {
        this.done = true;
        this.onOverflow();
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      this.onLine(line);
      if (this.done) return;
    }
  }

  /** Stops servicing further input (used when the result envelope lands). */
  stop(): void {
    this.done = true;
  }
}

const fetchFrameSchema = z.strictObject({
  id: z.number().int().min(1),
  type: z.literal("fetch"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  url: z.string().min(1).max(8192),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  optional: z.boolean().optional(),
});

const statePutFrameSchema = z.strictObject({
  id: z.number().int().min(1),
  type: z.literal("state-put"),
  value: z.unknown().optional(),
});

type FetchFrame = z.infer<typeof fetchFrameSchema>;
type StatePutFrame = z.infer<typeof statePutFrameSchema>;

const resultEnvelopeSchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().max(16 * 1024).optional(),
  logs: z.array(z.string().max(16 * 1024)).max(1024).optional(),
  warnings: z.array(z.string().max(16 * 1024)).max(1024).optional(),
  logTruncated: z.boolean().optional(),
});

type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders): { headers: Record<string, string>; truncated: boolean } {
  const result: Record<string, string> = {};
  let truncated = false;
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (RESPONSE_STRIP_HEADERS.has(lower)) {
      truncated = true;
      continue;
    }
    if (count >= MAX_RESPONSE_HEADERS) {
      truncated = true;
      continue;
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    if (text.length > MAX_HEADER_VALUE_BYTES) {
      truncated = true;
      result[name] = text.slice(0, MAX_HEADER_VALUE_BYTES);
    } else {
      result[name] = text;
    }
    count += 1;
  }
  return { headers: result, truncated };
}

async function defaultResolveDns(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((result) => result.address);
}

/** The fixed, server-shipped child bootstrap. Never routine content. It
 * captures the modules it needs (module loading is not gated by the
 * permission model; the syscalls are), neuters the six process internals
 * with non-configurable throwing getters, removes eval, the Function
 * constructor, WebAssembly, require/module/exports and process itself,
 * installs the console/timer/fetch/state shims, and runs the script inside
 * a vm.compileFunction wrapper whose importModuleDynamically hook rejects
 * dynamic import (a plain Function constructor leaves import() working).
 * Written as an array of plain double-quoted lines so nothing here can
 * interpolate by accident. */
const BOOTSTRAP_LINES: readonly string[] = [
  "\"use strict\";",
  "(function () {",
  "  // Capture host modules and intrinsics BEFORE neutering.",
  "  var proc = globalThis.process;",
  "  var fsModule = require(\"node:fs\");",
  "  var vmModule = require(\"node:vm\");",
  "  var netModule = require(\"node:net\");",
  "  var childModule = require(\"node:child_process\");",
  "  var Promise_ = globalThis.Promise;",
  "  var promiseResolve = Promise_.resolve.bind(Promise_);",
  "  var promiseReject = Promise_.reject.bind(Promise_);",
  "  var promiseThen = Promise_.prototype.then;",
  "  var JSON_ = globalThis.JSON;",
  "  var String_ = globalThis.String;",
  "  var Error_ = globalThis.Error;",
  "  var Object_ = globalThis.Object;",
  "  var Map_ = globalThis.Map;",
  "  var Set_ = globalThis.Set;",
  "  var setTimeout_ = globalThis.setTimeout;",
  "  var clearTimeout_ = globalThis.clearTimeout;",
  "  var rawFetch = globalThis.fetch;",
  "  // Node loads undici's module graph lazily on the first fetch call, and",
  "  // that graph references the Function global while loading. Warm it now,",
  "  // before neutering, so later rawFetch probes (the canary) cannot die on",
  "  // the removed intrinsic. The warm-up connects nowhere: the permission",
  "  // model denies it and the rejection is swallowed.",
  "  try { rawFetch(\"http://127.0.0.1:1\").catch(function () {}); } catch (error) { /* best-effort */ }",
  "  var writeSyncFd = fsModule.writeSync;",
  "  var readFileSyncProbe = fsModule.readFileSync;",
  "  var spawnSyncProbe = childModule.spawnSync;",
  "  var connectProbe = netModule.connect;",
  "",
  "  var manifest = null;",
  "  var settled = false;",
  "  var nextFrameId = 1;",
  "  var fetches = new Map_();",
  "  var stateAcks = new Map_();",
  "  var stateData = null;",
  "  var logs = [];",
  "  var warnings = [];",
  "  var logBytes = 0;",
  "  var logTruncated = false;",
  "  var activeTimers = new Set_();",
  "",
  "  function writeLine(fd, payload) {",
  "    writeSyncFd(fd, JSON_.stringify(payload) + \"\\n\");",
  "  }",
  "",
  "  function errorText(error) {",
  "    var text = error && error.stack ? error.stack : String_(error);",
  "    if (typeof text !== \"string\") text = String_(text);",
  "    return text.length > 8192 ? text.slice(0, 8192) : text;",
  "  }",
  "",
  "  function envelope(ok, rest) {",
  "    var payload = { ok: ok, logs: logs, warnings: warnings, logTruncated: logTruncated };",
  "    if (rest) {",
  "      var names = Object_.keys(rest);",
  "      for (var i = 0; i < names.length; i++) payload[names[i]] = rest[names[i]];",
  "    }",
  "    return payload;",
  "  }",
  "",
  "  function finish(payload) {",
  "    if (settled) return;",
  "    settled = true;",
  "    var encoded = null;",
  "    try { encoded = JSON_.stringify(payload); } catch (error) { encoded = null; }",
  "    if (typeof encoded !== \"string\" || encoded.length > 65536) {",
  "      encoded = JSON_.stringify({ ok: false, error: \"script result exceeds the 64 KiB envelope cap\", logs: [], warnings: [], logTruncated: false });",
  "    }",
  "    writeSyncFd(1, encoded + \"\\n\");",
  "    proc.exit(0);",
  "  }",
  "",
  "  function recordLog(level, args) {",
  "    if (logTruncated) return;",
  "    var parts = [];",
  "    for (var i = 0; i < args.length; i++) {",
  "      var value = args[i];",
  "      if (typeof value === \"string\") parts.push(value);",
  "      else {",
  "        try { parts.push(JSON_.stringify(value)); }",
  "        catch (error) { parts.push(String_(value)); }",
  "      }",
  "    }",
  "    var line = level + \" \" + parts.join(\" \");",
  "    logs.push(line);",
  "    logBytes += line.length + 1;",
  "    var dropped = false;",
  "    while (logs.length > 256) { logBytes -= logs.shift().length + 1; dropped = true; }",
  "    while (logBytes > 65536 && logs.length > 1) { logBytes -= logs.shift().length + 1; dropped = true; }",
  "    if (dropped) logTruncated = true;",
  "  }",
  "",
  "  var consoleShim = {",
  "    log: function () { recordLog(\"log\", arguments); },",
  "    info: function () { recordLog(\"info\", arguments); },",
  "    warn: function () { recordLog(\"warn\", arguments); },",
  "    error: function () { recordLog(\"error\", arguments); },",
  "    debug: function () { recordLog(\"debug\", arguments); },",
  "  };",
  "",
  "  function neuterProcessSurface(name) {",
  "    try { delete proc[name]; } catch (error) { /* already gone */ }",
  "    Object_.defineProperty(proc, name, {",
  "      configurable: false,",
  "      enumerable: false,",
  "      get: function () {",
  "        var error = new Error_(\"access denied: process.\" + name + \" is neutered in the scripted routine sandbox\");",
  "        error.code = \"ERR_ACCESS_DENIED\";",
  "        throw error;",
  "      },",
  "    });",
  "  }",
  "  neuterProcessSurface(\"_linkedBinding\");",
  "  neuterProcessSurface(\"binding\");",
  "  neuterProcessSurface(\"dlopen\");",
  "  neuterProcessSurface(\"_debugProcess\");",
  "  neuterProcessSurface(\"kill\");",
  "  neuterProcessSurface(\"abort\");",
  "",
  "  Object_.defineProperty(globalThis.Error, \"prepareStackTrace\", {",
  "    configurable: false,",
  "    enumerable: false,",
  "    get: function () { return undefined; },",
  "    set: function () { /* swallowed */ },",
  "  });",
  "",
  "  delete globalThis.require;",
  "  delete globalThis.module;",
  "  delete globalThis.exports;",
  "  delete globalThis.eval;",
  "  delete globalThis.Function;",
  "  delete globalThis.WebAssembly;",
  "  delete globalThis.fetch;",
  "  globalThis.process = undefined;",
  "",
  "  // delete removes only the global binding; (function(){}).constructor",
  "  // and the async/generator variants still reach their constructors,",
  "  // which are all dynamic-eval equivalents. Block every one.",
  "  function blockFunctionConstructor(prototype, label) {",
  "    Object_.defineProperty(prototype, \"constructor\", {",
  "      configurable: false,",
  "      enumerable: false,",
  "      get: function () {",
  "        var error = new Error_(\"access denied: the \" + label + \" constructor is neutered in the scripted routine sandbox\");",
  "        error.code = \"ERR_ACCESS_DENIED\";",
  "        throw error;",
  "      },",
  "      set: function () { /* swallowed */ },",
  "    });",
  "  }",
  "  blockFunctionConstructor(Object_.getPrototypeOf(function () {}), \"Function\");",
  "  blockFunctionConstructor(Object_.getPrototypeOf(async function () {}), \"AsyncFunction\");",
  "  blockFunctionConstructor(Object_.getPrototypeOf(function* () {}), \"GeneratorFunction\");",
  "  blockFunctionConstructor(Object_.getPrototypeOf(async function* () {}), \"AsyncGeneratorFunction\");",
  "",
  "  function uncaught(error) {",
  "    if (settled) return;",
  "    finish(envelope(false, { error: errorText(error) }));",
  "  }",
  "  proc.on(\"uncaughtException\", function (error) { uncaught(error); });",
  "  proc.on(\"unhandledRejection\", function (error) { uncaught(error); });",
  "",
  "  globalThis.setTimeout = function (callback, delay) {",
  "    if (activeTimers.size >= 32) {",
  "      throw new Error_(\"scripted routine timer cap reached (32 outstanding timers)\");",
  "    }",
  "    var timer = setTimeout_(function () {",
  "      activeTimers.delete(timer);",
  "      try { callback(); }",
  "      catch (error) { uncaught(error); }",
  "    }, Math.max(0, Math.min(delay === undefined ? 0 : Number(delay) || 0, 2147483647)));",
  "    activeTimers.add(timer);",
  "    return timer;",
  "  };",
  "  globalThis.clearTimeout = function (timer) {",
  "    if (timer === undefined || timer === null) return;",
  "    activeTimers.delete(timer);",
  "    clearTimeout_(timer);",
  "  };",
  "  globalThis.console = consoleShim;",
  "",
  "  function fetchShim(input, init) {",
  "    init = init || {};",
  "    var url;",
  "    if (typeof input === \"string\") url = input;",
  "    else if (input && typeof input.url === \"string\") url = input.url;",
  "    else url = String_(input);",
  "    var method = \"GET\";",
  "    if (typeof init.method === \"string\") method = init.method;",
  "    else if (input && typeof input.method === \"string\") method = input.method;",
  "    method = method.toUpperCase();",
  "    var headers = {};",
  "    var source = init.headers !== undefined && init.headers !== null ? init.headers : (input && typeof input === \"object\" ? input.headers : undefined);",
  "    if (source && typeof source === \"object\") {",
  "      var names = Object_.keys(source);",
  "      for (var i = 0; i < names.length; i++) headers[names[i]] = String_(source[names[i]]);",
  "    }",
  "    var body = init.body !== undefined ? init.body : (input && typeof input === \"object\" ? input.body : undefined);",
  "    if (body !== undefined && body !== null && typeof body !== \"string\") body = String_(body);",
  "    var optional = init.optional === true;",
  "    var id = nextFrameId++;",
  "    var frame = { id: id, type: \"fetch\", method: method, url: url, headers: headers, optional: optional };",
  "    if (body !== undefined) frame.body = body;",
  "    writeLine(3, frame);",
  "    return new Promise_(function (resolve, reject) {",
  "      fetches.set(id, { resolve: resolve, reject: reject });",
  "    });",
  "  }",
  "  globalThis.fetch = fetchShim;",
  "",
  "  var stateShim = {",
  "    get: function () { return stateData; },",
  "    put: function (value) {",
  "      var id = nextFrameId++;",
  "      writeLine(3, { id: id, type: \"state-put\", value: value === undefined ? null : value });",
  "      return new Promise_(function (resolve, reject) {",
  "        stateAcks.set(id, { resolve: resolve, reject: reject });",
  "      });",
  "    },",
  "  };",
  "",
  "  function hostMessage(message) {",
  "    if (message && message.type === \"fetch-response\") {",
  "      var pending = fetches.get(message.id);",
  "      fetches.delete(message.id);",
  "      if (!pending) return;",
  "      if (message.ok === true) {",
  "        var bodyText = typeof message.body === \"string\" ? message.body : \"\";",
  "        var headers = {};",
  "        if (message.headers && typeof message.headers === \"object\") {",
  "          var names = Object_.keys(message.headers);",
  "          for (var i = 0; i < names.length; i++) headers[names[i]] = String_(message.headers[names[i]]);",
  "        }",
  "        var response = {",
  "          ok: message.status >= 200 && message.status < 300,",
  "          status: message.status,",
  "          headers: headers,",
  "          body: bodyText,",
  "          truncated: message.truncated === true,",
  "          text: function () { return promiseResolve(bodyText); },",
  "          json: function () {",
  "            try { return promiseResolve(JSON_.parse(bodyText)); }",
  "            catch (error) { return promiseReject(error); }",
  "          },",
  "        };",
  "        pending.resolve(response);",
  "      } else {",
  "        var fetchError = new Error_(\"fetch failed: \" + (typeof message.error === \"string\" ? message.error : \"unknown error\"));",
  "        fetchError.name = \"ScriptedFetchError\";",
  "        pending.reject(fetchError);",
  "      }",
  "      return;",
  "    }",
  "    if (message && message.type === \"state-put-ack\") {",
  "      var ack = stateAcks.get(message.id);",
  "      stateAcks.delete(message.id);",
  "      if (!ack) return;",
  "      if (message.ok === true) {",
  "        stateData = message.value === undefined ? null : message.value;",
  "        ack.resolve(stateData);",
  "      }",
  "      else ack.reject(new Error_(typeof message.error === \"string\" ? message.error : \"state put failed\"));",
  "      return;",
  "    }",
  "  }",
  "",
  "  var stdinBuffer = \"\";",
  "  proc.stdin.setEncoding(\"utf8\");",
  "  proc.stdin.on(\"data\", function (chunk) {",
  "    if (settled) return;",
  "    stdinBuffer += chunk;",
  "    for (;;) {",
  "      var newline = stdinBuffer.indexOf(\"\\n\");",
  "      if (newline < 0) break;",
  "      var line = stdinBuffer.slice(0, newline);",
  "      stdinBuffer = stdinBuffer.slice(newline + 1);",
  "      var message = null;",
  "      try { message = JSON_.parse(line); } catch (error) { message = null; }",
  "      if (message === null || typeof message !== \"object\") {",
  "        finish(envelope(false, { error: \"host channel sent an invalid frame\" }));",
  "        return;",
  "      }",
  "      if (manifest === null) {",
  "        manifest = message;",
  "        if (message.canary === true) startCanary();",
  "        else startScript(message);",
  "        if (settled) return;",
  "        continue;",
  "      }",
  "      hostMessage(message);",
  "      if (settled) return;",
  "    }",
    `    if (stdinBuffer.length > ${HOST_CHANNEL_MAX_BYTES}) {`,
    `      finish(envelope(false, { error: "host channel line exceeds the ${Math.round(HOST_CHANNEL_MAX_BYTES / (1024 * 1024))} MiB worst-case frame cap (a 2 MiB body can expand sixfold under JSON escaping)" }));`,
  "    }",
  "  });",
  "  proc.stdin.on(\"end\", function () {",
  "    if (settled) return;",
  "    finish(envelope(false, { error: manifest === null ? \"host channel closed before the run started\" : \"host channel closed before the run finished\" }));",
  "  });",
  "  proc.stdin.on(\"error\", function () { /* the end path reports the close */ });",
  "",
  "  var WRAPPER_PARAMS = [\"process\", \"require\", \"module\", \"exports\", \"globalThis\", \"eval\", \"Function\", \"WebAssembly\", \"fetch\", \"state\", \"console\", \"setTimeout\", \"clearTimeout\"];",
  "  var WRAPPER_PREFIX = [\"return (function () {\", \"\\\"use strict\\\";\", \"return (async function () {\", \"\"].join(\"\\n\");",
  "  var WRAPPER_SUFFIX = [\"\", \"}).call(this);\", \"})();\", \"\"].join(\"\\n\");",
  "",
  "  function importModuleDynamically() {",
  "    throw new Error_(\"dynamic import is disabled in the scripted routine sandbox\");",
  "  }",
  "",
  "  function startScript(message) {",
  "    stateData = message.state === undefined ? null : message.state;",
  "    var source = message.script && typeof message.script.source === \"string\" ? message.script.source : \"\";",
  "    var wrapper;",
  "    try {",
  "      wrapper = vmModule.compileFunction(WRAPPER_PREFIX + source + WRAPPER_SUFFIX, WRAPPER_PARAMS, { importModuleDynamically: importModuleDynamically });",
  "    } catch (error) {",
  "      finish(envelope(false, { error: \"script compile error: \" + errorText(error) }));",
  "      return;",
  "    }",
  "    var result;",
  "    try {",
  "      result = wrapper(undefined, undefined, undefined, undefined, globalThis, undefined, undefined, undefined, globalThis.fetch, stateShim, consoleShim, globalThis.setTimeout, globalThis.clearTimeout);",
  "    } catch (error) {",
  "      finish(envelope(false, { error: errorText(error) }));",
  "      return;",
  "    }",
  "    promiseThen.call(",
  "      result,",
  "      function (value) { finish(envelope(true, { value: value === undefined ? null : value })); },",
  "      function (error) { finish(envelope(false, { error: errorText(error) })); }",
  "    );",
  "  }",
  "",
  "  function probeNet() {",
  "    return new Promise_(function (resolve) {",
  "      var reported = false;",
  "      var socket = connectProbe(54321, \"127.0.0.1\");",
  "      var report = function (denied, code) {",
  "        if (reported) return;",
  "        reported = true;",
  "        try { socket.destroy(); } catch (error) { /* dead */ }",
  "        clearTimeout_(timeout);",
  "        resolve({ denied: denied, code: code });",
  "      };",
  "      var timeout = setTimeout_(function () { report(false, \"probe_timeout\"); }, 3000);",
  "      socket.on(\"error\", function (error) {",
  "        report(error && error.code === \"ERR_ACCESS_DENIED\", error && error.code ? error.code : \"error\");",
  "      });",
  "      socket.on(\"connect\", function () { report(false, \"connected\"); });",
  "    });",
  "  }",
  "",
  "  function probeFetch() {",
  "    return promiseThen.call(",
  "      rawFetch(\"http://127.0.0.1:54321\"),",
  "      function () { return { denied: false, code: \"fetch_succeeded\" }; },",
  "      function (error) {",
  "        var code = error && error.cause && error.cause.code ? error.cause.code : (error && error.code ? error.code : \"error\");",
  "        return { denied: code === \"ERR_ACCESS_DENIED\", code: code };",
  "      }",
  "    );",
  "  }",
  "",
  "  function probeDynamicImport() {",
  "    var probe = vmModule.compileFunction(\"return import(\\\"node:fs\\\")\", [], { importModuleDynamically: importModuleDynamically });",
  "    return promiseThen.call(",
  "      probe(),",
  "      function () { return { blocked: false, code: \"import_succeeded\" }; },",
  "      function (error) { return { blocked: true, code: errorText(error).slice(0, 200) }; }",
  "    );",
  "  }",
  "",
  "  function startCanary() {",
  "    var checks = {};",
  "    var diagnostics = {};",
  "    var internalNames = [\"_linkedBinding\", \"binding\", \"dlopen\", \"_debugProcess\", \"kill\", \"abort\"];",
  "    var internalsThrow = true;",
  "    for (var i = 0; i < internalNames.length; i++) {",
  "      try {",
  "        void proc[internalNames[i]];",
  "        internalsThrow = false;",
  "        diagnostics[\"internal_\" + internalNames[i]] = \"accessible\";",
  "      } catch (error) {",
  "        diagnostics[\"internal_\" + internalNames[i]] = error && error.code ? error.code : \"threw\";",
  "      }",
  "    }",
  "    checks.process_internals_throw = internalsThrow;",
  "    try {",
  "      readFileSyncProbe(proc.execPath);",
  "      checks.fs_denied = false;",
  "      diagnostics.fs = \"read_succeeded\";",
  "    } catch (error) {",
  "      checks.fs_denied = error && error.code === \"ERR_ACCESS_DENIED\";",
  "      diagnostics.fs = error && error.code ? error.code : \"threw\";",
  "    }",
  "    try {",
  "      spawnSyncProbe(proc.execPath, [\"-v\"]);",
  "      checks.spawn_denied = false;",
  "      diagnostics.spawn = \"spawn_succeeded\";",
  "    } catch (error) {",
  "      checks.spawn_denied = error && error.code === \"ERR_ACCESS_DENIED\";",
  "      diagnostics.spawn = error && error.code ? error.code : \"threw\";",
  "    }",
  "    checks.eval_removed = typeof globalThis.eval === \"undefined\";",
  "    checks.function_removed = typeof globalThis.Function === \"undefined\";",
  "    checks.wasm_removed = typeof globalThis.WebAssembly === \"undefined\";",
  "    checks.process_removed = globalThis.process === undefined;",
  "    checks.require_removed = typeof globalThis.require === \"undefined\";",
  "    var ctorBlocked = true;",
  "    try { void (function () {}).constructor; ctorBlocked = false; } catch (error) { /* blocked */ }",
  "    try { void (async function () {}).constructor; ctorBlocked = false; } catch (error) { /* blocked */ }",
  "    try { void (function* () {}).constructor; ctorBlocked = false; } catch (error) { /* blocked */ }",
  "    try { void (async function* () {}).constructor; ctorBlocked = false; } catch (error) { /* blocked */ }",
  "    checks.function_ctor_blocked = ctorBlocked;",
  "    var chain = promiseThen.call(probeNet(), function (netResult) {",
  "      checks.net_denied = netResult.denied;",
  "      diagnostics.net = netResult.code;",
  "      return probeFetch();",
  "    });",
  "    chain = promiseThen.call(chain, function (fetchResult) {",
  "      checks.fetch_denied = fetchResult.denied;",
  "      diagnostics.fetch = fetchResult.code;",
  "      return probeDynamicImport();",
  "    });",
  "    chain = promiseThen.call(chain, function (importResult) {",
  "      checks.dynamic_import_blocked = importResult.blocked;",
  "      diagnostics.dynamic_import = importResult.code;",
  "      return { checks: checks, diagnostics: diagnostics, envKeys: Object_.keys(proc.env) };",
  "    });",
  "    promiseThen.call(chain, function (value) {",
  "      finish({ ok: true, value: value, logs: [], warnings: [], logTruncated: false });",
  "    }, function (error) {",
  "      finish(envelope(false, { error: \"canary failed: \" + errorText(error) }));",
  "    });",
  "  }",
  "})();",
];

const BOOTSTRAP_SOURCE = BOOTSTRAP_LINES.join("\n");

interface ScriptedSessionInit {
  manifest: unknown;
  script: ScriptedRoutineScript;
  statePath: string;
  resolveCredential?: (credentialId: string) => string | undefined;
  resolveDns: (host: string) => Promise<string[]>;
  timeoutMs: number;
  /** null disables the RSS watchdog (canary only). */
  rssLimitBytes: number | null;
  bootstrapSource: string;
}

type HopResult =
  | { type: "response"; status: number; headers: http.IncomingHttpHeaders; body: string }
  | { type: "redirect"; status: number; location: string }
  | { type: "error"; message: string; fatal?: ScriptedRunFailure };

/** One scripted run: one child, its framed channels, budgets, timers and
 * receipt. Everything the child emits is hostile input; every policy
 * decision is re-derived here from the routine record. */
class ScriptedRunSession {
  readonly done: Promise<ScriptedRunOutcome>;
  private readonly child: ChildProcess;
  private readonly script: ScriptedRoutineScript;
  private readonly statePath: string;
  private readonly resolveCredential: ((credentialId: string) => string | undefined) | undefined;
  private readonly resolveDns: (host: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly rssLimitBytes: number | null;
  private readonly startedAt = Date.now();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly requests = new Map<number, http.ClientRequest>();
  private readonly outstanding = new Set<number>();
  private readonly warnings: string[] = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private resolveDone!: (outcome: ScriptedRunOutcome) => void;
  private resultEnvelope: ResultEnvelope | null = null;
  private failure: ScriptedRunFailure | null = null;
  private stderrTail = "";
  private totalRequests = 0;
  private exited = false;

  constructor(init: ScriptedSessionInit) {
    this.script = init.script;
    this.statePath = init.statePath;
    this.resolveCredential = init.resolveCredential;
    this.resolveDns = init.resolveDns;
    this.timeoutMs = init.timeoutMs;
    this.rssLimitBytes = init.rssLimitBytes;
    this.done = new Promise<ScriptedRunOutcome>((resolve) => {
      this.resolveDone = resolve;
    });

    // Constants-only argv and a scrubbed env: an inherited NODE_OPTIONS such
    // as --allow-fs-read=/ dissolves the permission fence entirely (Red Team
    // replay), so nothing is inherited except TZ.
    const env: Record<string, string> = {};
    if (process.env.TZ !== undefined) env.TZ = process.env.TZ;
    this.child = spawn(
      process.execPath,
      ["--permission", "--max-old-space-size=256", "-e", init.bootstrapSource],
      { env, stdio: ["pipe", "pipe", "pipe", "pipe"], windowsHide: true },
    );
    activeRuns.add(this);

    const stdoutReader = new FramedLineReader(
      ENVELOPE_READER_MAX_BYTES,
      (line) => this.handleResultLine(line),
      () => {
        this.fatal({ kind: "crash", detail: "result envelope exceeds the " + ENVELOPE_MAX_BYTES + " byte cap" });
      },
    );
    this.child.stdout?.on("data", (chunk: Buffer) => stdoutReader.push(chunk));

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_MAX_BYTES);
    });
    // A child that dies mid-write fails the stream asynchronously (EPIPE);
    // without a listener that error is uncaught and takes the server down.
    // The close path owns the receipt.
    this.child.stdin?.on("error", () => { /* the close path reports the exit */ });

    const shimInput = this.child.stdio?.[3] as Readable | null | undefined;
    const shimReader = new FramedLineReader(
      FRAME_MAX_BYTES,
      (line) => this.handleShimLine(line),
      () => {
        this.fatal({ kind: "crash", detail: "shim_frame_limit: shim frame exceeds the 256 KiB cap while buffering" });
      },
    );
    shimInput?.on("data", (chunk: Buffer) => shimReader.push(chunk));

    this.child.on("error", (error) => {
      this.failure = this.failure ?? { kind: "crash", detail: "spawn_failed: " + errorText(error) };
      this.settle(null);
    });
    this.child.on("close", (code) => this.settle(code));

    try {
      this.child.stdin?.write(JSON.stringify(init.manifest) + "\n");
    } catch {
      // Child died before the manifest landed; the close path reports it.
    }

    const timeoutTimer = setTimeout(() => {
      if (this.exited) return;
      this.failure = this.failure ?? {
        kind: "timeout",
        detail: "script exceeded the " + Math.round(this.timeoutMs / 1000) + "s timeout",
      };
      this.killChild("SIGTERM");
    }, this.timeoutMs);
    timeoutTimer.unref?.();
    this.timers.push(timeoutTimer);

    // Everything is bounded by the wall clock even if an RSS sample is missed.
    const backstop = setTimeout(() => {
      if (this.exited) return;
      this.failure = this.failure ?? { kind: "crash", detail: "hard backstop elapsed" };
      this.killChild("SIGKILL");
    }, Math.max(this.timeoutMs + 10_000, 30_000));
    backstop.unref?.();
    this.timers.push(backstop);

    if (init.rssLimitBytes !== null) {
      this.watchdog = setInterval(() => {
        void this.sampleRss().then((rss) => {
          if (rss === null || this.exited || this.rssLimitBytes === null) return;
          if (rss > this.rssLimitBytes) {
            this.failure = this.failure ?? {
              kind: "crash",
              detail: "rss_limit: child RSS " + rss + " bytes exceeded the " + this.rssLimitBytes + " byte limit",
            };
            this.killChild("SIGTERM");
          }
        }).catch(() => { /* sampling is best-effort */ });
      }, RSS_SAMPLE_INTERVAL_MS);
      this.watchdog.unref?.();
    }
  }

  abort(reason: string): void {
    if (this.exited) return;
    this.failure = this.failure ?? { kind: "crash", detail: reason };
    this.killChild("SIGTERM");
  }

  private handleResultLine(line: string): void {
    if (this.resultEnvelope !== null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.fatal({ kind: "crash", detail: "result line is not valid JSON" });
      return;
    }
    const parsed = resultEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.fatal({ kind: "crash", detail: "result envelope failed validation" });
      return;
    }
    this.resultEnvelope = parsed.data;
    // N-4: the result line is terminal for the whole protocol. Stop
    // servicing the shim channel, then expect the child to exit quickly.
    const grace = setTimeout(() => {
      if (this.exited) return;
      this.failure = this.failure ?? {
        kind: "crash",
        detail: "post_result_linger: child kept running after reporting its result",
      };
      this.killChild("SIGTERM");
    }, KILL_GRACE_MS);
    grace.unref?.();
    this.timers.push(grace);
  }

  private handleShimLine(line: string): void {
    if (this.resultEnvelope !== null || this.exited) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.fatal({ kind: "crash", detail: "shim_frame_invalid: frame is not valid JSON" });
      return;
    }
    const type = (raw as { type?: unknown } | null)?.type;
    if (type === "fetch") {
      const parsed = fetchFrameSchema.safeParse(raw);
      if (!parsed.success) {
        this.fatal({ kind: "crash", detail: "shim_frame_invalid: fetch frame failed validation" });
        return;
      }
      this.handleFetchFrame(parsed.data);
      return;
    }
    if (type === "state-put") {
      const parsed = statePutFrameSchema.safeParse(raw);
      if (!parsed.success) {
        this.fatal({ kind: "crash", detail: "shim_frame_invalid: state frame failed validation" });
        return;
      }
      this.handleStatePut(parsed.data);
      return;
    }
    this.fatal({ kind: "crash", detail: "shim_frame_invalid: unknown frame type" });
  }

  private sendToChild(payload: Record<string, unknown>): void {
    if (this.resultEnvelope !== null || this.exited) return;
    try {
      this.child.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      // Child already gone; the close path reports it.
    }
  }

  private fatal(failure: ScriptedRunFailure): void {
    if (this.exited) return;
    if (this.failure === null) this.failure = failure;
    this.killChild("SIGTERM");
  }

  private killChild(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // Already dead; the close path owns the receipt.
    }
    if (signal === "SIGTERM") {
      const escalation = setTimeout(() => {
        if (this.exited) return;
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }, KILL_GRACE_MS);
      escalation.unref?.();
      this.timers.push(escalation);
    }
  }

  private handleFetchFrame(frame: FetchFrame): void {
    if (this.totalRequests >= MAX_TOTAL_REQUESTS) {
      this.fatal({
        kind: "request_limit",
        detail: "request budget exceeded: total (" + MAX_TOTAL_REQUESTS + " requests per run)",
      });
      return;
    }
    if (this.outstanding.size >= MAX_OUTSTANDING_REQUESTS) {
      this.fatal({
        kind: "request_limit",
        detail: "request budget exceeded: outstanding (" + MAX_OUTSTANDING_REQUESTS + " concurrent requests)",
      });
      return;
    }
    this.totalRequests += 1;
    this.outstanding.add(frame.id);
    void this.performFetch(frame).catch((error) => {
      this.fatal({ kind: "crash", detail: "host_error in fetch pipeline: " + errorText(error).slice(0, 500) });
    });
  }

  /** N-4: the result envelope and child exit are both terminal for the
   * whole protocol; nothing further is serviced on any channel. */
  private isSettled(): boolean {
    return this.exited || this.resultEnvelope !== null;
  }

  private async performFetch(frame: FetchFrame): Promise<void> {
    try {
      await this.performFetchLocked(frame);
    } finally {
      this.outstanding.delete(frame.id);
      this.requests.delete(frame.id);
    }
  }

  private async performFetchLocked(frame: FetchFrame): Promise<void> {
    // The outstanding slot and the request registry cover the WHOLE fetch
    // including every redirect hop (N-3): admitted at the frame gate,
    // released only at a terminal, so a mid-chain hop can never free
    // budget for a fifth concurrent frame.
    const respondError = (message: string): void => {
      this.sendToChild({ id: frame.id, type: "fetch-response", ok: false, error: message.slice(0, 2000) });
    };
    const deny = (detail: string, deniedHost?: string): void => {
      if (frame.optional === true) {
        this.warnings.push("optional fetch denied: " + detail);
        respondError(detail);
        return;
      }
      const failure: ScriptedRunFailure = {
        kind: "policy_violation",
        detail,
        ...(deniedHost !== undefined ? { deniedHost } : {}),
      };
      this.fatal(failure);
    };

    let url: URL;
    try {
      url = new URL(frame.url);
    } catch {
      return respondError("invalid URL: " + frame.url.slice(0, 200));
    }
    let method = frame.method;
    let body = frame.body ?? null;
    let redirectBudget = MAX_REDIRECTS;

    for (;;) {
      const host = normalizeAllowlistHost(url.hostname);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return deny("non-http(s) scheme denied: " + url.protocol, host);
      }
      if (url.username !== "" || url.password !== "") {
        return deny("userinfo URLs are not allowed", host);
      }
      const entry = this.script.networkAllowlist?.find(
        (candidate) => normalizeAllowlistHost(candidate.host) === host,
      );
      if (!entry) {
        return deny("host is not in the reviewed network allowlist: " + host, host);
      }
      const allowedScheme = entry.scheme ?? "https";
      if ((url.protocol === "https:") !== (allowedScheme === "https")) {
        return deny(
          "scheme " + url.protocol.replace(":", "") + " is not allowed for " + host + " (entry allows " + allowedScheme + ")",
          host,
        );
      }
      const port = url.port === "" ? (allowedScheme === "https" ? 443 : 80) : Number.parseInt(url.port, 10);
      if (entry.port !== undefined && port !== entry.port) {
        return deny("port " + port + " is not allowed for " + host + " (entry declares " + entry.port + ")", host);
      }

      let addresses: string[];
      try {
        addresses = await this.resolveDns(host);
      } catch (error) {
        return respondError("dns lookup failed for " + host + ": " + errorText(error).slice(0, 300));
      }
      // Settled while DNS was in flight: no further hop may be minted.
      if (this.isSettled()) return;
      if (addresses.length === 0) {
        return respondError("dns lookup returned no addresses for " + host);
      }
      const normalized = addresses.map((address) => normalizeResolvedAddress(address));
      for (const address of normalized) {
        const range = deniedRangeFor(address, entry.allow);
        if (range !== null) {
          return deny(
            host + " resolves to " + address + " inside the denied " + range + " range without an entry opt-in",
            host,
          );
        }
      }
      const pinned = normalized[0]!;
      const family = isIPv4(pinned) ? 4 : 6;

      // Credentials are resolved host-side at call time, after DNS and
      // range validation, and re-derived on every redirect hop, so an
      // authorization can never ride cross-host — and never over plaintext
      // http to an external peer: https always qualifies, plain http only
      // for a pinned loopback address on an entry that reviewed the opt-in.
      let authorization: string | undefined;
      if (entry.credentialId !== undefined) {
        if (url.protocol !== "https:" && deniedRangeForAddress(pinned) !== "loopback") {
          return deny(
            "credential transport requires https or a pinned loopback address for " + host,
            host,
          );
        }
        const secret = this.resolveCredential?.(entry.credentialId);
        if (secret === undefined || secret === "") {
          this.warnings.push("credential not available: " + entry.credentialId);
          return respondError("credential not available: " + entry.credentialId);
        }
        authorization = secret;
      }

      const headers: Record<string, string> = {};
      const lowered = new Set<string>();
      for (const [name, value] of Object.entries(frame.headers ?? {})) {
        const lower = name.toLowerCase();
        if (REQUEST_STRIP_HEADERS.has(lower)) continue;
        if (lowered.size >= MAX_REQUEST_HEADERS) {
          this.warnings.push("request headers truncated to the first " + MAX_REQUEST_HEADERS + " entries");
          break;
        }
        lowered.add(lower);
        headers[name] = value.length > MAX_HEADER_VALUE_BYTES ? value.slice(0, MAX_HEADER_VALUE_BYTES) : value;
      }
      if (authorization !== undefined) headers["authorization"] = "Bearer " + authorization;
      if (!lowered.has("accept-encoding")) headers["accept-encoding"] = "identity";

      const hop = await this.performHop(url, method, body, headers, pinned, family, frame.id);
      // Settled mid-hop (result envelope or child exit): the fetch is
      // over; no response is sent and no further hop is minted (N-4).
      if (this.isSettled()) return;
      if (hop.type === "error") {
        if (hop.fatal) {
          this.fatal(hop.fatal);
          return;
        }
        return respondError(hop.message);
      }
      if (hop.type === "redirect") {
        if (redirectBudget <= 0) {
          return deny("redirect limit of " + MAX_REDIRECTS + " hops exceeded while fetching " + host, host);
        }
        redirectBudget -= 1;
        let next: URL;
        try {
          next = new URL(hop.location, url);
        } catch {
          return respondError("invalid redirect location: " + hop.location.slice(0, 200));
        }
        const methodChanges = hop.status === 303 ||
          ((hop.status === 301 || hop.status === 302) && method !== "GET" && method !== "HEAD");
        url = next;
        if (methodChanges) {
          method = "GET";
          body = null;
        }
        continue;
      }
      const sanitized = sanitizeResponseHeaders(hop.headers);
      this.sendToChild({
        id: frame.id,
        type: "fetch-response",
        ok: true,
        status: hop.status,
        headers: sanitized.headers,
        body: hop.body,
        truncated: sanitized.truncated,
      });
      return;
    }
  }

  private performHop(
    url: URL,
    method: string,
    body: string | null,
    headers: Record<string, string>,
    pinned: string,
    family: number,
    frameId: number,
  ): Promise<HopResult> {
    return new Promise<HopResult>((resolve) => {
      // Entry guard: a session that settled while DNS was in flight must
      // not mint a new request, and no hop may outlive the run's wall
      // clock (N-4) — the session kill paths remain the primary deadline.
      if (this.isSettled()) {
        resolve({ type: "error", message: "session settled before the hop started" });
        return;
      }
      const remainingMs = this.startedAt + this.timeoutMs - Date.now();
      if (remainingMs <= 0) {
        resolve({ type: "error", message: "session wall clock exhausted before the hop started" });
        return;
      }
      let finished = false;
      let hopTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: HopResult): void => {
        if (finished) return;
        finished = true;
        if (hopTimer !== null) clearTimeout(hopTimer);
        resolve(result);
      };
      const lib = url.protocol === "https:" ? https : http;
      const hasBody = body !== null;
      const requestHeaders: Record<string, string> = hasBody
        ? { ...headers, "content-length": String(Buffer.byteLength(body)) }
        : { ...headers };
      let request: http.ClientRequest;
      try {
        request = lib.request(url, {
          method,
          headers: requestHeaders,
          lookup: (_hostname: string, options: unknown, callback: (err: Error | null, address: string, family: number) => void) => {
            // Node >= 20 defaults to autoSelectFamily, which asks the lookup
            // for the all-addresses form; answer both shapes with the pinned
            // address so the validated address is the one dialed.
            if ((options as { all?: boolean } | null)?.all === true) {
              (callback as unknown as (err: Error | null, addresses: Array<{ address: string; family: number }>) => void)(
                null,
                [{ address: pinned, family }],
              );
              return;
            }
            callback(null, pinned, family);
          },
        }, (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (status >= 300 && status < 400 && typeof location === "string" && location !== "") {
            response.resume();
            finish({ type: "redirect", status, location });
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > RESPONSE_MAX_BYTES) {
              request.destroy();
              finish({
                type: "error",
                message: "response exceeds the 2 MiB cap",
                fatal: {
                  kind: "response_too_large",
                  detail: "response from " + url.host + " exceeds the 2 MiB cap",
                },
              });
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            finish({
              type: "response",
              status,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.on("error", (error) => {
            finish({ type: "error", message: "response failed: " + errorText(error).slice(0, 300) });
          });
        });
      } catch (error) {
        finish({ type: "error", message: "request setup failed: " + errorText(error).slice(0, 300) });
        return;
      }
      this.requests.set(frameId, request);
      request.on("error", (error) => {
        finish({ type: "error", message: "request failed: " + errorText(error).slice(0, 300) });
      });
      if (hasBody) request.write(body);
      request.end();
      hopTimer = setTimeout(() => {
        request.destroy();
        finish({ type: "error", message: "hop exceeded the session wall clock" });
      }, remainingMs);
      hopTimer.unref?.();
    });
  }

  private handleStatePut(frame: StatePutFrame): void {
    const value = frame.value === undefined ? null : frame.value;
    let encoded: string;
    try {
      encoded = JSON.stringify(value) ?? "null";
    } catch {
      this.fatal({ kind: "state_error", detail: "state put value is not JSON-serializable" });
      return;
    }
    if (encoded.length > STATE_MAX_BYTES) {
      this.fatal({
        kind: "state_error",
        detail: "state put exceeds the " + STATE_MAX_BYTES + " byte cap (" + encoded.length + " bytes)",
      });
      return;
    }
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileAtomic(this.statePath, encoded + "\n", { mode: 0o600 });
    } catch (error) {
      this.fatal({ kind: "state_error", detail: "state write failed: " + errorText(error).slice(0, 300) });
      return;
    }
    this.sendToChild({ id: frame.id, type: "state-put-ack", ok: true, value });
  }

  private async sampleRss(): Promise<number | null> {
    const pid = this.child.pid;
    if (pid === undefined) return null;
    if (process.platform === "linux") {
      try {
        const statm = readFileSync("/proc/" + pid + "/statm", "utf8").trim().split(/\s+/);
        const pages = Number.parseInt(statm[1] ?? "", 10);
        if (!Number.isFinite(pages)) return null;
        return pages * 4096;
      } catch {
        return null;
      }
    }
    if (process.platform === "darwin") {
      return await new Promise<number | null>((resolve) => {
        execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const kb = Number.parseInt(stdout.trim(), 10);
          resolve(Number.isFinite(kb) ? kb * 1024 : null);
        });
      });
    }
    if (process.platform === "win32") {
      return await new Promise<number | null>((resolve) => {
        execFile("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const match = /"([\d,]+)\s*K"/.exec(stdout);
          if (!match) {
            resolve(null);
            return;
          }
          const kb = Number.parseInt(match[1]!.replace(/,/g, ""), 10);
          resolve(Number.isFinite(kb) ? kb * 1024 : null);
        });
      });
    }
    return null;
  }

  private deriveFailure(exitCode: number | null): ScriptedRunFailure | null {
    const envelope = this.resultEnvelope;
    if (envelope === null) {
      const snippet = this.stderrTail.slice(-512).replace(/\s+/g, " ").trim();
      const code = exitCode === null ? "signal" : String(exitCode);
      return {
        kind: "crash",
        detail: "child exited (" + code + ") without a result envelope" + (snippet !== "" ? ": " + snippet : ""),
      };
    }
    if (envelope.ok && exitCode === 0) return null;
    if (!envelope.ok && exitCode === 0) {
      return { kind: "script_error", detail: (envelope.error ?? "script failed").slice(0, 2000) };
    }
    const code = exitCode === null ? "signal" : String(exitCode);
    return { kind: "crash", detail: "child exited (" + code + ") after reporting a result" };
  }

  private settle(exitCode: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const timer of this.timers) clearTimeout(timer);
    if (this.watchdog !== null) clearInterval(this.watchdog);
    for (const request of this.requests.values()) {
      try {
        request.destroy();
      } catch {
        // Already dead.
      }
    }
    this.requests.clear();
    try {
      this.child.stdin?.end();
    } catch {
      // Already dead.
    }
    activeRuns.delete(this);

    const failure = this.failure ?? this.deriveFailure(exitCode);
    const envelope = this.resultEnvelope;
    const warnings = [...this.warnings, ...(envelope?.warnings ?? [])];
    const outcome: ScriptedRunOutcome = failure === null
      ? {
          ok: true,
          value: envelope?.value === undefined ? null : envelope.value,
          logs: envelope?.logs ?? [],
          warnings,
          logTruncated: envelope?.logTruncated === true,
          exitCode,
          durationMs: Date.now() - this.startedAt,
          scriptVersion: this.script.version,
          deterministic: true,
        }
      : {
          ok: false,
          logs: envelope?.logs ?? [],
          warnings,
          logTruncated: envelope?.logTruncated === true,
          exitCode,
          durationMs: Date.now() - this.startedAt,
          scriptVersion: this.script.version,
          deterministic: true,
          failure,
        };
    this.resolveDone(outcome);
  }
}

const activeRuns = new Set<ScriptedRunSession>();

/** Server shutdown hook: aborts every in-flight scripted child and waits
 * for each run's receipt to settle, so no child or in-flight host request
 * outlives the caller's shutdown path. */
export async function abortAllScriptedRoutineRuns(): Promise<void> {
  const runs = Array.from(activeRuns);
  for (const run of runs) {
    run.abort("server_shutdown");
  }
  await Promise.allSettled(runs.map((run) => run.done));
}

const CANARY_CHECK_KEYS: readonly string[] = [
  "process_internals_throw",
  "fs_denied",
  "spawn_denied",
  "net_denied",
  "fetch_denied",
  "dynamic_import_blocked",
  "eval_removed",
  "function_removed",
  "function_ctor_blocked",
  "wasm_removed",
  "process_removed",
  "require_removed",
];

/** Env keys the child may legitimately carry: TZ is passed through
 * deliberately, and macOS's CoreFoundation runtime injects
 * __CF_USER_TEXT_ENCODING into every process after exec — it is not
 * inherited from the parent and carries no secret. Anything else, an
 * inherited NODE_OPTIONS included, means the env scrub failed. */
export const CANARY_ENV_ALLOWED = new Set(["TZ", "__CF_USER_TEXT_ENCODING"]);

const CANARY_SCRIPT: ScriptedRoutineScript = {
  source: "",
  version: createHash("sha256").update("", "utf8").digest("hex"),
  reviewState: "approved",
  networkAllowlist: [],
};

async function runCanaryOnce(): Promise<RuntimeCanaryOutcome> {
  const session = new ScriptedRunSession({
    manifest: { canary: true },
    script: CANARY_SCRIPT,
    statePath: join(os.tmpdir(), "omb-scripted-canary-state.json"),
    resolveDns: defaultResolveDns,
    timeoutMs: CANARY_TIMEOUT_MS,
    rssLimitBytes: null,
    bootstrapSource: BOOTSTRAP_SOURCE,
  });
  const outcome = await session.done;
  const failure = outcome.failure;
  if (!outcome.ok || outcome.value === null || typeof outcome.value !== "object") {
    return {
      ok: false,
      detail: "canary run failed: " + (failure ? failure.kind + ": " + failure.detail : "no value reported"),
    };
  }
  const value = outcome.value as Partial<RuntimeCanaryResult> & { checks?: Record<string, unknown>; envKeys?: unknown };
  const checks = typeof value.checks === "object" && value.checks !== null ? value.checks : {};
  const failed = CANARY_CHECK_KEYS.filter((key) => checks[key] !== true);
  const envKeys = Array.isArray(value.envKeys) ? value.envKeys.filter((key): key is string => typeof key === "string") : [];
  const leaked = envKeys.filter((key) => !CANARY_ENV_ALLOWED.has(key));
  const result: RuntimeCanaryResult = {
    checks: checks as Record<string, boolean>,
    diagnostics: typeof value.diagnostics === "object" && value.diagnostics !== null
      ? value.diagnostics as Record<string, string>
      : {},
    envKeys,
  };
  if (failed.length > 0 || leaked.length > 0) {
    return {
      ok: false,
      detail: "canary checks failed: " + (failed.length > 0 ? failed.join(", ") : "none") +
        (leaked.length > 0 ? "; unexpected env keys: " + leaked.join(", ") : ""),
      result,
    };
  }
  return { ok: true, result };
}

/** Memoized for the process lifetime, failures included: once the runtime
 * fails its canary every scripted run refuses until restart. */
let canaryPromise: Promise<RuntimeCanaryOutcome> | null = null;
function ensureRuntimeCanary(): Promise<RuntimeCanaryOutcome> {
  if (canaryPromise === null) canaryPromise = runCanaryOnce();
  return canaryPromise;
}

/** Fresh, non-memoized canary run for tests and build reports. */
export async function probeScriptedRuntime(): Promise<RuntimeCanaryOutcome> {
  return await runCanaryOnce();
}

function scriptHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Runs one reviewed scripted routine in the sandbox. Never throws: every
 * failure path comes back as an outcome with a receipt-shaped failure. */
export async function runScriptedRoutine(
  routine: { id: string; script?: ScriptedRoutineScript },
  options: ScriptedRoutineRunOptions = {},
): Promise<ScriptedRunOutcome> {
  const startedAt = Date.now();
  const script = routine.script;
  const quickFailure = (kind: ScriptedFailureKind, detail: string): ScriptedRunOutcome => ({
    ok: false,
    logs: [],
    warnings: [],
    logTruncated: false,
    exitCode: null,
    durationMs: Date.now() - startedAt,
    scriptVersion: script?.version ?? "",
    deterministic: true,
    failure: { kind, detail },
  });

  if (!script) return quickFailure("state_error", "routine has no scripted definition");
  if (script.reviewState !== "approved") {
    return quickFailure("policy_violation", "script_not_approved");
  }
  if (scriptHash(script.source) !== script.version) {
    return quickFailure("policy_violation", "script_version_mismatch");
  }
  // v1 is server-only: the Electron-embedded parent ships dark until its
  // packaged build passes the runtime canary (ADR section 10).
  if (process.versions.electron !== undefined) {
    return quickFailure("crash", "parent_mode_dark: scripted routines are disabled in Electron-embedded mode");
  }
  const canary = await ensureRuntimeCanary();
  if (!canary.ok) {
    return quickFailure("crash", "runtime_canary_failed: " + canary.detail);
  }
  if (!ROUTINE_ID_PATTERN.test(routine.id)) {
    return quickFailure("state_error", "routine id is not a safe state key");
  }

  const stateDir = options.stateDir ?? join(DATA_DIR, "routine-state");
  const statePath = join(stateDir, routine.id + ".json");
  let state: unknown = null;
  try {
    const raw = readFileSync(statePath, "utf8");
    if (raw.length > STATE_MAX_BYTES) {
      return quickFailure("state_error", "state file exceeds the " + STATE_MAX_BYTES + " byte cap");
    }
    state = JSON.parse(raw) as unknown;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      return quickFailure("state_error", "state file is unreadable or invalid JSON: " + errorText(error).slice(0, 300));
    }
  }

  const timeoutSeconds = Math.min(script.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const rssLimitBytes = Math.max(script.rssLimitBytes ?? DEFAULT_RSS_LIMIT_BYTES, MIN_RSS_LIMIT_BYTES);

    try {
      const session = new ScriptedRunSession({
      manifest: { script: { source: script.source }, state },
      script,
      statePath,
      resolveCredential: options.resolveCredential,
      resolveDns: options.resolveDns ?? defaultResolveDns,
      timeoutMs: timeoutSeconds * 1000,
      rssLimitBytes,
        bootstrapSource: options.bootstrapSource ?? BOOTSTRAP_SOURCE,
      });
      const abortSignal = options.abortSignal;
      if (abortSignal !== undefined) {
        if (abortSignal.aborted) {
          session.abort(abortReasonText(abortSignal));
        } else {
          abortSignal.addEventListener(
            "abort",
            () => session.abort(abortReasonText(abortSignal)),
            { once: true },
          );
        }
      }
      return await session.done;
  } catch (error) {
    return quickFailure("crash", "host_error: " + errorText(error).slice(0, 500));
  }
}
