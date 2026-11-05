// The OpenConnector connection as the Apps card and its routes see it. Like Postiz, the card manages one
// `openconnector` MCP server entry, so the MCP gate, each bot's server selection and a Team Cloud's scopes treat it
// like any other. Unlike Postiz, the server is usually a process on this computer: when the person asks OpenMausBot
// to run OpenConnector (a saved command), this module also owns its lifecycle — start on demand, a health check that
// restarts it with bounded retries, and a clean stop. OpenConnector takes no credentials; nothing here carries any.
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  OPENCONNECTOR_DEFAULT_URL, OPENCONNECTOR_SERVER, type OpenConnectorStatus,
} from "../../shared/openconnector.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { AppConfig } from "../config.ts";
import { probeMcpServer, probeEnvironment, type McpProbeResult } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredRemoteMcpServer } from "../mcp-registry.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { openConnectorAddress, openConnectorHost } from "./connection.ts";

export type OpenConnectorProblem = "address" | "unreachable" | "start_failed" | "taken" | "busy" | "managed_policy";
export type OpenConnectorRefusal = { status: number; error: string; code: OpenConnectorProblem };
export type OpenConnectorResult = { ok: true; status: OpenConnectorStatus } | ({ ok: false } & OpenConnectorRefusal);

export interface OpenConnectorDeps {
  cfg(): Pick<AppConfig, "openconnector" | "mcpServers">;
  persistMcpServers(next: Record<string, unknown>): void;
  mcpConfigBusy: { get(): boolean; set(busy: boolean): void };
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  appCatalog?: { serverChanged(name: string): void; forgetServer(name: string): void };
  dataDir: string;
  /** Whether this computer may start the process: the desktop and self-hosted servers, never a Cloud. */
  loopback: boolean;
  probe?: typeof probeMcpServer;
  /** Starts the program detached and returns the handle; the default uses spawnCli (no shell, own process group). */
  launch?: (command: string, args: string[]) => ChildProcess;
  /** Stops a started process: an in-session handle when there is one, else the pid recorded for it. */
  terminate?: (handle: ChildProcess | null, pid: number | null) => Promise<void>;
  /** Whether the recorded pid is still the command OpenMausBot started (guards against pid reuse). */
  alive?: (pid: number, command: string) => boolean;
  now?: () => number;
  /** Health cadence while connected; the timer stays unref'd and runs only when there is something to watch. */
  healthEveryMs?: number;
  autoHealth?: boolean;
  /** How long a freshly started process gets to answer its MCP endpoint. */
  readyMs?: number;
  readyPollMs?: number;
  log?: (line: string) => void;
}

const PROBE_MS = 10_000;
const READY_POLL_MS = 500;
const READY_MS = 15_000;
/** After this many consecutive failed health checks (each already one restart attempt), the card rests in `error`. */
const MAX_RECOVERY_ATTEMPTS = 3;
const CHECK_CACHE_MS = 30_000;
const BUSY_RETRY_MS = 50;
const BUSY_GIVE_UP_MS = 10_000;

const pidFile = (dataDir: string) => join(dataDir, "openconnector-process.json");

interface PidRecord { pid: number; command: string; url: string; startedAt: number }

function readPidRecord(path: string): PidRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<PidRecord>;
    return Number.isInteger(record.pid) && (record.pid as number) > 1 && typeof record.command === "string" && typeof record.url === "string"
      ? { pid: record.pid as number, command: record.command, url: record.url, startedAt: typeof record.startedAt === "number" ? record.startedAt : 0 }
      : null;
  } catch {
    return null;
  }
}

function pidAliveDefault(pid: number, command: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Linux: confirm the live pid is the program the record names, so a recycled pid is never adopted or signalled.
  if (process.platform === "linux") {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const base = command.split(/[\\/]/u).pop() ?? command;
      return cmdline.replace(/\0/gu, " ").includes(base);
    } catch {
      return true;
    }
  }
  return true;
}

async function terminateDefault(handle: ChildProcess | null, pid: number | null): Promise<void> {
  if (handle?.pid) {
    await killCliTree(handle).catch(() => {});
    return;
  }
  if (!pid || pid <= 1) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  // Escalate once, after a short grace, when the group ignored TERM.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch { /* already gone */ }
      resolve();
    }, 4_000);
    timer.unref?.();
  });
}

function launchDefault(command: string, args: string[]): ChildProcess {
  const child = spawnCli(command, args, { stdio: ["ignore", "ignore", "ignore"], env: probeEnvironment({ env: {} }) }) as unknown as ChildProcess;
  child.unref();
  return child;
}

/** How the card set the entry up: matching the saved address with no credentials, or `taken` for anything else. */
export function openConnectorEntryMethod(server: StoredRemoteMcpServer, url: string): "connect" | "taken" {
  if (server.type !== "http" || Object.values(server.headers).some((value) => value !== "") || server.oauth) return "taken";
  return server.url === url ? "connect" : "taken";
}

export function createOpenConnector(deps: OpenConnectorDeps) {
  const probe = deps.probe ?? probeMcpServer;
  const launch = deps.launch ?? launchDefault;
  const terminate = deps.terminate ?? terminateDefault;
  const alive = deps.alive ?? pidAliveDefault;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(`openconnector: ${line}`));
  const healthEveryMs = deps.healthEveryMs ?? 30_000;
  const readyMs = deps.readyMs ?? READY_MS;
  const readyPollMs = deps.readyPollMs ?? READY_POLL_MS;

  let state: OpenConnectorStatus["state"] = "not-connected";
  let running = false;
  let pid: number | null = null;
  let tools: number | undefined;
  let message: string | undefined;
  let failures = 0;
  let checkedAt = -Infinity;
  let lastSaved = "";
  let lastCommand: string | null = null;
  let child: ChildProcess | null = null;
  let spawnError: Error | null = null;
  let ensuring: Promise<unknown> = Promise.resolve();
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  const settings = () => deps.cfg().openconnector ?? {};
  const command = () => (settings().command ?? "").trim();
  const args = () => settings().args ?? [];
  const managed = () => command() !== "" && deps.loopback;
  const savedUrl = (): string => {
    const checked = openConnectorAddress(settings().url, { loopback: deps.loopback, managed: managed() });
    return checked.ok ? checked.address : OPENCONNECTOR_DEFAULT_URL;
  };

  const entry = (): StoredRemoteMcpServer | null | undefined => {
    const raw = deps.cfg().mcpServers?.[OPENCONNECTOR_SERVER];
    if (raw === undefined) return undefined;
    const parsed = parseStoredMcpServer(OPENCONNECTOR_SERVER, raw);
    return parsed.ok && isRemoteMcpServer(parsed.server) ? parsed.server as StoredRemoteMcpServer : null;
  };

  const serverSpec = (url: string, enabled: boolean): StoredRemoteMcpServer => ({ type: "http", url, headers: {}, enabled });

  /** Writes the entry once no MCP server edit is in flight, so neither overwrites the other. */
  const writeEntry = (next: StoredRemoteMcpServer | null, started = now()): void => {
    if (deps.mcpConfigBusy.get()) {
      if (now() - started < BUSY_GIVE_UP_MS) setTimeout(() => writeEntry(next, started), BUSY_RETRY_MS).unref?.();
      return;
    }
    deps.mcpConfigBusy.set(true);
    try {
      const servers = { ...deps.cfg().mcpServers };
      if (next) servers[OPENCONNECTOR_SERVER] = next;
      else delete servers[OPENCONNECTOR_SERVER];
      deps.persistMcpServers(servers);
      deps.appCatalog?.forgetServer(OPENCONNECTOR_SERVER);
      if (next) deps.appCatalog?.serverChanged(OPENCONNECTOR_SERVER);
      checkedAt = -Infinity;
    } finally {
      deps.mcpConfigBusy.set(false);
    }
  };

  const forgetPidFile = (): void => {
    try {
      rmSync(pidFile(deps.dataDir), { force: true });
    } catch { /* gone */ }
  };

  const status = (): OpenConnectorStatus => {
    const url = savedUrl();
    const base: OpenConnectorStatus = {
      state, url, host: openConnectorHost(url), managed: managed(), command: command(), args: args(),
      running, pid: running ? pid : null,
    };
    const refusal = deps.mcpPolicyRefusal(OPENCONNECTOR_SERVER, serverSpec(url, false));
    if (refusal) return { ...base, state: "blocked", message: refusal, tools };
    const current = entry();
    if (current === null || (current !== undefined && openConnectorEntryMethod(current, url) === "taken")) {
      return { ...base, state: "taken", message: "An MCP server named openconnector is already set up in MCP servers. Remove it there to connect OpenConnector here." };
    }
    return { ...base, ...(tools !== undefined ? { tools } : {}), ...(message !== undefined ? { message } : {}) };
  };

  const adopt = (result: Extract<McpProbeResult, { ok: true }>): void => {
    state = "connected";
    running = true;
    failures = 0;
    message = undefined;
    tools = result.total ?? result.tools.length;
    checkedAt = now();
  };

  const probeOnce = (url: string, timeoutMs = PROBE_MS): Promise<McpProbeResult> =>
    probe(serverSpec(url, true), timeoutMs);

  /** Polls the address until the MCP handshake answers or the deadline passes. */
  const probeUntilReady = async (url: string, deadline: number): Promise<McpProbeResult> => {
    let last: McpProbeResult = { ok: false, error: "OpenConnector did not answer in time.", reason: "timeout" };
    while (now() < deadline) {
      if (spawnError) return { ok: false, error: `Could not start OpenConnector (${spawnError.message}). Check the command.`, reason: "unreachable" };
      last = await probeOnce(url, readyPollMs);
      if (last.ok) return last;
      await new Promise((resolve) => setTimeout(resolve, readyPollMs));
    }
    return last;
  };

  const stopProcess = async (): Promise<void> => {
    await terminate(child, pid);
    child = null;
    pid = null;
    running = false;
    forgetPidFile();
  };

  /** Starts the saved command and waits for the endpoint; on success records the pid for adoption after a restart. */
  const startProcess = async (url: string): Promise<Extract<McpProbeResult, { ok: true }> | { ok: false; error: string }> => {
    await stopProcess();
    spawnError = null;
    try {
      child = launch(command(), args());
    } catch (error) {
      return { ok: false, error: `Could not start OpenConnector (${(error as Error).message}). Check the command.` };
    }
    if (!child.pid) return { ok: false, error: "OpenConnector did not start (no pid)." };
    child.once?.("error", (error: Error) => { spawnError = error; });
    child.once?.("exit", () => { if (pid === child?.pid) running = false; });
    const result = await probeUntilReady(url, now() + readyMs);
    if (!result.ok) {
      await stopProcess();
      return { ok: false, error: result.error };
    }
    pid = child.pid;
    running = true;
    try {
      writeFileAtomic(pidFile(deps.dataDir), JSON.stringify({ pid, command: command(), url, startedAt: now() }), { mode: 0o600 });
    } catch { /* the record is a convenience, not a requirement */ }
    return result;
  };

  /** Probes the address; when it fails and OpenMausBot manages the process, restarts it (bounded by MAX_RECOVERY_ATTEMPTS). */
  const ensure = async (): Promise<void> => {
    const url = savedUrl();
    const first = await probeOnce(url);
    if (first.ok) {
      if (!running) {
        // Answers already: someone (even an earlier OpenMausBot run) left it up — adopt, never double-start.
        const record = readPidRecord(pidFile(deps.dataDir));
        if (record && record.url === url && alive(record.pid, record.command)) {
          pid = record.pid;
          running = true;
        }
      }
      adopt(first);
      return;
    }
    if (!managed()) {
      state = "not-connected";
      running = false;
      message = first.error;
      return;
    }
    failures += 1;
    const record = readPidRecord(pidFile(deps.dataDir));
    if (record && record.command === command() && record.url === url && alive(record.pid, command())) {
      // Known alive but not answering yet: give it the ready window, then stop it before a fresh start.
      pid = record.pid;
      running = true;
      const woke = await probeUntilReady(url, now() + readyMs);
      if (woke.ok) {
        adopt(woke);
        return;
      }
      await stopProcess();
    }
    if (failures > MAX_RECOVERY_ATTEMPTS) {
      state = "error";
      message = first.error;
      log(`gave up after ${failures} failed checks: ${first.error}`);
      return;
    }
    log(`restart attempt ${failures}/${MAX_RECOVERY_ATTEMPTS}`);
    const started = await startProcess(url);
    if (started.ok) adopt(started);
    else {
      state = "error";
      message = started.error;
    }
  };

  /** Runs ensure serialized, so a health tick never races a connect. */
  const ensureOnce = (): Promise<void> => {
    ensuring = ensuring.then(ensure, ensure);
    return ensuring;
  };

  const healthTick = async (): Promise<void> => {
    if (state !== "connected" && state !== "error") return;
    if (entry()?.enabled === false) return;
    await ensureOnce();
  };

  const startHealth = (): void => {
    if (healthTimer || deps.autoHealth === false || !deps.loopback) return;
    healthTimer = setInterval(() => {
      void healthTick().catch((error: unknown) => log(`health check failed: ${String(error)}`));
    }, healthEveryMs);
    healthTimer.unref?.();
  };

  const connect = async (): Promise<OpenConnectorResult> => {
    if (deps.mcpConfigBusy.get()) {
      return { ok: false, status: 409, error: "MCP servers are being updated. Try again in a moment.", code: "busy" };
    }
    const current = entry();
    if (current === null || (current !== undefined && openConnectorEntryMethod(current, savedUrl()) === "taken")) {
      return { ok: false, status: 409, error: "An MCP server named openconnector is already set up in MCP servers. Remove it there to connect OpenConnector here.", code: "taken" };
    }
    const refusal = deps.mcpPolicyRefusal(OPENCONNECTOR_SERVER, serverSpec(savedUrl(), false));
    if (refusal) {
      return { ok: false, status: 403, error: refusal, code: "managed_policy" };
    }
    state = "connecting";
    message = undefined;
    await ensureOnce();
    if (state !== "connected") {
      return { ok: false, status: 502, error: message ?? "OpenConnector did not answer.", code: managed() ? "start_failed" : "unreachable" };
    }
    writeEntry(serverSpec(savedUrl(), true));
    startHealth();
    lastSaved = JSON.stringify({ url: savedUrl(), command: command(), args: args() });
    lastCommand = command();
    return { ok: true, status: status() };
  };

  const check = async (): Promise<OpenConnectorStatus> => {
    // The cache only serves a healthy connection; an erroring one is re-probed right away.
    if (state === "connected" && now() - checkedAt < CHECK_CACHE_MS) return status();
    failures = 0;
    await ensureOnce();
    return status();
  };

  const disconnect = async (): Promise<OpenConnectorResult> => {
    if (deps.mcpConfigBusy.get()) {
      return { ok: false, status: 409, error: "MCP servers are being updated. Try again in a moment.", code: "busy" };
    }
    await stopProcess();
    writeEntry(null);
    failures = 0;
    state = "not-connected";
    tools = undefined;
    message = undefined;
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    return { ok: true, status: status() };
  };

  /** Before a config save: the address must be one OpenConnector can be reached at, and the command one that can start. */
  async function configCheck(patch: { openconnector?: { url?: string; command?: string; args?: string[] } }): Promise<OpenConnectorRefusal | null> {
    const section = patch.openconnector;
    if (!section) return null;
    const merged = { ...settings(), ...section };
    const manage = (merged.command ?? "").trim() !== "" && deps.loopback;
    if (section.url !== undefined) {
      const checked = openConnectorAddress(section.url, { loopback: deps.loopback, managed: manage });
      if (!checked.ok) return { status: 400, code: "address", error: checked.error };
    }
    if (section.command !== undefined && section.command.trim() !== "") {
      if (/\p{Cc}/u.test(section.command) || section.command.length > 500) {
        return { status: 400, code: "address", error: "Enter the program that starts OpenConnector, without control characters." };
      }
    }
    if (section.args !== undefined) {
      for (const arg of section.args) {
        if (/\p{Cc}/u.test(arg)) return { status: 400, code: "address", error: "OpenConnector's arguments must be plain text." };
      }
    }
    return null;
  }

  /** After a config save: a changed address or command is picked up on the next check; a changed command restarts the process. */
  function configSaved(patch: { openconnector?: { url?: string; command?: string; args?: string[] } }): void {
    const section = patch.openconnector;
    if (!section) return;
    const next = JSON.stringify({ url: savedUrl(), command: command(), args: args() });
    const changed = next !== lastSaved;
    lastSaved = next;
    if (!changed) return;
    deps.appCatalog?.serverChanged(OPENCONNECTOR_SERVER);
    if (state !== "connected" && state !== "error") return;
    failures = 0;
    const commandChanged = command() !== lastCommand;
    lastCommand = command();
    const reensure = () => ensureOnce().catch((error: unknown) => log(`re-check after config change failed: ${String(error)}`));
    if (commandChanged) void stopProcess().then(reensure, reensure);
    else reensure();
  }

  return { status, connect, check, disconnect, configCheck, configSaved, healthTick, startHealth };
}

export type OpenConnector = ReturnType<typeof createOpenConnector>;
