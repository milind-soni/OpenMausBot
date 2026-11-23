import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { b64u, fromB64u, utf8, type Bytes } from "./bytes.ts";
import { admission, credentialHash, keyId, psk } from "./credentials.ts";
import { CONN_BYTES, encodePayload1, importKeyPair, isPublicKey, phoneHello, prologue, type SessionKeys, type TraceStep, type TransportByte } from "./noise.ts";

const VECTORS = new URL("../../../companion/src/e2e/vectors/", import.meta.url);
const text = readFileSync(new URL("v1.json", VECTORS), "utf8");
const v = JSON.parse(text);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");

const T_PUB = bytes(v.V1.transportPublic);
const pskOf = (name: string) => bytes(v.V1.credentials.find((c: { name: string }) => c.name === name).psk);
const PSKS: Record<string, Bytes> = { device: pskOf("device"), pairing: pskOf("pairing") };
const PAYLOAD1 = utf8(v.inputs.payload1);

const phoneEphemeral = () => importKeyPair(bytes(v.inputs.phoneEphemeralPrivate), bytes(v.V1.phoneEphemeralPublic));

/** Each promise's outcome, in the order they settled (not the order they were made). */
async function settledInOrder(promises: Promise<unknown>[]) {
  const order: string[] = [];
  await Promise.allSettled(
    promises.map((p, i) => p.then(() => order.push(`${i}:opened`), (e: Error) => order.push(`${i}:${e.message}`))),
  );
  return order;
}

async function phone(transport: TransportByte, pskName: string, trace?: TraceStep[]) {
  return phoneHello({ remoteStatic: T_PUB, psk: PSKS[pskName], transport, ephemeral: await phoneEphemeral(), trace }, PAYLOAD1);
}

async function v2Session(): Promise<SessionKeys> {
  const hello = await phone(1, "device");
  return hello.finish(bytes(v.V2.message2));
}

describe("the shared vectors", () => {
  it("are the pinned file", () => {
    const [digest] = readFileSync(new URL("v1.sha256", VECTORS), "utf8").trim().split(/\s+/);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(digest);
  });
});

describe("the browser modules", () => {
  it.each(["bytes.ts", "credentials.ts", "noise.ts", "session.ts", "yamux.ts"])("%s uses no Node-only API", (name) => {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:|\bBuffer\b|\bprocess\./);
  });
});

describe("V1 derivations", () => {
  it("give keyId and every credential value", async () => {
    expect(hex(await keyId(T_PUB))).toBe(v.V1.keyId);
    expect(b64u(T_PUB)).toBe(v.V1.transportPublicB64u);
    expect(v.V1.credentials.length).toBeGreaterThan(0);
    for (const credential of v.V1.credentials) {
      const hash = await credentialHash(credential.token);
      expect(hex(hash)).toBe(credential.credHash);
      expect(hex(await psk(hash, bytes(v.V1.keyId)))).toBe(credential.psk);
      const adm = await admission(hash, bytes(v.inputs.hostId));
      expect(hex(adm)).toBe(credential.adm);
      expect(b64u(adm)).toBe(credential.admB64u);
    }
  });

  it("accept only the canonical uncompressed point", async () => {
    expect(v.V1.points.length).toBeGreaterThan(0);
    for (const point of v.V1.points) expect(await isPublicKey(bytes(point.hex)), point.name).toBe(point.valid);
  });
});

describe("strict b64u", () => {
  it("round-trips and refuses padding, other alphabets and non-canonical spellings", () => {
    expect(hex(fromB64u(v.inputs.connB64u)!)).toBe(v.inputs.conn);
    expect(b64u(bytes(v.inputs.conn))).toBe(v.inputs.connB64u);
    expect(fromB64u("")).toEqual(new Uint8Array(0));
    expect(fromB64u("AA")).toEqual(new Uint8Array([0]));
    expect(fromB64u("AAE")).toEqual(new Uint8Array([0, 1]));
    expect(fromB64u("-_8")).toEqual(new Uint8Array([0xfb, 0xff]));
    for (const bad of ["AA==", "AA=", "A", "AB+/", "AB c", "AB", "AAB", "AAAAA"]) expect(fromB64u(bad), bad).toBeNull();
  });
});

describe.each([
  ["V2", 1 as TransportByte, "device"],
  ["V3", 2 as TransportByte, "pairing"],
])("%s handshake, phone side", (name, transport, pskName) => {
  const vector = v[name];

  it("gives the pinned bytes and the pinned state at every step", async () => {
    expect(hex(prologue(transport))).toBe(vector.prologue);
    const trace: TraceStep[] = [];
    const hello = await phone(transport, pskName, trace);
    expect(hex(hello.message1)).toBe(vector.message1);
    const keys = await hello.finish(bytes(vector.message2));
    expect(trace).toEqual(vector.trace);
    expect(hex(keys.kPc)).toBe(vector.kPc);
    expect(hex(keys.kCp)).toBe(vector.kCp);
    expect(hex(keys.handshakeHash)).toBe(vector.handshakeHash);
  });
});

describe("V4 transport records, phone side", () => {
  it("seals what the phone sends and opens what the computer sends, counter by counter", async () => {
    const keys = await v2Session();
    expect(v.V4.records.some((r: { direction: string }) => r.direction === "cp")).toBe(true);
    for (const record of v.V4.records) {
      if (record.direction === "pc") {
        expect(keys.send.nonce).toBe(record.n);
        expect(hex(await keys.send.seal(bytes(record.frame)))).toBe(record.record);
      } else {
        expect(keys.receive.nonce).toBe(record.n);
        expect(hex(await keys.receive.open(bytes(record.record)))).toBe(record.frame);
      }
    }
  });
});

describe("V6 must fail, phone side", () => {
  const phoneCases = (v.V6.handshake as Array<{ name: string; side: string; message2: string }>).filter((c) => c.side === "phone");

  it("has phone cases", () => expect(phoneCases.length).toBeGreaterThan(0));

  it.each(phoneCases)("handshake: $name is a hard stop", async (c) => {
    const hello = await phone(1, "device");
    await expect(hello.finish(bytes(c.message2))).rejects.toThrow(/^e2e: /);
  });

  it.each((v.V6.records as Array<{ name: string; receiver: string; records: string[]; failsAt: number }>).filter((c) => c.receiver === "phone"))(
    "record: $name",
    async (c) => {
      const keys = await v2Session();
      let failedAt = -1;
      for (const [index, record] of c.records.entries()) {
        try {
          await keys.receive.open(bytes(record));
        } catch {
          failedAt = index;
          break;
        }
      }
      expect(failedAt).toBe(c.failsAt);
    },
  );

  it("refuses every record after a failed one, even a genuine one", async () => {
    const keys = await v2Session();
    const first = v.V4.records.find((r: { direction: string }) => r.direction === "cp");
    const forged = bytes(first.record);
    forged[0] ^= 1;
    await expect(keys.receive.open(forged)).rejects.toThrow("e2e: aead");
    await expect(keys.receive.open(bytes(first.record))).rejects.toThrow("e2e: failed");
  });

  it("refuses a second finish", async () => {
    const hello = await phone(1, "device");
    await hello.finish(bytes(v.V2.message2));
    await expect(hello.finish(bytes(v.V2.message2))).rejects.toThrow("e2e: finished");
  });

  it("opens the record as it was when open was called, even if the caller changes it afterwards", async () => {
    const keys = await v2Session();
    const first = v.V4.records.find((r: { direction: string }) => r.direction === "cp");
    const record = bytes(first.record);
    const pending = keys.receive.open(record);
    record.fill(0);
    expect(hex(await pending)).toBe(first.frame);
  });

  it("reads message 2 once when finish is called, even from a Buffer the caller changes afterwards", async () => {
    const hello = await phone(1, "device");
    const reply = Buffer.from(v.V2.message2, "hex");
    const pending = hello.finish(reply as unknown as Uint8Array<ArrayBuffer>);
    reply.fill(0);
    await expect(pending).resolves.toBeDefined();
  });

  it("fails an oversized record in its place in the queue: earlier ones open, later ones are refused", async () => {
    const keys = await v2Session();
    const [first, second] = v.V4.records.filter((r: { direction: string }) => r.direction === "cp");
    const order = await settledInOrder([
      keys.receive.open(bytes(first.record)),
      keys.receive.open(new Uint8Array(65_536)),
      keys.receive.open(bytes(second.record)),
    ]);
    expect(order).toEqual(["0:opened", "1:e2e: record_too_large", "2:e2e: failed"]);
  });

  it("fails a record whose buffer was transferred in its place in the queue, without throwing from open", async () => {
    const keys = await v2Session();
    const [first, second] = v.V4.records.filter((r: { direction: string }) => r.direction === "cp");
    const detached = bytes(second.record);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const order = await settledInOrder([
      keys.receive.open(bytes(first.record)),
      keys.receive.open(detached),
      keys.receive.open(bytes(second.record)),
    ]);
    expect(order).toEqual(["0:opened", "1:e2e: bad_record", "2:e2e: failed"]);
  });

  it("refuses a genuine record opened before an earlier failed one settled", async () => {
    const keys = await v2Session();
    const [first, second] = v.V4.records.filter((r: { direction: string }) => r.direction === "cp");
    const forged = bytes(first.record);
    forged[0] ^= 1;
    const results = await Promise.allSettled([keys.receive.open(forged), keys.receive.open(bytes(second.record))]);
    expect(results.map((r) => (r.status === "rejected" ? (r.reason as Error).message : "opened"))).toEqual(["e2e: aead", "e2e: failed"]);
  });
});

describe("payload 1, phone side", () => {
  it("is refused with a connection ID that is not 16 bytes", () => {
    expect(() => encodePayload1(new Uint8Array(CONN_BYTES - 1), "web/1")).toThrow("e2e: bad_conn");
  });

  it("takes an app of up to 40 characters", () => {
    expect(() => encodePayload1(new Uint8Array(CONN_BYTES), "a".repeat(40))).not.toThrow();
    expect(() => encodePayload1(new Uint8Array(CONN_BYTES), "a".repeat(41))).toThrow("e2e: app_too_long");
  });

  it("is refused when it carries no connection ID for message 2 to echo", async () => {
    await expect(phoneHello({ remoteStatic: T_PUB, psk: PSKS.device, transport: 1 }, utf8('{"v":1,"app":"web/1"}'))).rejects.toThrow("e2e: bad_payload1");
  });

  it.each([
    ["v is not 1", '{"v":2,"conn":"XkCuA2LSB-yRqiCTmMwKqQ"}'],
    ["it is an array", '[{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwKqQ"}]'],
    ["conn is 15 bytes", '{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwK"}'],
    ["conn is not canonical base64url", '{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwKqR"}'],
    ["app is not a string", '{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwKqQ","app":7}'],
    ["app is 41 characters", `{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwKqQ","app":"${"a".repeat(41)}"}`],
  ])("is refused as raw bytes when %s", async (_name, json) => {
    await expect(phoneHello({ remoteStatic: T_PUB, psk: PSKS.device, transport: 1 }, utf8(json))).rejects.toThrow("e2e: bad_payload1");
  });

  it("is refused as raw bytes with a leading UTF-8 BOM, which the computer side refuses too", async () => {
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwKqQ"}')]);
    await expect(phoneHello({ remoteStatic: T_PUB, psk: PSKS.device, transport: 1 }, withBom)).rejects.toThrow("e2e: bad_payload1");
  });

  it("takes raw bytes without app", async () => {
    await expect(phoneHello({ remoteStatic: T_PUB, psk: PSKS.device, transport: 1 }, utf8('{"v":1,"conn":"XkCuA2LSB-yRqiCTmMwKqQ"}'))).resolves.toBeDefined();
  });

  it("is read once when the call is made: changing the caller's bytes afterwards changes nothing", async () => {
    const payload1 = PAYLOAD1.slice();
    const pending = phoneHello({ remoteStatic: T_PUB, psk: PSKS.device, transport: 1, ephemeral: await phoneEphemeral() }, payload1);
    payload1.fill(0x20);
    const hello = await pending;
    expect(hex(hello.message1)).toBe(v.V2.message1);
    await expect(hello.finish(bytes(v.V2.message2))).resolves.toBeDefined();
  });
});

describe("caller-owned bytes, phone side", () => {
  it("seals the frame as it was when seal was called, even if the caller changes it afterwards", async () => {
    const keys = await v2Session();
    const record = v.V4.records.find((r: { direction: string }) => r.direction === "pc");
    const frame = bytes(record.frame);
    const pending = keys.send.seal(frame);
    frame.fill(0);
    expect(hex(await pending)).toBe(record.record);
  });

  it("hashes and uses the pinned key and PSK as they were when phoneHello was called", async () => {
    const remoteStatic = T_PUB.slice();
    const secret = PSKS.device.slice();
    const pending = phoneHello({ remoteStatic, psk: secret, transport: 1, ephemeral: await phoneEphemeral() }, PAYLOAD1);
    remoteStatic.fill(0);
    secret.fill(0);
    const hello = await pending;
    expect(hex(hello.message1)).toBe(v.V2.message1);
    await expect(hello.finish(bytes(v.V2.message2))).resolves.toBeDefined();
  });

  it("refuses a wrong-sized pinned key or PSK before copying it, the pinned key first", async () => {
    const neverCopied = (length: number) =>
      ({ length, [Symbol.iterator]: () => { throw new Error("copied"); } }) as unknown as Bytes;
    const hello = (remoteStatic: Bytes, secret: Bytes) => phoneHello({ remoteStatic, psk: secret, transport: 1 }, PAYLOAD1);
    await expect(hello(neverCopied(66), PSKS.device)).rejects.toThrow("e2e: bad_point");
    await expect(hello(T_PUB, neverCopied(33))).rejects.toThrow("e2e: bad_psk");
    await expect(hello(neverCopied(66), neverCopied(33))).rejects.toThrow("e2e: bad_point");
  });
});

describe("the session keys", () => {
  it("are copies: clearing the returned key bytes leaves the cipher working", async () => {
    const keys = await v2Session();
    keys.kPc.fill(0);
    const record = v.V4.records.find((r: { direction: string }) => r.direction === "pc");
    expect(hex(await keys.send.seal(bytes(record.frame)))).toBe(record.record);
  });
});
