// An agent whose own log, on stderr, says it can no longer run a turn: the turn waiting on it fails now, and the process
// is not used again, rather than the turn waiting out the five- and fifteen-minute silence guards.
//
// Adapted from pingdotgg/t3code@94baff19c65, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: apps/server/src/provider/antigravityAuthSupport.ts's stderr handler becomes a
// per-process watch the shared ACP runtime runs for any engine that names such lines. T3 also starts Google's packaged
// runtime with --alsologtostderr so those lines reach stderr; that flag is not passed here (it was not tried against
// the runtime this app pins), so the watch acts only on lines the runtime writes to stderr by itself.
import type { AcpHost } from "./host.ts";

export interface StderrFailure {
  /** A whole stderr line after which the process cannot run a turn. */
  line: RegExp;
  /** What the person is told. */
  message: string;
}

const MAX_LINE_CHARS = 64 * 1024;
const failed = new WeakMap<AcpHost, Error>();

export function watchStderrFailure(host: AcpHost, spec: StderrFailure): void {
  let partial = "";
  host.child.stderr.on("data", (chunk: string | Buffer) => {
    const lines = (partial + String(chunk)).split("\n");
    partial = lines.pop() ?? "";
    if (partial.length > MAX_LINE_CHARS) partial = "";
    if (failed.has(host) || !lines.some((line) => line.length <= MAX_LINE_CHARS && spec.line.test(line.replace(/\r$/u, "")))) return;
    const error = Object.assign(new Error(spec.message), { acpSessionFailure: true });
    failed.set(host, error);
    host.draining = true;
    for (const link of host.links) link.failAll(error);
  });
}

/** The failure this process's stderr reported, if any: a prompt it answered after that is not trusted. */
export function stderrFailureOf(host: AcpHost): Error | null {
  return failed.get(host) ?? null;
}

/** glog records from Google's packaged harness after which its ACP process can no longer run a turn (T3 Code's list). */
export const ANTIGRAVITY_HARNESS_FAILURE_LOG =
  /^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ (?:local_connection\.py:\d+\] harness stderr: Agent run failed:|server\.py:\d+\] (?:Failed to rebuild agent for session |Agent connection lost for session ))/;
