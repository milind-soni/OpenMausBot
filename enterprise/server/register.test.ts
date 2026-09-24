import { describe, expect, it, vi } from "vitest";

// A throwaway signing pair stands in for the baked-in public key, so the real
// verification (format, signature, expiry) runs against keys the test issues.
const testKey = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { x: String(publicKey.export({ format: "jwk" }).x), privateJwk: privateKey.export({ format: "jwk" }) };
});
vi.mock("./license.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./license.ts")>();
  return {
    ...real,
    verifyLicenseKey: (key: string, options: { now?: Date } = {}) => real.verifyLicenseKey(key, { ...options, publicKeys: [testKey.x] }),
  };
});

import { register } from "./index.ts";
import { issueLicenseKey } from "./license.ts";

const key = issueLicenseKey(
  { v: 1, customer: "Acme", features: ["budgets"], issued: "2026-01-01", expires: "2027-01-01" },
  testKey.privateJwk,
);
const at = (iso: string) => new Date(iso).getTime();

describe("register() grace period", () => {
  it("keeps a key that lapsed less than the grace period ago, with its real expiry", () => {
    expect(register({ licenseKey: key, graceDays: 7, now: at("2027-01-03T12:00:00Z") })).toEqual({
      customer: "Acme", features: ["budgets"], expiresAt: "2027-01-01",
    });
    expect(register({ licenseKey: key, graceDays: 7, now: at("2027-01-07T23:59:59Z") })?.customer).toBe("Acme");
  });

  it("refuses the key once the grace period is over, and without one at the expiry instant", () => {
    expect(() => register({ licenseKey: key, graceDays: 7, now: at("2027-01-08T00:00:00Z") })).toThrow(/expired on 2027-01-01; renew it/);
    expect(() => register({ licenseKey: key, now: at("2027-01-01T00:00:00Z") })).toThrow(/expired on 2027-01-01/);
    expect(register({ licenseKey: key, now: at("2026-12-31T23:59:59Z") })?.expiresAt).toBe("2027-01-01");
  });

  it("clamps an oversized grace instead of trusting it", () => {
    expect(() => register({ licenseKey: key, graceDays: 1_000, now: at("2027-01-20T00:00:00Z") })).toThrow(/expired/);
    expect(() => register({ licenseKey: key, graceDays: Number.NaN, now: at("2027-01-02T00:00:00Z") })).toThrow(/expired/);
  });
});
