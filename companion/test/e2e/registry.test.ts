import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceRegistry } from "../../src/devices.ts";
import { admission, admissionHash, credentialHash } from "../../src/e2e/credentials.ts";
import { generateKeyPair } from "../../src/e2e/noise.ts";
import { E2ERegistry } from "../../src/e2e/registry.ts";
import { DATA_DIR } from "../../src/state.ts";

describe("E2ERegistry admission", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps a just-restricted device admitted for the hold, then lets the set shrink and says so", async () => {
    vi.useFakeTimers();
    try {
      const devices = new DeviceRegistry();
      const registry = new E2ERegistry(devices);
      const hostId = randomBytes(16);
      registry.setKey(generateKeyPair());
      registry.setRelay({ hostId, nodes: ["relay1.openmausbot.com"] });
      const { code } = devices.openPairing();
      const paired = devices.redeem(code, "Phone");
      if ("error" in paired) throw new Error(paired.error);
      devices.closePairing();
      const hash = admissionHash(admission(credentialHash(paired.token), hostId));
      expect(registry.admissionSet()).toEqual([hash]);
      let changes = 0;
      registry.onAdmissionChange(() => (changes += 1));

      devices.setRoutes(paired.device.id, "local");
      const held = registry.holdAdmission(paired.device.id, 300);
      expect(registry.admissionSet()).toEqual([hash]);
      vi.advanceTimersByTime(299);
      expect(registry.admissionSet()).toEqual([hash]);
      expect(changes).toBe(0);
      vi.advanceTimersByTime(1);
      await held;
      expect(registry.admissionSet()).toEqual([]);
      expect(changes).toBe(1);
      expect(registry.descriptor(paired.device.id)).toMatchObject({ h: expect.any(String), r: ["relay1.openmausbot.com"], routes: "local" });
    } finally {
      vi.useRealTimers();
    }
  });
});
