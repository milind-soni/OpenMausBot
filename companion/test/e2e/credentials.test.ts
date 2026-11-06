import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  b64u,
  credentialHash,
  credentialHashFromHex,
  ed25519RawPublicKey,
  fromB64u,
  mintRelayToken,
  RELAY_TOKEN_MAX_CHARS,
  sameBytes,
  verifyRelayToken,
} from "../../src/e2e/credentials.ts";
import { descriptorFor, encodeDescriptor, parseDescriptor } from "../../src/e2e/descriptor.ts";
import { generateKeyPair } from "../../src/e2e/noise.ts";

describe("base64url", () => {
  it("decodes only the canonical unpadded spelling", () => {
    const bytes = Buffer.from([0xfb, 0xff, 0x01]);
    expect(fromB64u(b64u(bytes))).toEqual(bytes);
    expect(fromB64u("-_8B")).toEqual(bytes);
    expect(fromB64u("-_8")).toEqual(bytes.subarray(0, 2));
    for (const bad of ["+/8B", "-_8B=", "-_9", "A", "-_ 8B", "AB==", "AR"]) expect(fromB64u(bad), bad).toBeNull();
  });
});

describe("the stored token hash", () => {
  it("is the hex the desktop already keeps, and nothing else parses", () => {
    const hash = credentialHash("omb_example");
    expect(credentialHashFromHex(hash.toString("hex"))).toEqual(hash);
    expect(credentialHashFromHex(hash.toString("hex").toUpperCase())).toBeNull();
    expect(credentialHashFromHex("abc")).toBeNull();
  });

  it("compares full length", () => {
    expect(sameBytes(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(sameBytes(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
  });
});

describe("relay tokens", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const keys = new Map([["k1", ed25519RawPublicKey(privateKey)]]);
  const hid = b64u(Buffer.alloc(16, 9));
  const claims = { v: 1 as const, kid: "k1", hid, iid: "install", iat: 1_000, exp: 1_000 + 12 * 3600 };

  it("verify until exp, and not at exp", () => {
    const token = mintRelayToken(claims, privateKey);
    expect(verifyRelayToken(token, keys, claims.exp - 1)).toEqual({ ok: true, claims });
    expect(verifyRelayToken(token, keys, claims.exp)).toEqual({ ok: false, error: "expired" });
  });

  it("cap the size before parsing", () => {
    expect(verifyRelayToken("a".repeat(RELAY_TOKEN_MAX_CHARS + 1), keys, 2_000)).toEqual({ ok: false, error: "malformed" });
  });

  it("refuse a payload that is not an object, or lacks a field", () => {
    const signed = (payload: unknown) => {
      const body = b64u(Buffer.from(JSON.stringify(payload)));
      return mintRelayToken(claims, privateKey).replace(/^[^.]+/, body);
    };
    expect(verifyRelayToken(signed([1]), keys, 2_000)).toEqual({ ok: false, error: "malformed" });
    expect(verifyRelayToken(signed({ ...claims, v: 2 }), keys, 2_000)).toEqual({ ok: false, error: "malformed" });
  });
});

describe("descriptors", () => {
  it("round-trip, with and without the relay", () => {
    const T = generateKeyPair();
    const withRelay = descriptorFor(T.publicKey, { hostId: Buffer.alloc(16, 1), nodes: ["relay1.openmausbot.com"] });
    const parsed = parseDescriptor(encodeDescriptor(withRelay));
    expect(parsed.outcome === "ok" && parsed.descriptor).toEqual(withRelay);
    const direct = descriptorFor(T.publicKey);
    expect(direct).toEqual({ v: 1, k: b64u(T.publicKey) });
    const parsedDirect = parseDescriptor(encodeDescriptor(direct));
    expect(parsedDirect.outcome === "ok" && parsedDirect.hostId).toBeNull();
  });

  it("parse a response field given as an object too", () => {
    const T = generateKeyPair();
    expect(parseDescriptor({ v: 1, k: b64u(T.publicKey) }).outcome).toBe("ok");
    expect(parseDescriptor({ v: 3 }).outcome).toBe("update");
    expect(parseDescriptor(null).outcome).toBe("reject");
  });
});
