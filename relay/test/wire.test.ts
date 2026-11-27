import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { decodeB64u, parseAdmit, parseAuth, parseData, parseObject, parsePhoneHello } from "../src/wire.ts";

const V9 = JSON.parse(readFileSync(new URL("./vectors/e2e-v1.json", import.meta.url), "utf8")).V9;
const b64 = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill).toString("base64url");

describe("decodeB64u", () => {
  test("is strict: URL-safe alphabet, no padding, canonical, exact length", () => {
    assert.deepEqual(decodeB64u("AAEC"), Buffer.from([0, 1, 2]));
    assert.equal(decodeB64u("AAE="), undefined);
    assert.equal(decodeB64u("+/8"), undefined);
    assert.equal(decodeB64u("_-8")?.length, 2);
    assert.equal(decodeB64u("AB"), undefined, "a stray low bit");
    assert.equal(decodeB64u("AA")?.length, 1);
    assert.equal(decodeB64u("A"), undefined);
    assert.equal(decodeB64u(b64(16), 16)?.length, 16);
    assert.equal(decodeB64u(b64(16), 32), undefined);
    assert.equal(decodeB64u(7), undefined);
    assert.equal(decodeB64u("A".repeat(5000)), undefined);
  });
});

describe("message parsing", () => {
  test("parseObject takes only a JSON object", () => {
    assert.deepEqual(parseObject('{"a":1}'), { a: 1 });
    for (const text of ["[]", "null", "1", '"x"', "{", "", '{"a":1}x']) assert.equal(parseObject(text), undefined, text);
    const sneaky = parseObject('{"__proto__":{"admin":true}}')!;
    assert.equal(({} as Record<string, unknown>).admin, undefined);
    assert.equal(Object.getPrototypeOf(sneaky), Object.prototype);
  });

  test("the V9 example messages parse", () => {
    const [auth, admit, data] = V9.host;
    assert.equal(parseAuth(auth), "<V8 token>");
    assert.equal(parseAdmit(admit, 32)?.length, 2);
    assert.deepEqual(parseData(data), { sid: data.sid, token: "<V8 token>" });
    const phone = parsePhoneHello(V9.phone[0])!;
    assert.equal(phone.hidText, V9.phone[0].hid);
    assert.equal(phone.adm.length, 32);
  });

  test("phone hello needs t, v = 1, a 16-byte hid and a 32-byte adm", () => {
    const good = { t: "phone", v: 1, hid: b64(16), adm: b64(32) };
    assert.ok(parsePhoneHello(good));
    for (const bad of [{ ...good, t: "host" }, { ...good, v: 2 }, { ...good, v: "1" }, { ...good, hid: b64(15) }, { ...good, adm: b64(31) }, { ...good, adm: undefined }]) {
      assert.equal(parsePhoneHello(bad), undefined, JSON.stringify(bad));
    }
  });

  test("admit holds at most 32 entries of 32 bytes, duplicates collapse", () => {
    const entries = Array.from({ length: 32 }, (_, i) => b64(32, i + 1));
    assert.equal(parseAdmit({ t: "admit", set: entries }, 32)?.length, 32);
    assert.equal(parseAdmit({ t: "admit", set: [...entries, b64(32, 99)] }, 32), undefined);
    assert.equal(parseAdmit({ t: "admit", set: [entries[0], entries[0]] }, 32)?.length, 1);
    assert.equal(parseAdmit({ t: "admit", set: [] }, 32)?.length, 0);
    assert.equal(parseAdmit({ t: "admit", set: [b64(31)] }, 32), undefined);
    assert.equal(parseAdmit({ t: "admit", set: "x" }, 32), undefined);
    assert.equal(parseAdmit({ t: "admit", set: [7] }, 32), undefined);
  });

  test("auth and data need v = 1 and the right types", () => {
    assert.equal(parseAuth({ t: "auth", v: 1, token: 1 }), undefined);
    assert.equal(parseAuth({ t: "auth", v: 2, token: "x" }), undefined);
    assert.equal(parseData({ t: "data", v: 1, sid: b64(15), token: "x" }), undefined);
    assert.equal(parseData({ t: "data", v: 1, sid: b64(16) }), undefined);
  });
});
