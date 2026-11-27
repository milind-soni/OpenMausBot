import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { register } from "./index.ts";
import { claimsSchema, issueLicenseKey, LICENSE_PUBLIC_KEYS, validateClaims, verifyLicenseKey, type LicenseClaims } from "./license.ts";

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

/** Signs any claims object, as an issuer that knows more (or fewer) claims than this build would. */
function signRaw(claims: object, privateJwk: ReturnType<typeof keypair>["privateJwk"]): string {
  const part = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(part, "utf8"), createPrivateKey({ key: privateJwk, format: "jwk" }));
  return `omb1.${part}.${signature.toString("base64url")}`;
}

describe("subscription claims: seats, plan, sub, server", () => {
  const subscription: LicenseClaims = { ...claims, seats: 20, plan: "business-server", sub: "sub_123", server: "srv_456", iat: 1_795_000_000_000 };

  it("round-trips the new optional claims in the same omb1 / v:1 format", () => {
    const { x, privateJwk } = keypair();
    const key = issueLicenseKey(subscription, privateJwk);
    expect(key.split(".")[0]).toBe("omb1");
    const verified = verifyLicenseKey(key, { publicKeys: [x], now: new Date("2026-12-01") });
    expect(verified).toEqual(subscription);
    expect(verified.v).toBe(1);
  });

  it("still accepts a licence without them (an old key on a new server)", () => {
    const { x, privateJwk } = keypair();
    const old = signRaw({ v: 1, customer: "Acme", features: ["whitelabel"], issued: "2026-01-01", expires: "2027-01-01" }, privateJwk);
    const verified = verifyLicenseKey(old, { publicKeys: [x], now: new Date("2026-06-01") });
    expect(verified).toEqual({ v: 1, customer: "Acme", features: ["whitelabel"], issued: "2026-01-01", expires: "2027-01-01" });
    expect(verified.seats).toBeUndefined();
  });

  it("is accepted by a server that predates them (a new key on an old server)", () => {
    // The claims schema servers shipped before these fields, verbatim.
    const before = z.object({
      v: z.literal(1),
      customer: z.string().min(1),
      features: z.array(z.string().min(1)),
      issued: z.iso.date("issued must be a YYYY-MM-DD date"),
      expires: z.iso.date("expires must be a YYYY-MM-DD date").nullable(),
    });
    const { privateJwk } = keypair();
    const claimsPart = issueLicenseKey(subscription, privateJwk).split(".")[1];
    const parsed = before.safeParse(JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(claims);
  });

  it("tolerates a claim this build has never heard of, so later claims need no new format", () => {
    const { x, privateJwk } = keypair();
    const future = signRaw({ ...subscription, region: "eu" }, privateJwk);
    expect(verifyLicenseKey(future, { publicKeys: [x], now: new Date("2026-12-01") })).toEqual(subscription);
  });

  it("refuses malformed values for them, on both sides", () => {
    const { x, privateJwk } = keypair();
    for (const bad of [{ seats: 0 }, { seats: 2.5 }, { seats: "20" }, { plan: "" }, { sub: 7 }, { server: "" }, { iat: -1 }, { iat: 1.5 }]) {
      expect(() => issueLicenseKey({ ...claims, ...bad } as LicenseClaims, privateJwk), JSON.stringify(bad)).toThrow();
      expect(() => verifyLicenseKey(signRaw({ ...claims, ...bad }, privateJwk), { publicKeys: [x] }), JSON.stringify(bad)).toThrow(/claims are malformed/);
    }
  });

  it("exports the exact validation an issuer must run before signing", () => {
    expect(validateClaims(subscription)).toEqual(subscription);
    expect(() => validateClaims({ ...claims, seats: 0 })).toThrow("licence claims are malformed (seats:");
    expect(() => validateClaims({ ...claims, plan: "" })).toThrow("licence claims are malformed (plan:");
    expect(validateClaims({ ...claims, region: "eu" })).toEqual(claims);
    expect(claimsSchema.safeParse({ ...claims, iat: 5 }).success).toBe(true);
  });

  it("keeps the public key list append-only: the first key stays first", () => {
    expect(LICENSE_PUBLIC_KEYS[0]).toBe("6CHdwwJzxKJFimRkC79eQ5FR__bX2WaU2BBGNGPQTQU");
    expect(new Set(LICENSE_PUBLIC_KEYS).size).toBe(LICENSE_PUBLIC_KEYS.length);
  });
});

describe("issue-license.mjs, the reference issuer", () => {
  const script = join(import.meta.dirname, "..", "scripts", "issue-license.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60_000 });

  it("writes the new claims, verifies against the public half keygen printed, and prints the same licence twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-issue-license-"));
    try {
      const keyPath = join(dir, "signing-key.json");
      const made = run(["keygen", "--out", keyPath]);
      expect(made.status, made.stderr).toBe(0);
      const publicX = /"([A-Za-z0-9_-]{43})",/.exec(made.stdout)?.[1];
      expect(publicX).toBeDefined();
      // keygen prints only the public half
      const privateD = String(JSON.parse(readFileSync(keyPath, "utf8")).d);
      expect(made.stdout).not.toContain(privateD);
      const args = ["issue", "--key", keyPath, "--customer", "Acme", "--features", "admin,budgets", "--issued", "2026-11-27",
        "--expires", "2026-12-30", "--seats", "20", "--plan", "business-server", "--sub", "sub_123", "--server", "srv_456", "--iat", "1795000000000"];
      const issued = run(args);
      expect(issued.status, issued.stderr).toBe(0);
      const key = issued.stdout.trim();
      expect(verifyLicenseKey(key, { publicKeys: [publicX!], now: new Date("2026-12-01") })).toEqual({
        v: 1, customer: "Acme", features: ["admin", "budgets"], issued: "2026-11-27", expires: "2026-12-30",
        seats: 20, plan: "business-server", sub: "sub_123", server: "srv_456", iat: 1_795_000_000_000,
      });
      expect(run(args).stdout.trim()).toBe(key);
      const plain = run(["issue", "--key", keyPath, "--customer", "Acme", "--features", "admin", "--issued", "2026-11-27"]);
      expect(Object.keys(verifyLicenseKey(plain.stdout.trim(), { publicKeys: [publicX!] }))).toEqual(["v", "customer", "features", "issued", "expires"]);
      const badSeats = run([...args.slice(0, -10), "--seats", "twenty"]);
      expect(badSeats.status).toBe(1);
      expect(badSeats.stderr).toContain("--seats must be a whole number of at least 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

