import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseTokenKeys, verifyToken } from "../src/token.ts";
import { keysJson, mintToken, testKey } from "./helpers.ts";

/** The SHA-256 the wire spec pins for vectors/v1.json; a stale copy here fails. */
const PINNED_VECTORS = "525279254e73d3a953957a9b8dd7b044051fa2d10ce349f409535022a5fbe30a";
const vectorsText = readFileSync(new URL("./vectors/e2e-v1.json", import.meta.url));
const vectors = JSON.parse(vectorsText.toString("utf8"));
const V8 = vectors.V8;
const NOW = 1_793_836_860;

describe("shared vectors", () => {
  test("the copy is the pinned file, and matches the companion's pin when that is in the tree", () => {
    assert.equal(createHash("sha256").update(vectorsText).digest("hex"), PINNED_VECTORS);
    const companionPin = new URL("../../companion/src/e2e/vectors/v1.sha256", import.meta.url);
    if (existsSync(companionPin)) assert.equal(readFileSync(companionPin, "utf8").trim().split(/\s+/)[0], PINNED_VECTORS);
  });
});

describe("V8 relay token", () => {
  for (const vector of V8.verify) {
    test(vector.name, () => {
      const result = verifyToken(vector.token, parseTokenKeys(JSON.stringify(vector.keys)), vector.now, vector.expectHid);
      assert.equal(result.ok, vector.ok);
      if (!result.ok) assert.equal(result.reason, vector.error);
      else assert.equal(result.claims.hidText, V8.claims.hid);
    });
  }

  test("the vector key and token come out byte for byte from the seed and claims", () => {
    const seed = Buffer.from(V8.seed, "hex");
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    assert.equal(createPublicKey(privateKey).export({ format: "jwk" }).x, V8.publicKeyB64u);
    const body = Buffer.from(V8.payloadJson, "utf8").toString("base64url");
    assert.equal(`${body}.${sign(null, Buffer.from(body, "ascii"), privateKey).toString("base64url")}`, V8.token);
    const result = verifyToken(V8.token, parseTokenKeys(JSON.stringify(V8.relayTokenKeys)), NOW);
    assert.ok(result.ok);
    const { kid, hidText, iid, iat, exp } = result.claims;
    assert.deepEqual({ v: 1, kid, hid: hidText, iid, iat, exp }, V8.claims);
  });
});

describe("token rules the vectors leave implicit", () => {
  const key = testKey();
  const keys = parseTokenKeys(keysJson(key));
  const now = 1_800_000_000;
  const reason = (token: unknown, at = now) => {
    const result = verifyToken(token, keys, at);
    return result.ok ? "ok" : result.reason;
  };

  test("a fresh token passes until exp, then fails as expired", () => {
    const token = mintToken(key, {}, now);
    assert.equal(reason(token), "ok");
    assert.equal(reason(token, now + 12 * 3600 - 1), "ok");
    assert.equal(reason(token, now + 12 * 3600), "expired");
  });

  test("shape: not a string, too long, padding, non-canonical base64url, a short signature", () => {
    const token = mintToken(key, {}, now);
    const [body, signature] = token.split(".") as [string, string];
    assert.equal(reason(42), "malformed");
    assert.equal(reason(`${body}.${signature}${"A".repeat(2048)}`), "malformed");
    assert.equal(reason(`${body}=.${signature}`), "malformed");
    assert.equal(reason(`${body}.${signature}=`), "malformed");
    assert.equal(reason(`${body.replace(/-/g, "+")}.${signature}`), body.includes("-") ? "malformed" : "ok");
    const last = signature.at(-1)!;
    const sibling = String.fromCharCode(last.charCodeAt(0) ^ 1);
    assert.equal(reason(`${body}.${signature.slice(0, -1)}${sibling}`), "malformed", "a stray low bit in the last character");
    assert.equal(reason(`${body}.${Buffer.alloc(63).toString("base64url")}`), "malformed");
    assert.equal(reason(`.${signature}`), "malformed");
  });

  test("claims: v, kid form, hid size, iid size, positive integer times, at most 12 h", () => {
    const hid = Buffer.alloc(16, 7).toString("base64url");
    assert.equal(reason(mintToken(key, { v: 2 }, now)), "malformed");
    assert.equal(reason(mintToken(key, { hid: Buffer.alloc(15).toString("base64url") }, now)), "malformed");
    assert.equal(reason(mintToken(key, { hid, iid: "" }, now)), "malformed");
    assert.equal(reason(mintToken(key, { hid, iid: "x".repeat(65) }, now)), "malformed");
    assert.equal(reason(mintToken(key, { hid, iid: "x".repeat(64) }, now)), "ok");
    assert.equal(reason(mintToken(key, { iat: 0, exp: 3600 }, now), 1), "malformed");
    assert.equal(reason(mintToken(key, { iat: now, exp: now }, now)), "malformed");
    assert.equal(reason(mintToken(key, { iat: now + 0.5, exp: now + 3600 }, now)), "malformed");
    assert.equal(reason(mintToken(key, { exp: now + 12 * 3600 + 1 }, now)), "malformed");
    const other = testKey("K1");
    assert.equal(reason(mintToken(other, {}, now)), "malformed", "a kid outside k0 … k999");
  });

  test("a token signed with the second key of a rotation pair passes, one from an unknown kid fails as kid", () => {
    const next = testKey("k2");
    const pair = parseTokenKeys(keysJson(key, next));
    assert.ok(verifyToken(mintToken(next, {}, now), pair, now).ok);
    assert.equal(reason(mintToken(next, {}, now)), "kid");
  });

  test("RELAY_TOKEN_KEYS takes one or two well-formed keys and refuses anything else", () => {
    assert.throws(() => parseTokenKeys("[]"));
    assert.throws(() => parseTokenKeys("{}"));
    assert.throws(() => parseTokenKeys(keysJson(testKey("k1"), testKey("k2"), testKey("k3"))));
    assert.throws(() => parseTokenKeys(JSON.stringify({ k1: Buffer.alloc(31).toString("base64url") })));
    assert.throws(() => parseTokenKeys(JSON.stringify({ key1: key.publicB64u })));
    assert.equal(parseTokenKeys(keysJson(key)).size, 1);
  });
});
