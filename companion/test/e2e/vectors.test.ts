import { createCipheriv, createECDH, createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  admission,
  admissionHash,
  b64u,
  credentialHash,
  ed25519PrivateKey,
  ed25519RawPublicKey,
  fromB64u,
  keyId,
  mintRelayToken,
  psk,
  verifyRelayToken,
} from "../../src/e2e/credentials.ts";
import { parseDescriptor } from "../../src/e2e/descriptor.ts";
import { VECTORS_FILE, VECTORS_HASH_FILE, vectorsText } from "../../src/e2e/gen-vectors.ts";
import {
  computerAccept,
  isPublicKey,
  keyPairFromPrivate,
  phoneHello,
  type SessionKeys,
  type TraceStep,
  type TransportByte,
} from "../../src/e2e/noise.ts";
import { decodeFrame, encodeFrame, Mux, YamuxError, type Frame, type Role } from "../../src/e2e/yamux.ts";

const text = readFileSync(VECTORS_FILE, "utf8");
const v = JSON.parse(text);
const bytes = (hex: string) => Buffer.from(hex, "hex");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

const T = keyPairFromPrivate(bytes(v.inputs.transportPrivate));
const phoneE = keyPairFromPrivate(bytes(v.inputs.phoneEphemeralPrivate));
const computerE = keyPairFromPrivate(bytes(v.inputs.computerEphemeralPrivate));
const pskOf = (name: string) => bytes(v.V1.credentials.find((c: { name: string }) => c.name === name).psk);
const PSKS: Record<string, Buffer> = {
  device: pskOf("device"),
  pairing: pskOf("pairing"),
  other: psk(credentialHash(v.inputs.otherDeviceToken), keyId(T.publicKey)),
};
const PAYLOAD1 = Buffer.from(v.inputs.payload1, "utf8");

function phone(transport: TransportByte, pskName: string, trace?: TraceStep[]) {
  return phoneHello({ remoteStatic: T.publicKey, psk: PSKS[pskName], transport, ephemeral: phoneE, trace }, PAYLOAD1, v.inputs.connB64u);
}

function computer(transport: TransportByte, candidates: string[], message1: Uint8Array, trace?: TraceStep[]) {
  return computerAccept(
    { staticKey: T, transport, candidates: candidates.map((id) => ({ id, psk: PSKS[id] })), ephemeral: computerE, trace },
    message1,
  );
}

describe("the checked-in vectors", () => {
  it("match their pinned SHA-256", () => {
    const [digest, name] = readFileSync(VECTORS_HASH_FILE, "utf8").trim().split(/\s+/);
    expect(name).toBe("v1.json");
    expect(sha256(Buffer.from(text, "utf8")).toString("hex")).toBe(digest);
  });

  it("are exactly what the generator makes, so a change to the wire cannot slip in", () => {
    expect(vectorsText()).toBe(text);
  });
});

describe("V1 derivations", () => {
  it("derive T.pub, keyId and every credential value from the inputs", () => {
    expect(T.publicKey.toString("hex")).toBe(v.V1.transportPublic);
    expect(b64u(T.publicKey)).toBe(v.V1.transportPublicB64u);
    expect(keyId(T.publicKey).toString("hex")).toBe(v.V1.keyId);
    for (const credential of v.V1.credentials) {
      const hash = credentialHash(credential.token);
      expect(hash.toString("hex")).toBe(credential.credHash);
      expect(psk(hash, bytes(v.V1.keyId)).toString("hex")).toBe(credential.psk);
      const adm = admission(hash, bytes(v.inputs.hostId));
      expect(adm.toString("hex")).toBe(credential.adm);
      expect(b64u(adm)).toBe(credential.admB64u);
      expect(admissionHash(adm)).toBe(credential.admHash);
    }
  });

  it("follow the labels literally", () => {
    const hash = credentialHash(v.inputs.deviceToken);
    const label = (text: string) => Buffer.from(text, "utf8");
    const viaHmac = (msg: Buffer) => createHmac("sha256", hash).update(msg).digest("hex");
    expect(viaHmac(Buffer.concat([label("omb-e2e psk v1"), bytes(v.V1.keyId)]))).toBe(v.V1.credentials[0].psk);
    expect(viaHmac(Buffer.concat([label("omb-relay admission v1"), bytes(v.inputs.hostId)]))).toBe(v.V1.credentials[0].adm);
    expect(sha256(T.publicKey).subarray(0, 16).toString("hex")).toBe(v.V1.keyId);
  });

  it("accept only the canonical uncompressed point", () => {
    for (const point of v.V1.points) expect(isPublicKey(bytes(point.hex)), point.name).toBe(point.valid);
  });
});

/** Every step written out from the spec text, with HKDF as Noise defines it (HMAC chains) rather than the
 * library HKDF the reference uses, and no shared code, so the reference cannot agree with itself by accident. */
function straightLine(transport: number, pskBytes: Buffer) {
  const hash = (...parts: Uint8Array[]) => sha256(Buffer.concat(parts));
  const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();
  const hkdf = (ck: Buffer, ikm: Uint8Array, n: number) => {
    const temp = hmac(ck, ikm);
    const out: Buffer[] = [];
    for (let index = 1; index <= n; index += 1) out.push(hmac(temp, Buffer.concat([out[index - 2] ?? Buffer.alloc(0), Buffer.from([index])])));
    return out;
  };
  const seal = (key: Buffer, ad: Buffer, plaintext: Buffer) => {
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12), { authTagLength: 16 });
    cipher.setAAD(ad);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };
  const dh = (priv: Buffer, pub: Buffer) => {
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(priv);
    return curve.computeSecret(pub);
  };
  let h: Buffer = Buffer.concat([Buffer.from("Noise_NKpsk0_P256_AESGCM_SHA256"), Buffer.alloc(1)]);
  let ck: Buffer = h;
  let k: Buffer;
  h = hash(h, Buffer.from([...Buffer.from("omb-e2e/1"), 0, transport]));
  h = hash(h, T.publicKey);
  let tempH: Buffer;
  [ck, tempH, k] = hkdf(ck, pskBytes, 3);
  h = hash(h, tempH);
  h = hash(h, phoneE.publicKey);
  [ck, k] = hkdf(ck, phoneE.publicKey, 2);
  [ck, k] = hkdf(ck, dh(phoneE.privateKey, T.publicKey), 2);
  const c1 = seal(k, h, PAYLOAD1);
  h = hash(h, c1);
  h = hash(h, computerE.publicKey);
  [ck, k] = hkdf(ck, computerE.publicKey, 2);
  [ck, k] = hkdf(ck, dh(computerE.privateKey, phoneE.publicKey), 2);
  const c2 = seal(k, h, Buffer.from(v.inputs.payload2, "utf8"));
  h = hash(h, c2);
  const [kPc, kCp] = hkdf(ck, Buffer.alloc(0), 2);
  return {
    message1: Buffer.concat([phoneE.publicKey, c1]).toString("hex"),
    message2: Buffer.concat([computerE.publicKey, c2]).toString("hex"),
    kPc: kPc.toString("hex"),
    kCp: kCp.toString("hex"),
    handshakeHash: h.toString("hex"),
  };
}

describe.each([
  ["V2", 1 as TransportByte, "device"],
  ["V3", 2 as TransportByte, "pairing"],
])("%s handshake", (name, transport, pskName) => {
  const vector = v[name];

  it("matches an independent straight-line derivation", () => {
    expect(vector.prologue).toBe(Buffer.from([...Buffer.from("omb-e2e/1"), 0, transport]).toString("hex"));
    expect(straightLine(transport, PSKS[pskName])).toEqual({
      message1: vector.message1,
      message2: vector.message2,
      kPc: vector.kPc,
      kCp: vector.kCp,
      handshakeHash: vector.handshakeHash,
    });
  });

  it("gives the same bytes and state at every step on both sides", () => {
    const phoneTrace: TraceStep[] = [];
    const hello = phone(transport, pskName, phoneTrace);
    expect(hello.message1.toString("hex")).toBe(vector.message1);
    const computerTrace: TraceStep[] = [];
    const accepted = computer(transport, ["other", pskName], hello.message1, computerTrace);
    expect(accepted?.id).toBe(pskName);
    expect(accepted?.payload1).toEqual({ v: 1, conn: v.inputs.connB64u, app: "vector/1" });
    expect(accepted?.message2.toString("hex")).toBe(vector.message2);
    const keys = hello.finish(accepted!.message2);
    expect(phoneTrace).toEqual(vector.trace);
    expect(computerTrace).toEqual(vector.trace);
    for (const side of [keys, accepted!.keys]) {
      expect(side.kPc.toString("hex")).toBe(vector.kPc);
      expect(side.kCp.toString("hex")).toBe(vector.kCp);
      expect(side.handshakeHash.toString("hex")).toBe(vector.handshakeHash);
    }
  });
});

function v2Sessions(): { phone: SessionKeys; computer: SessionKeys } {
  const hello = phone(1, "device");
  const accepted = computer(1, ["device"], hello.message1)!;
  return { phone: hello.finish(accepted.message2), computer: accepted.keys };
}

describe("V4 transport records", () => {
  it("seal each frame under its direction's key and counter, and open on the other side", () => {
    const { phone: phoneKeys, computer: computerKeys } = v2Sessions();
    for (const record of v.V4.records) {
      const [sender, receiver] = record.direction === "pc" ? [phoneKeys, computerKeys] : [computerKeys, phoneKeys];
      expect(sender.send.nonce).toBe(record.n);
      expect(record.nonce).toBe(`00000000${record.n.toString(16).padStart(16, "0")}`);
      expect(sender.send.seal(bytes(record.frame)).toString("hex")).toBe(record.record);
      expect(receiver.receive.open(bytes(record.record)).toString("hex")).toBe(record.frame);
    }
  });
});

describe("V5 yamux codec", () => {
  it("encodes and decodes every frame byte for byte", () => {
    for (const frame of v.V5) {
      const encoded = bytes(frame.hex);
      const decoded = decodeFrame(encoded);
      expect({ type: decoded.type, flags: decoded.flags, streamId: decoded.streamId, length: decoded.length }, frame.name).toEqual({
        type: frame.type,
        flags: frame.flags,
        streamId: frame.streamId,
        length: frame.length,
      });
      expect(encodeFrame(decoded).toString("hex"), frame.name).toBe(frame.hex);
    }
  });
});

describe("V6 must fail", () => {
  it.each(v.V6.handshake as Array<{ name: string; side: string; transport: TransportByte; candidates: string[]; message1: string; message2: string }>)("handshake: $name", (c) => {
    if (c.side === "computer") {
      expect(computer(c.transport, c.candidates, bytes(c.message1))).toBeNull();
    } else {
      const hello = phone(1, "device");
      expect(() => hello.finish(bytes(c.message2))).toThrow();
    }
  });

  it.each(v.V6.records as Array<{ name: string; receiver: string; records: string[]; failsAt: number }>)("record: $name", (c) => {
    const keys = v2Sessions();
    const receiver = c.receiver === "computer" ? keys.computer.receive : keys.phone.receive;
    let failedAt = -1;
    for (const [index, record] of c.records.entries()) {
      try {
        receiver.open(bytes(record));
      } catch {
        failedAt = index;
        break;
      }
    }
    expect(failedAt).toBe(c.failsAt);
  });

  it.each(v.V6.frames as Array<{ name: string; hex: string }>)("frame: $name", (c) => {
    expect(() => decodeFrame(bytes(c.hex))).toThrow(YamuxError);
  });

  it.each(v.V6.sessions as Array<{ name: string; role: Role; accept?: string; steps: ScriptStep[]; expect: { errorAt?: number; sent?: string[] } }>)("session: $name", (c) => {
    expect(runScript(c.role, c.accept, c.steps)).toEqual(c.expect);
  });
});

type ScriptStep = { open: true } | { consume: { stream: number; bytes: number } } | { in: { header: string; payload?: string; fill?: number } };

/** Reads the script exactly as a phone implementation would, from the JSON alone. */
function runScript(role: Role, accept: string | undefined, steps: ScriptStep[]) {
  const sent: string[] = [];
  const mux: Mux = new Mux(role, {
    send: (frame: Frame) => sent.push(encodeFrame(frame).toString("hex")),
    opened: (id) => (accept === "never" ? undefined : mux.accept(id)),
    data: () => {},
    ended: () => {},
    reset: () => {},
    writable: () => {},
  });
  for (const [index, step] of steps.entries()) {
    try {
      if ("open" in step) mux.open();
      else if ("consume" in step) mux.consumed(step.consume.stream, step.consume.bytes);
      else {
        const header = bytes(step.in.header);
        const length = header.readUInt32BE(8);
        const payload = step.in.fill !== undefined ? Buffer.alloc(length, step.in.fill) : bytes(step.in.payload ?? "");
        mux.receive(decodeFrame(Buffer.concat([header, payload])));
      }
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      return { errorAt: index };
    }
  }
  return { sent };
}

describe("V7 pairing descriptor", () => {
  it.each(v.V7.valid as Array<{ name: string; value: string; chars: number; parsed: unknown }>)("accepts $name", (c) => {
    expect(c.value.length).toBe(c.chars);
    const result = parseDescriptor(c.value);
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") expect(result.descriptor).toEqual(c.parsed);
  });

  it.each(v.V7.invalid as Array<{ name: string; value: string; outcome: string }>)("refuses $name", (c) => {
    expect(parseDescriptor(c.value).outcome).toBe(c.outcome);
  });
});

describe("V8 relay token", () => {
  it("mints the pinned token from the pinned claims and key", () => {
    const key = ed25519PrivateKey(bytes(v.V8.seed));
    expect(ed25519RawPublicKey(key).toString("hex")).toBe(v.V8.publicKey);
    expect(mintRelayToken(v.V8.claims, key)).toBe(v.V8.token);
    expect(Buffer.from(v.V8.token.split(".")[0], "base64url").toString("utf8")).toBe(v.V8.payloadJson);
  });

  it.each(v.V8.verify as Array<{ name: string; token: string; keys: Record<string, string>; now: number; expectHid?: string; ok: boolean; error?: string }>)("verify: $name", (c) => {
    const keys = new Map(Object.entries(c.keys).map(([kid, raw]) => [kid, fromB64u(raw)!]));
    const result = verifyRelayToken(c.token, keys, c.now, c.expectHid);
    expect(result.ok).toBe(c.ok);
    if (!result.ok) expect(result.error).toBe(c.error);
  });
});

describe("V9 relay messages", () => {
  it("carry the V1 admission values", () => {
    const [device, pairing] = v.V1.credentials;
    expect(v.V9.host[1].set).toEqual([device.admHash, pairing.admHash]);
    expect(v.V9.phone[0]).toEqual({ t: "phone", v: 1, hid: v.V1.hostIdB64u, adm: device.admB64u });
  });
});
