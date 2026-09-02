import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { register } from "./index.ts";
import { issueLicenseKey, verifyLicenseKey, type LicenseClaims } from "./license.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" });
  return { x: String(pub.x), privateJwk: privateKey.export({ format: "jwk" }) };
}

const claims: LicenseClaims = {
  v: 1,
  customer: "Reliable Back Office",
  features: ["whitelabel", "sso"],
  issued: "2026-09-02",
  expires: "2027-09-02",
};

describe("license keys", () => {
  it("round-trips claims through a signed key", () => {
    const { x, privateJwk } = keypair();
    const key = issueLicenseKey(claims, privateJwk);
    expect(key.startsWith("omb1.")).toBe(true);
    expect(verifyLicenseKey(key, { publicKeys: [x], now: new Date("2026-12-01") })).toEqual(claims);
  });

  it("accepts a key signed by any listed public key, so rotation is append-only", () => {
    const old = keypair();
    const fresh = keypair();
    const key = issueLicenseKey(claims, old.privateJwk);
    expect(() => verifyLicenseKey(key, { publicKeys: [fresh.x], now: new Date("2026-12-01") })).toThrow(/does not match any OpenMausBot signing key/);
    expect(verifyLicenseKey(key, { publicKeys: [fresh.x, old.x], now: new Date("2026-12-01") }).customer).toBe(claims.customer);
  });

  it("refuses altered claims: the signature covers exactly what is granted", () => {
    const { x, privateJwk } = keypair();
    const key = issueLicenseKey(claims, privateJwk);
    const [prefix, , signature] = key.split(".");
    const upgraded = Buffer.from(JSON.stringify({ ...claims, features: ["whitelabel", "sso", "budgets"] })).toString("base64url");
    expect(() => verifyLicenseKey(`${prefix}.${upgraded}.${signature}`, { publicKeys: [x] })).toThrow(/altered/);
  });

  it("explains malformed keys and expiry in operator terms", () => {
    const { x, privateJwk } = keypair();
    expect(() => verifyLicenseKey("not-a-key", { publicKeys: [x] })).toThrow(/expected "omb1\.<claims>\.<signature>"/);
    expect(() => verifyLicenseKey("omb1..", { publicKeys: [x] })).toThrow(/expected "omb1/);
    const key = issueLicenseKey(claims, privateJwk);
    expect(() => verifyLicenseKey(key, { publicKeys: [x], now: new Date("2027-09-02") })).toThrow(/expired on 2027-09-02; renew it/);
    const perpetual = issueLicenseKey({ ...claims, expires: null }, privateJwk);
    expect(verifyLicenseKey(perpetual, { publicKeys: [x], now: new Date("2099-01-01") }).expires).toBeNull();
  });

  it("refuses dates that are not YYYY-MM-DD on both sides", () => {
    const { x, privateJwk } = keypair();
    expect(() => issueLicenseKey({ ...claims, expires: "not-a-date" }, privateJwk)).toThrow(/expires must be a YYYY-MM-DD date/);
    expect(() => issueLicenseKey({ ...claims, issued: "2026-9-2" }, privateJwk)).toThrow(/issued must be a YYYY-MM-DD date/);
    const forged = Buffer.from(JSON.stringify({ ...claims, expires: "someday" })).toString("base64url");
    const [prefix, , signature] = issueLicenseKey(claims, privateJwk).split(".");
    expect(() => verifyLicenseKey(`${prefix}.${forged}.${signature}`, { publicKeys: [x] })).toThrow(/altered/);
  });

  it("refuses to issue claims that would not verify", () => {
    const { privateJwk } = keypair();
    // SAFETY: deliberately wrong shape to exercise the issuer's own validation
    expect(() => issueLicenseKey({ ...claims, features: [] as string[], customer: "" }, privateJwk)).toThrow();
  });

  it("register() turns a key into the layer contract and passes verification errors through", () => {
    expect(register({ licenseKey: undefined })).toBeNull();
    expect(() => register({ licenseKey: "omb1.bad.key" })).toThrow(/OMB_LICENSE_KEY/);
  });
});
