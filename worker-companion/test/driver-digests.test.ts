import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { driverPolicyDigest, driverCapabilityDigest, expectedDriverDigests, matchesDriverDigests } from "../src/driver-digests.ts";

const policy = readFileSync(new URL("../../docs/windows-base-policy.yaml", import.meta.url));
const capability = readFileSync(new URL("../../docs/windows-parked-capabilities.yaml", import.meta.url));
const raw = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("CUA 0.20.0 loaded fingerprints", () => {
  it("matches fingerprints observed from the pinned Windows driver", () => {
    expect(driverPolicyDigest("windows-policy.yaml", policy)).toBe("ca673909b9b0587a1eebe148adfaf0eb3f1090563a8edb6ba9d86a95b5839bdc");
    expect(driverCapabilityDigest(capability)).toBe("d4d08ec102404bd93cecd21d5031be193fdbe2d0ea2a90fcecc0814a9c13fbbf");
    expect(driverPolicyDigest("other.yaml", policy)).not.toBe(driverPolicyDigest("windows-policy.yaml", policy));
    expect(driverCapabilityDigest(Buffer.concat([capability, Buffer.from("\n")]))).not.toBe(driverCapabilityDigest(capability));
  });

  it("requires exact named loaded fields and bounded mode", () => {
    const expected = { policy: driverPolicyDigest("windows-policy.yaml", policy), capability: driverCapabilityDigest(capability) };
    const status = `  permission mode: bounded (trusted_startup_configuration)\r\n  user policy sha256: ${expected.policy}\r\n  capability manifest sha256: ${expected.capability}\r\n`;
    expect(matchesDriverDigests(status, expected)).toBe(true);
    expect(matchesDriverDigests(status.replace("bounded", "unrestricted"), expected)).toBe(false);
    expect(matchesDriverDigests(status.replace("user policy", "managed policy"), expected)).toBe(false);
    expect(matchesDriverDigests(status.replace(expected.capability, raw(capability)), expected)).toBe(false);
  });

  it("rejects changed on-disk bytes before translating approved raw pins", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-digests-"));
    const prior = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
      mkdirSync(join(root, "OpenMausBot"));
      const p = join(root, "OpenMausBot", "windows-policy.yaml");
      const c = join(root, "OpenMausBot", "active-capabilities.yaml");
      writeFileSync(p, policy); writeFileSync(c, capability);
      expect(expectedDriverDigests(raw(capability), raw(policy), "win32")).toEqual({ policy: driverPolicyDigest("windows-policy.yaml", policy), capability: driverCapabilityDigest(capability) });
      writeFileSync(p, Buffer.concat([policy, Buffer.from("\n")]));
      expect(() => expectedDriverDigests(raw(capability), raw(policy), "win32")).toThrow("base policy bytes");
      writeFileSync(p, policy); writeFileSync(c, Buffer.concat([capability, Buffer.from("\n")]));
      expect(() => expectedDriverDigests(raw(capability), raw(policy), "win32")).toThrow("capability bytes");
    } finally {
      if (prior === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
