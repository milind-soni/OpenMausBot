import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import { agentGraphNoFollowFlag } from "./agent-graph-evidence.ts";
import { writeFileAtomic } from "./atomic.ts";

const MAX_ENDPOINT_BYTES = 64 * 1024;

export interface CapabilityGatewayEndpoint {
  schema: "openmaus.capability-gateway-endpoint.v1";
  url: string;
  authorization: string;
  manifestSha256: string;
  pid: number;
  createdAt: string;
}
export function gatewayEndpointPath(dataDir: string): string {
  return join(dataDir, "runtime", "capability-gateway.json");
}

export function publishGatewayEndpoint(
  dataDir: string,
  input: Omit<CapabilityGatewayEndpoint, "schema" | "createdAt">,
): string {
  const path = gatewayEndpointPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify({
    schema: "openmaus.capability-gateway-endpoint.v1",
    createdAt: new Date().toISOString(),
    ...input,
  } satisfies CapabilityGatewayEndpoint, null, 2), { mode: 0o600 });
  return path;
}

function stableEndpointFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.nlink === 1 && right.nlink === 1 && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function restoreClaimedEndpoint(claimedPath: string, endpointPath: string): void {
  try {
    // link() is a no-replace restoration primitive. If a newer publisher has
    // already recreated the canonical path, EEXIST preserves that generation.
    linkSync(claimedPath, endpointPath);
    unlinkSync(claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
    try { unlinkSync(claimedPath); } catch {}
  }
}

/** Remove only the concrete endpoint generation owned by pid.
 *
 * The atomic rename claims one generation before its private authorization is
 * read. A concurrent publisher can safely create the canonical path while the
 * claim is inspected; cleanup then removes only the claimed inode. */
export function removeGatewayEndpoint(
  dataDir: string,
  pid = process.pid,
  hooks: { afterClaim?: () => void } = {},
): void {
  const path = gatewayEndpointPath(dataDir);
  const claimedPath = `${path}.remove-${pid}-${randomUUID()}`;
  try {
    renameSync(path, claimedPath);
  } catch {
    return;
  }

  let removeClaim = false;
  let fd: number | null = null;
  try {
    const pathBefore = lstatSync(claimedPath);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1 ||
      pathBefore.size < 1 || pathBefore.size > MAX_ENDPOINT_BYTES) return;
    fd = openSync(claimedPath, fsConstants.O_RDONLY | agentGraphNoFollowFlag());
    const before = fstatSync(fd);
    if (!stableEndpointFile(pathBefore, before)) return;
    const body = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(claimedPath);
    if (!stableEndpointFile(before, after) || !stableEndpointFile(after, pathAfter) || body.byteLength !== after.size) return;
    const parsed = JSON.parse(body.toString("utf8")) as { pid?: unknown };
    if (parsed.pid !== pid) return;
    closeSync(fd);
    fd = null;
    hooks.afterClaim?.();
    removeClaim = true;
  } catch {
    // Missing, malformed, linked, oversized, or changed claims are restored
    // only when no newer generation already occupies the canonical path.
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    if (removeClaim) {
      try { unlinkSync(claimedPath); } catch {}
    } else {
      restoreClaimedEndpoint(claimedPath, path);
    }
  }
}
