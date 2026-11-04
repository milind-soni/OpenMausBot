// Ports for suites that boot real servers: claim the block, so two suites at once never share an unchecked base.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";

/** A claim outlives a crashed holder for at most this long: a dead pid reads as stale at once,
 * and a live pid that never binds lets go when its age passes. */
export const CLAIM_TTL_MS = 60_000;
/** How often a claimed port is watched for the real listener that takes it over. */
const WATCH_INTERVAL_MS = 100;
/** A reclaimer can read the stale body just before this process creates its claim; the pause lets
 * that stale unlink land before ownership is confirmed, so the lost race skips the base. */
const SETTLE_MS = 25;

/** The claim file for a port; the claim tests read and fabricate these directly. */
export const claimPath = (port: number): string => join(tmpdir(), `omb-port-claim-${port}.json`);

interface Claim {
  pid: number;
  at: number;
}

/** A bind probe: the port is free only while nothing listens on it. */
export const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const parseClaim = (raw: string): Claim | null => {
  try {
    const value = JSON.parse(raw) as Partial<Claim>;
    return typeof value.pid === "number" && typeof value.at === "number" ? { pid: value.pid, at: value.at } : null;
  } catch {
    return null;
  }
};

const aged = (at: number): boolean => Date.now() - at > CLAIM_TTL_MS;

/** The claim body at path; null when the file cannot be read. */
const readClaim = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** A claim is stale when its holder died or its age passed the TTL; a body mid-write has neither
 * fact yet, so the file's own age stands in until it too passes. */
const staleClaim = (path: string, raw: string): boolean => {
  const claim = parseClaim(raw);
  if (claim !== null) return aged(claim.at) || !pidAlive(claim.pid);
  try {
    return aged(statSync(path).mtimeMs);
  } catch {
    return true;
  }
};

/** Whether a live claim blocks the port; a file that vanishes on the read counts as free. */
const heldByClaim = (port: number): boolean => {
  const path = claimPath(port);
  const raw = readClaim(path);
  return raw !== null && !staleClaim(path, raw);
};

const ownsClaim = (port: number, body: string): boolean => readClaim(claimPath(port)) === body;

/** Unlink only a claim this caller still owns; a slot reclaimed by someone else is left alone. */
const releaseClaim = (port: number, body: string): void => {
  if (!ownsClaim(port, body)) return;
  try {
    unlinkSync(claimPath(port));
  } catch {
    // Already gone or not removable: the TTL still bounds whatever file remains.
  }
};

/** Unlink a claim only after a second read confirms the same stale body, so a holder that
 * appeared in between keeps its port. */
const reclaimStale = (path: string): boolean => {
  const raw = readClaim(path);
  if (raw === null) return true;
  if (!staleClaim(path, raw)) return false;
  const confirm = readClaim(path);
  if (confirm === null) return true;
  if (confirm !== raw) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return true;
  }
};

/** Take one port with an O_CREAT|O_EXCL claim file, reclaiming a stale claim first. The body is
 * the caller's proof of ownership; null means a live claim held the port. */
const claimPort = (port: number): string | null => {
  const path = claimPath(port);
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return body;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!reclaimStale(path)) return null;
    }
  }
  return null;
};

/** Hold a claimed port until a real listener takes it over (first bind drops the claim), with the
 * TTL as the crash fallback. The timer and socket are unref'd: no watcher holds the process open. */
const watchClaim = (port: number, body: string): void => {
  const deadline = Date.now() + CLAIM_TTL_MS;
  let probing = false;
  const timer = setInterval(() => {
    if (Date.now() >= deadline || !ownsClaim(port, body)) {
      clearInterval(timer);
      return;
    }
    if (probing) return;
    probing = true;
    // A connect probe observes a bind without ever taking the port itself.
    const probe = connect(port, "127.0.0.1");
    probe.unref();
    probe.setTimeout(2_000, () => probe.destroy());
    probe.once("connect", () => {
      clearInterval(timer);
      releaseClaim(port, body);
      probe.destroy();
    });
    probe.once("error", () => probe.destroy());
    probe.once("close", () => {
      probing = false;
    });
  }, WATCH_INTERVAL_MS);
  timer.unref();
};

/** A port no fixture listens on and no live claim holds. */
const isFree = async (port: number): Promise<boolean> => !heldByClaim(port) && (await canBind(port));

/** A base where every `base + offset` is free and claimed for this caller (the harness also opens
 * a webhook receiver one above itself). Each claim lasts until a real listener takes its port, so a
 * concurrent caller skips the block instead of racing into the same base. */
export async function freePortBlock(offsets: number[], from = 19_600, span = 3_000): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = from + Math.floor(Math.random() * span);
    const checks = await Promise.all(offsets.map((offset) => isFree(base + offset)));
    if (!checks.every(Boolean)) continue;
    const claims: Array<{ port: number; body: string }> = [];
    for (const offset of offsets) {
      const body = claimPort(base + offset);
      if (body === null) break;
      claims.push({ port: base + offset, body });
    }
    if (claims.length === offsets.length) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      if (claims.every(({ port, body }) => ownsClaim(port, body))) {
        for (const { port, body } of claims) watchClaim(port, body);
        return base;
      }
    }
    for (const { port, body } of claims) releaseClaim(port, body);
  }
  throw new Error(`no free port block for offsets ${offsets.join(",")} in ${from}..${from + span}`);
}

/** The lowest port the OS hands out itself: Linux's ip_local_port_range, else IANA's dynamic range (macOS, Windows). */
export function ephemeralFloor(): number {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
  } catch {
    return 49_152;
  }
}

/** A pre-registered sign-in app returns to one loopback port derived from the URL (mcpOAuthRedirectUri).
 * On Linux the top of 20000-39999 is the ephemeral range, held by client connections and TIME_WAIT, so
 * a query moves the derived port below it. */
export async function withFreeSignInPort(url: string): Promise<string> {
  const floor = ephemeralFloor();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = new URL(url);
    candidate.searchParams.set("app", String(attempt));
    const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
    if (port < floor && await isFree(port)) return candidate.toString();
  }
  throw new Error(`no free sign-in redirect port below ${floor} for ${url}`);
}
