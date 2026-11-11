// The server's half of the Update server button. A server in a container cannot replace its own image, so it only leaves
// a file in the request folder its host gave it; root's deploy/update-runner.sh on the host sees the file, runs update.sh
// as an owner would and writes how that ended into the status folder, which this container sees read-only.
//
// SECURITY: the runner never reads the request file. Whatever is written here, the host runs root's copy of `update.sh`
// with no argument but the install's folder: the stable version, only when the running image's own label is older, a
// copy of the data first, a rollback when the new version is not healthy. No version, image, URL, flag or path from a
// client or from this server reaches the host. The route is an admin's only, but the folder is the server's user's:
// until the bots' sandbox is on for self-hosted servers, a bot can leave the same file, and gets that same update.
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerUpdateOutcome, ServerUpdateReason, ServerUpdateRun, ServerUpdateStatus } from "../shared/server-update.ts";
import { appendAdminAction, type AdminActor } from "./admin-activity.ts";
import { updateCommand, type InstallKind, type UpdateCheck } from "./update-check.ts";

/** Where a Docker install mounts the two folders (deploy/install.sh's compose.yaml, update-runner.sh's override):
 * `request` (writable) and `status` (read-only). OMB_SERVER_UPDATE_DIR names another place. */
export const SERVER_UPDATE_DIR = "/run/omb-update";
export const SERVER_UPDATE_DIR_ENV = "OMB_SERVER_UPDATE_DIR";
/** One request per five minutes; the runner on the host keeps its own, shorter gap. */
export const REQUEST_GAP_MS = 5 * 60_000;
/** A request the host has not taken by then is reported as never started, and may be made again. */
export const START_WAIT_MS = 2 * 60_000;
/** A run the host says is still going after this long was cut off (a reboot, a kill). */
const RUNNING_FOR_MS = 2 * 60 * 60_000;
/** How long the outcome of the last request is shown. */
const SHOWN_FOR_MS = 60 * 60_000;
const PENDING_FILE = "server-update.json";

const REASONS: readonly ServerUpdateReason[] = ["busy", "refused", "older", "held", "too-soon", "no-updater", "failed", "not-retried", "stale", "unreleased"];
export type HostResult = "updated" | "rolled-back" | "rollback-failed" | ServerUpdateReason;
const RESULTS: readonly HostResult[] = ["updated", "rolled-back", "rollback-failed", ...REASONS];

/** `release`: the running image is labelled with a released version (false for a build of main). */
export interface HostRunner { layout: "installer" | "compose"; dir: string; held: boolean; release: boolean }
export interface HostRun { run: number; state: "running" | "done"; result?: HostResult; at: number; version?: string }
export interface HostFacts {
  runner: HostRunner | null;
  /** This server can leave a file in the request folder. */
  writable: boolean;
  last: HostRun | null;
}

/** What this server asked for, kept in its data folder so the answer is known after the restart. */
export interface PendingUpdate {
  at: number;
  /** The runner's run number when it was asked: a higher one is this request's. */
  baseline: number;
  from: string;
}

function fields(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").slice(0, 4096).split("\n")) {
    const match = /^([a-z]+)=([^\n]*)$/.exec(line.trim());
    if (match && !out.has(match[1]!)) out.set(match[1]!, match[2]!);
  }
  return out;
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function parseRunner(text: string | null): HostRunner | null {
  const f = fields(text);
  const layout = f.get("layout");
  const dir = f.get("dir");
  if ((layout !== "installer" && layout !== "compose") || !dir || !/^\/[A-Za-z0-9/._-]{0,200}$/.test(dir)) return null;
  return { layout, dir, held: f.get("held") === "yes", release: f.get("release") !== "no" };
}

export function parseRun(text: string | null): HostRun | null {
  const f = fields(text);
  const run = Number(f.get("run"));
  const at = Number(f.get("at"));
  const state = f.get("state");
  const result = f.get("result") as HostResult | undefined;
  if (!/^\d{1,9}$/.test(f.get("run") ?? "") || !/^\d{1,12}$/.test(f.get("at") ?? "")) return null;
  if (state !== "running" && state !== "done") return null;
  if (state === "done" && !(result && RESULTS.includes(result))) return null;
  const version = f.get("version");
  return { run, state, at: at * 1000, ...(state === "done" ? { result } : {}), ...(version && /^\d+\.\d+\.\d+$/.test(version) ? { version } : {}) };
}

export function readHostFacts(dir: string | undefined): HostFacts {
  if (!dir) return { runner: null, writable: false, last: null };
  let writable = false;
  try {
    accessSync(join(dir, "request"), constants.W_OK);
    writable = true;
  } catch {
  }
  return { runner: parseRunner(readText(join(dir, "status", "runner"))), writable, last: parseRun(readText(join(dir, "status", "last"))) };
}

export function readPending(dataDir: string): PendingUpdate | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, PENDING_FILE), "utf8")) as Partial<PendingUpdate>;
    if (typeof raw.at !== "number" || typeof raw.baseline !== "number" || typeof raw.from !== "string") return null;
    return { at: raw.at, baseline: raw.baseline, from: raw.from };
  } catch {
    return null;
  }
}

function writePending(dataDir: string, pending: PendingUpdate): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, PENDING_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(pending), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function outcomeOf(result: HostResult | undefined, from: string, version: string): { outcome: ServerUpdateOutcome; reason?: ServerUpdateReason } {
  if (result === "updated") return { outcome: from === version ? "unchanged" : "updated" };
  if (result === "rolled-back" || result === "rollback-failed") return { outcome: result };
  return { outcome: "not-changed", reason: result ?? "failed" };
}

/** The last request and how it went, from what this server asked and what the host wrote since. */
export function runOf(pending: PendingUpdate | null, last: HostRun | null, version: string, now: number): ServerUpdateRun | undefined {
  if (!pending) return undefined;
  const base = { from: pending.from, at: pending.at };
  if (last && last.run > pending.baseline) {
    if (last.state === "running") {
      return now - last.at < RUNNING_FOR_MS ? { ...base, outcome: "running" } : { ...base, outcome: "not-changed", reason: "failed" };
    }
    if (now - last.at > SHOWN_FOR_MS) return undefined;
    return { ...base, to: version, ...(last.version ? { target: last.version } : {}), ...outcomeOf(last.result, pending.from, version) };
  }
  if (now - pending.at < START_WAIT_MS) return { ...base, outcome: "requested" };
  if (now - pending.at > SHOWN_FOR_MS) return undefined;
  return { ...base, outcome: "not-started" };
}

export function serverUpdateStatus(input: {
  install: InstallKind;
  check: UpdateCheck | null;
  facts: HostFacts;
  pending: PendingUpdate | null;
  version: string;
  activeTurns: number;
  now: number;
  /** The update check follows the stable channel, as update.sh does; with OMB_UPDATE_CHANNEL=newest it does not. */
  followsStable?: boolean;
}): ServerUpdateStatus {
  const { install, check, facts, pending, version, now } = input;
  const base = { current: version, available: check?.available === true, ...(check?.latest ? { latest: check.latest } : {}), activeTurns: input.activeTurns };
  if (install === "desktop" || install === "managed") return { ...base, mode: "none" };
  const runner = install === "docker" && facts.writable ? facts.runner : null;
  const run = runOf(pending, facts.last, version, now);
  const retryAt = pending && now - pending.at < REQUEST_GAP_MS ? pending.at + REQUEST_GAP_MS : undefined;
  const extra = { ...(run ? { run } : {}), ...(retryAt ? { retryAt } : {}) };
  if (runner && !runner.release) {
    return { ...base, ...extra, mode: "command", why: "unreleased", command: `cd ${runner.dir} && sudo ./update.sh --allow-older` };
  }
  if (runner && input.followsStable !== false) {
    const own = {
      command: `cd ${runner.dir} && sudo ./update.sh`, rollback: `cd ${runner.dir} && sudo ./update.sh --rollback`,
      logs: `cd ${runner.dir} && sudo docker compose logs --tail 50 omb`, setup: `cd ${runner.dir} && sudo ./update-runner.sh --install`,
    };
    return { ...base, ...own, ...extra, mode: runner.held ? "held" : "button" };
  }
  const command = check?.command ?? updateCommand(install)?.command;
  return { ...base, ...extra, mode: "command", ...(command ? { command } : {}) };
}

export interface ServerUpdater {
  status(): Promise<ServerUpdateStatus>;
  /** One request, made for `actor`: the HTTP status to answer and its body. */
  request(actor: AdminActor): Promise<{ status: number; body: Record<string, unknown> }>;
}

export function createServerUpdater(options: {
  dir: string | undefined;
  dataDir: string;
  install: InstallKind;
  version: string;
  check(): Promise<UpdateCheck>;
  activeTurns(): number;
  followsStable?: boolean;
  now?: () => number;
}): ServerUpdater {
  const now = options.now ?? Date.now;
  const requestFile = options.dir ? join(options.dir, "request", "request") : null;
  let queue: Promise<unknown> = Promise.resolve();

  async function status(): Promise<ServerUpdateStatus> {
    const check = await options.check().catch(() => null);
    const facts = readHostFacts(options.dir);
    const pending = readPending(options.dataDir);
    const answer = serverUpdateStatus({ install: options.install, check, facts, pending, version: options.version, activeTurns: options.activeTurns(), now: now(), followsStable: options.followsStable });
    // A request the host never took is withdrawn, so a runner switched on later does not act on an old press.
    if (answer.run?.outcome === "not-started" && requestFile) rmSync(requestFile, { force: true, recursive: true });
    return answer;
  }

  async function request(actor: AdminActor): Promise<{ status: number; body: Record<string, unknown> }> {
    const current = await status();
    if (current.mode !== "button" || !requestFile) {
      return { status: 409, body: { error: "This server can't be updated from the app.", code: "unavailable", status: current } };
    }
    if (current.run?.outcome === "requested" || current.run?.outcome === "running") {
      return { status: 409, body: { error: "This server is already updating.", code: "running", status: current } };
    }
    if (!current.available) return { status: 409, body: { error: "This server is up to date.", code: "up-to-date", status: current } };
    if (current.retryAt) return { status: 429, body: { error: "Wait a few minutes before you ask again.", code: "too-soon", status: current } };
    const pending: PendingUpdate = { at: now(), baseline: readHostFacts(options.dir).last?.run ?? 0, from: options.version };
    writePending(options.dataDir, pending);
    try {
      rmSync(requestFile, { force: true, recursive: true });
      writeFileSync(requestFile, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      rmSync(join(options.dataDir, PENDING_FILE), { force: true });
      return { status: 500, body: { error: "The update could not be asked for: this server can't write its request.", code: "unwritable", status: await status() } };
    }
    appendAdminAction(options.dataDir, {
      category: "config",
      action: "update.server",
      target: { kind: "server", name: `${options.version} → ${current.latest ?? "?"}` },
      actor,
    });
    return { status: 202, body: { status: await status() } };
  }

  return {
    status,
    request: (actor) => {
      const next = queue.then(() => request(actor));
      queue = next.catch(() => {});
      return next;
    },
  };
}
