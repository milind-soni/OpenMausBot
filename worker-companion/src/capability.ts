// The parked capability: the worker's resting state.
//
// The macOS version grants only the base-policy-constrained, non-prompting TCC
// status read; Windows grants no tools. Neither can observe or control the
// desktop until a task capability is approved. These strings are byte-identical to docs/macos-parked-capabilities.yaml and
// docs/windows-parked-capabilities.yaml; worker-companion/test/companion.test.ts
// fails if they ever drift, because an operator who installs the documented
// file and a companion that writes a different one would disagree on the digest
// and the worker would never come up bounded.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { activeCapabilityPath, type WorkerPlatform, workerPlatform } from "./platform.ts";

const MAC_PARKED = `# Safe bootstrap state for the interactive macOS CUA daemon.
# The worker companion replaces this file atomically with a short-lived,
# approved task capability, then restarts the fixed worker daemon so CUA loads
# that immutable boundary. OpenMausBot's shared IDE/CLI bridge is not involved.
#
# It grants only the non-prompting permission-status tool admitted by the base
# policy. A worker running this manifest is reachable and provably bounded but
# cannot observe or control the desktop until a task capability is approved.
version: 3
expires_after: 24h
idle_timeout: 24h

allow:
  tools:
    - check_permissions

resources:
  desktop:
    display: false
`;

const WINDOWS_PARKED = `# Safe bootstrap state for the interactive Windows CUA Scheduled Task.
# The Windows companion replaces this file atomically with a short-lived,
# approved task capability, then restarts the fixed worker Scheduled Task so
# CUA loads that immutable boundary. The shared IDE/CLI bridge is not involved.
# \`allow.tools\` must be non-empty in CUA 0.20.0, so this names the macOS-only
# permission-status tool; the Windows base policy does not admit it, leaving
# the effective parked tool intersection empty.
version: 3
expires_after: 24h
idle_timeout: 24h

allow:
  tools:
    - check_permissions

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
