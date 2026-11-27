// Which processes hold the loopback listeners on a Linux machine, so a server lets a bot's browser reach only the
// dev servers a bot's own processes opened. Other platforms answer "not a bot's".
//
// Listener discovery and the socket-owner walk are adapted from pingdotgg/t3code@00cdceb1
// apps/server/src/preview/PortScanner.ts (procLocalAddress, parseProcNetTcp, findSocketOwners), MIT License,
// Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: plain Node in place of
// Effect, and an owner is a bot's when its session is one an engine started, not when a terminal registered it.
import { readdir, readFile, readlink } from "node:fs/promises";

/** `/proc/net/tcp` state for a listening socket. */
const PROC_TCP_LISTEN = "0A";
/** File descriptors one walk may read before it stops looking for socket owners. */
const PROC_FD_WALK_LIMIT = 50_000;
/** Walks that may miss a socket's owner (another user's process, or one that exited) before it stays unknown. */
const SOCKET_OWNER_ATTEMPTS = 3;
const LISTENERS_TTL_MS = 5_000;
/** A port missing from the snapshot is looked up again sooner: the bot may have just started its server. */
const MISS_RETRY_MS = 1_000;

/**
 * Whether a `/proc/net/tcp{,6}` address is reachable on loopback: the wildcard or a loopback address.
 * Each 32-bit word of the hex address is little-endian.
 */
export function procLocalAddress(hex: string): boolean {
  if (hex.length === 8) return hex === "00000000" || hex.endsWith("7F");
  if (hex.length !== 32) return false;
  if (hex === "0".repeat(32) || hex === `${"0".repeat(24)}01000000`) return true;
  // IPv4-mapped (::ffff:a.b.c.d): wildcard or 127.0.0.0/8.
  return hex.startsWith(`${"0".repeat(16)}FFFF0000`) && procLocalAddress(hex.slice(24));
}

/** Listening loopback ports in `/proc/net/tcp{,6}` content, with their socket inodes. */
export function parseProcNetTcp(raw: string): Array<{ port: number; inode: string }> {
  const listeners: Array<{ port: number; inode: string }> = [];
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, portHex] = fields[1]?.split(":") ?? [];
    if (fields[3] !== PROC_TCP_LISTEN || !address || !portHex) continue;
    if (!procLocalAddress(address.toUpperCase())) continue;
    const port = Number.parseInt(portHex, 16);
    const inode = fields[9];
    if (!Number.isInteger(port) || port <= 0 || port >= 65_536 || !inode || inode === "0") continue;
    listeners.push({ port, inode });
  }
  return listeners;
}

/** The session id in `/proc/<pid>/stat`; the command name before it may hold spaces and parentheses. */
export function sessionOfStat(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const session = Number(fields[3]);
  return Number.isInteger(session) && session > 0 ? session : null;
}

/** Engine processes start their own sessions; `ended` ones still name the servers their processes left running. */
export interface EngineSessions {
  live: ReadonlySet<number>;
  ended: ReadonlySet<number>;
}

export interface ProcFiles {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

const nodeProc: ProcFiles = {
  readFile: (path) => readFile(path, "utf8"),
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
};

export class ListenerOwnership {
  private readonly sessions: () => EngineSessions;
  private readonly proc: ProcFiles;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private listeners: { at: number; byPort: Map<number, string[]> } | null = null;
  private owners = new Map<string, number>();
  private misses = new Map<string, number>();

  constructor(options: { sessions: () => EngineSessions; proc?: ProcFiles; platform?: NodeJS.Platform; now?: () => number }) {
    this.sessions = options.sessions;
    this.proc = options.proc ?? nodeProc;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  /** Whether every listener on this loopback port belongs to a process in a bot engine's session. */
  async botOwned(port: number): Promise<boolean> {
    if (this.platform !== "linux") return false;
    let inodes = (await this.snapshot(LISTENERS_TTL_MS)).get(port);
    if (!inodes?.length) inodes = (await this.snapshot(MISS_RETRY_MS)).get(port);
    if (!inodes?.length) return false;
    await this.findOwners(inodes.filter((inode) => !this.owners.has(inode)));
    const sessions = this.sessions();
    for (const inode of inodes) {
      const pid = this.owners.get(inode);
      if (pid === undefined) return false;
      const session = await this.proc.readFile(`/proc/${pid}/stat`).then(sessionOfStat, () => null);
      if (session === null || !(await this.isBotSession(session, sessions))) return false;
    }
    return true;
  }

  /** An ended session counts only while its leader's pid is free: a live pid there is a reused one. */
  private async isBotSession(session: number, sessions: EngineSessions): Promise<boolean> {
    if (sessions.live.has(session)) return true;
    if (!sessions.ended.has(session)) return false;
    return this.proc.readFile(`/proc/${session}/stat`).then(() => false, () => true);
  }

  private async snapshot(maxAgeMs: number): Promise<Map<number, string[]>> {
    if (this.listeners && this.now() - this.listeners.at < maxAgeMs) return this.listeners.byPort;
    const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((path) => this.proc.readFile(path).catch(() => "")));
    const byPort = new Map<number, string[]>();
    for (const { port, inode } of tables.flatMap(parseProcNetTcp)) byPort.set(port, [...(byPort.get(port) ?? []), inode]);
    const inodes = new Set([...byPort.values()].flat());
    for (const inode of [...this.owners.keys(), ...this.misses.keys()]) {
      if (!inodes.has(inode)) { this.owners.delete(inode); this.misses.delete(inode); }
    }
    this.listeners = { at: this.now(), byPort };
    return byPort;
  }

  /** Maps socket inodes to the processes holding them, by `/proc/<pid>/fd`. */
  private async findOwners(wanted: string[]): Promise<void> {
    const unknown = new Set(wanted.filter((inode) => (this.misses.get(inode) ?? 0) < SOCKET_OWNER_ATTEMPTS));
    if (!unknown.size) return;
    const pids = (await this.proc.readdir("/proc").catch(() => [] as string[])).filter((entry) => /^\d+$/.test(entry));
    let budget = PROC_FD_WALK_LIMIT;
    for (const pid of pids) {
      if (![...unknown].some((inode) => !this.owners.has(inode)) || budget <= 0) break;
      // Other users' fds are unreadable; their ports still list, without an owner.
      const fds = (await this.proc.readdir(`/proc/${pid}/fd`).catch(() => [] as string[])).slice(0, budget);
      budget -= fds.length;
      const links = await Promise.all(fds.map((fd) => this.proc.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")));
      for (const link of links) {
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        if (inode && unknown.has(inode)) this.owners.set(inode, Number(pid));
      }
    }
    for (const inode of unknown) if (!this.owners.has(inode)) this.misses.set(inode, (this.misses.get(inode) ?? 0) + 1);
  }
}
