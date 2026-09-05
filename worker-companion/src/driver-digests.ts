// CUA 0.20.0 fingerprints include a domain separator; policy fingerprints
// also include the filename and big-endian lengths. Keep raw config/file pins
// unchanged, and translate only after verifying the exact installed bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { activeCapabilityPath, policyPath, type WorkerPlatform } from "./platform.ts";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function driverPolicyDigest(name: string, bytes: Buffer): string {
  const hash = createHash("sha256").update("cua-driver-policy-v1\0");
  for (const part of [Buffer.from(name, "utf8"), bytes]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    hash.update(length).update(part);
  }
  return hash.digest("hex");
}

export function driverCapabilityDigest(bytes: Buffer): string {
  return createHash("sha256").update("cua-driver-capability-manifest-v3\0").update(bytes).digest("hex");
}

export function expectedDriverDigests(capability: string, policy: string, platform: WorkerPlatform) {
  const policyFile = policyPath(platform);
  const policyBytes = readFileSync(policyFile);
  const capabilityBytes = readFileSync(activeCapabilityPath(platform));
  if (sha256(policyBytes) !== policy.toLowerCase()) throw new Error("worker base policy bytes do not match the approved digest");
  if (sha256(capabilityBytes) !== capability.toLowerCase()) throw new Error("worker capability bytes do not match the approved digest");
  return {
    policy: driverPolicyDigest(basename(policyFile), policyBytes),
    capability: driverCapabilityDigest(capabilityBytes),
  };
}

export function matchesDriverDigests(status: string, expected: { policy: string; capability: string }): boolean {
  const lines = status.toLowerCase().split(/\r?\n/).map((line) => line.trim());
  return lines.includes(`user policy sha256: ${expected.policy}`)
    && lines.includes(`capability manifest sha256: ${expected.capability}`)
    && lines.some((line) => /^permission mode: bounded(?:\s|$)/.test(line));
}
