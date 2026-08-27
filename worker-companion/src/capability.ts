// The parked capability: the worker's resting state.
//
// It grants no tools at all, so a worker running it is reachable and provably
// bounded and can do nothing until a task capability is approved. These strings
// are byte-identical to docs/macos-parked-capabilities.yaml and
// docs/windows-parked-capabilities.yaml; worker-companion/test/parked.test.ts
// fails if they ever drift, because an operator who installs the documented
// file and a companion that writes a different one would disagree on the digest
// and the worker would never come up bounded.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { activeCapabilityPath, type WorkerPlatform, workerPlatform } from "./platform.ts";

const MAC_PARKED = `# Safe bootstrap state for the interactive macOS CUA daemon.
# The worker companion replaces this file atomically with a short-lived,
# approved task capability before OpenMausBot mounts the CUA MCP bridge.
#
# It grants no tools at all. A worker running this manifest is reachable and
# provably bounded, and can do nothing until a task capability is approved —
# which is the correct resting state between tasks.
version: 3
expires_after: 8760h
idle_timeout: 20m

allow:
  tools: []

resources:
  desktop:
    display: false
`;

const WINDOWS_PARKED = `# Safe bootstrap state for the interactive Windows CUA Scheduled Task.
# The Windows companion replaces this file atomically with a short-lived,
# approved task capability before OpenMausBot mounts the CUA MCP bridge.
version: 3
expires_after: 8760h
idle_timeout: 20m

allow:
  tools: []

resources:
  desktop:
    display: false
`;

export function parkedCapability(platform: WorkerPlatform = workerPlatform()): string {
  return platform === "darwin" ? MAC_PARKED : WINDOWS_PARKED;
}

export const capabilityDigest = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

/** Replace the active capability atomically and owner-private. A partially
 * written capability file is a capability the driver may read as broader than
 * intended, so this never writes the live path in place. */
export function writeActiveCapability(content: string, platform: WorkerPlatform = workerPlatform()): void {
  const target = activeCapabilityPath(platform);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
