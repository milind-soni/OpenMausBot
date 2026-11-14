import { describe, expect, it } from "vitest";

import { decodeBase32, hotp, parseTotpKey, totpCode, type TotpAlgorithm } from "./totp.ts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function encodeBase32(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

// RFC 6238 Appendix B: the ASCII seeds, 8-digit codes, 30-second steps.
const SEEDS: Record<TotpAlgorithm, string> = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
};
const VECTORS: Array<[number, Record<TotpAlgorithm, string>]> = [
  [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
  [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
  [1111111111, { SHA1: "14050471", SHA256: "67062674", SHA512: "99943326" }],
  [1234567890, { SHA1: "89005924", SHA256: "91819424", SHA512: "93441116" }],
  [2000000000, { SHA1: "69279037", SHA256: "90698825", SHA512: "38618901" }],
  [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
];

describe("TOTP (RFC 6238)", () => {
  for (const [seconds, codes] of VECTORS) {
    for (const algorithm of ["SHA1", "SHA256", "SHA512"] as const) {
      it(`${algorithm} at T=${seconds} is ${codes[algorithm]}`, () => {
        const secret = encodeBase32(Buffer.from(SEEDS[algorithm], "ascii"));
        expect(totpCode({ secret, algorithm, digits: 8, period: 30 }, seconds * 1000)).toBe(codes[algorithm]);
      });
    }
  }

  it("matches RFC 4226's HOTP table for counters 0–9", () => {
    const key = Buffer.from(SEEDS.SHA1, "ascii");
    expect(Array.from({ length: 10 }, (_, counter) => hotp(key, counter, 6)))
      .toEqual(["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]);
  });

  it("steps by the key's own period", () => {
    const raw = Buffer.from(SEEDS.SHA1, "ascii");
    const key = { secret: encodeBase32(raw), algorithm: "SHA1" as const, digits: 6, period: 60 };
    expect(totpCode(key, 59_999)).toBe(hotp(raw, 0, 6));
    expect(totpCode(key, 60_000)).toBe(hotp(raw, 1, 6));
    expect(totpCode(key, 119_999)).toBe(hotp(raw, 1, 6));
  });

  it("keeps the code for the whole step and changes at its edge", () => {
    const key = { secret: encodeBase32(Buffer.from(SEEDS.SHA1, "ascii")), algorithm: "SHA1" as const, digits: 6, period: 30 };
    expect(totpCode(key, 30_000)).toBe(totpCode(key, 59_999));
    expect(totpCode(key, 60_000)).not.toBe(totpCode(key, 59_999));
  });
});

describe("2FA setup keys", () => {
  it("decodes base32 the way authenticator apps write it", () => {
    expect(decodeBase32("JBSW Y3DP-EHPK 3PXP")?.toString("hex")).toBe("48656c6c6f21deadbeef");
    expect(decodeBase32("jbswy3dpehpk3pxp")?.toString("hex")).toBe("48656c6c6f21deadbeef");
    expect(decodeBase32("not base32!")).toBeNull();
  });

  it("reads a bare secret with the usual defaults", () => {
    expect(parseTotpKey(" jbsw y3dp ehpk 3pxp ")).toEqual({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("reads an otpauth:// address with its parameters", () => {
    expect(parseTotpKey("otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60"))
      .toEqual({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 8, period: 60 });
  });

  it.each([
    ["a counter-based key", "otpauth://hotp/Example?secret=JBSWY3DPEHPK3PXP&counter=1"],
    ["a key shorter than 80 bits", "JBSWY3DP"],
    ["an unknown algorithm", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5"],
    ["too many digits", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=10"],
    ["no secret", "otpauth://totp/x?issuer=Example"],
    ["something else", "hello there"],
    ["nothing", ""],
  ])("refuses %s", (_name, raw) => {
    expect(parseTotpKey(raw)).toBeNull();
  });
});
