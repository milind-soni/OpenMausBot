// Writes vectors/v1.json and vectors/v1.sha256 from fixed inputs: `node companion/src/e2e/gen-vectors.ts`.
// The file is the contract between the desktop, the relay and the phone apps; `--check` fails if it would change.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  admission,
  admissionHash,
  b64u,
  credentialHash,
  ed25519PrivateKey,
  ed25519RawPublicKey,
  keyId,
  mintRelayToken,
  psk,
  sha256,
  verifyRelayToken,
  type RelayTokenClaims,
} from "./credentials.ts";
import { encodeDescriptor, parseDescriptor } from "./descriptor.ts";
import {
  computerAccept,
  dh,
  encodePayload2,
  keyPairFromPrivate,
  nonceBytes,
  phoneHello,
  prologue,
  TRANSPORT_DIRECT,
  TRANSPORT_RELAY,
  type KeyPair,
  type SessionKeys,
  type TraceStep,
  type TransportByte,
} from "./noise.ts";
import {
  acceptFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FLAG,
  finFrame,
  goAwayFrame,
  INITIAL_WINDOW,
  MAX_DATA_PAYLOAD,
  Mux,
  openFrame,
  pingFrame,
  resetFrame,
  STREAM_WINDOW,
  TYPE,
  windowFrame,
  YamuxError,
  type Frame,
  type Role,
} from "./yamux.ts";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const label = (text: string): Buffer => sha256(Buffer.from(text, "utf8"));
const flip = (bytes: Uint8Array, index: number, bit = 0x01): Buffer => {
  const out = Buffer.from(bytes);
  out[index] ^= bit;
  return out;
};

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");

function scalar(text: string): Buffer {
  const bytes = label(text);
  const value = BigInt(`0x${hex(bytes)}`);
  if (value <= 0n || value >= P256_N) throw new Error(`${text} is not a valid P-256 scalar`);
  return bytes;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

const coordinate = (value: bigint): Buffer => Buffer.from(value.toString(16).padStart(64, "0"), "hex");

/** A real point whose x is small enough that x + p still fits in 32 bytes: the non-canonical spelling. */
function nonCanonicalPoint(): Buffer {
  for (let x = 1n; ; x += 1n) {
    const rhs = (((x * x * x - 3n * x + P256_B) % P256_P) + P256_P) % P256_P;
    const y = modPow(rhs, (P256_P + 1n) / 4n, P256_P);
    if ((y * y) % P256_P === rhs) return Buffer.concat([Buffer.from([0x04]), coordinate(x + P256_P), coordinate(y)]);
  }
}

export const INPUTS = {
  transportPrivate: scalar("omb-e2e vector T"),
  phoneEphemeral: scalar("omb-e2e vector e phone"),
  computerEphemeral: scalar("omb-e2e vector e computer"),
  deviceToken: `omb_${b64u(label("omb-e2e vector device token"))}`,
  pairingToken: `omb_pair_${b64u(label("omb-e2e vector pairing token"))}`,
  hostId: label("omb-e2e vector host").subarray(0, 16),
  conn: label("omb-e2e vector conn").subarray(0, 16),
  tokenKeySeed: label("omb-e2e vector token key"),
  /** Must-fail inputs only. */
  otherTransportPrivate: scalar("omb-e2e vector T other"),
  otherDeviceToken: `omb_${b64u(label("omb-e2e vector other device token"))}`,
  otherConn: label("omb-e2e vector other conn").subarray(0, 16),
  otherTokenKeySeed: label("omb-e2e vector other token key"),
};

const T = keyPairFromPrivate(INPUTS.transportPrivate);
const phoneE = keyPairFromPrivate(INPUTS.phoneEphemeral);
const computerE = keyPairFromPrivate(INPUTS.computerEphemeral);
const KEY_ID = keyId(T.publicKey);
const CONN = b64u(INPUTS.conn);
const PAYLOAD1 = Buffer.from(JSON.stringify({ v: 1, conn: CONN, app: "vector/1" }), "utf8");
const PAYLOAD2 = encodePayload2(CONN);

const tokenPsk = (token: string) => psk(credentialHash(token), KEY_ID);
const PSK = { device: tokenPsk(INPUTS.deviceToken), pairing: tokenPsk(INPUTS.pairingToken), other: tokenPsk(INPUTS.otherDeviceToken) };

function credentialVector(name: string, token: string) {
  const hash = credentialHash(token);
  const adm = admission(hash, INPUTS.hostId);
  return { name, token, credHash: hex(hash), psk: hex(psk(hash, KEY_ID)), adm: hex(adm), admB64u: b64u(adm), admHash: admissionHash(adm) };
}

function v1() {
  const curvePoint = (name: string, bytes: Uint8Array, valid: boolean) => ({ name, hex: hex(bytes), valid });
  const x = T.publicKey.subarray(1, 33);
  const y = T.publicKey.subarray(33);
  const yOdd = (y[31] & 1) === 1;
  return {
    transportPublic: hex(T.publicKey),
    transportPublicB64u: b64u(T.publicKey),
    keyId: hex(KEY_ID),
    hostIdB64u: b64u(INPUTS.hostId),
    phoneEphemeralPublic: hex(phoneE.publicKey),
    computerEphemeralPublic: hex(computerE.publicKey),
    credentials: [credentialVector("device", INPUTS.deviceToken), credentialVector("pairing", INPUTS.pairingToken)],
    dh: {
      es: hex(dh(phoneE.privateKey, T.publicKey)),
      ee: hex(dh(phoneE.privateKey, computerE.publicKey)),
    },
    points: [
      curvePoint("transport_public", T.publicKey, true),
      curvePoint("off_curve", flip(T.publicKey, 64), false),
      curvePoint("non_canonical_x_plus_p", nonCanonicalPoint(), false),
      curvePoint("compressed", Buffer.concat([Buffer.from([yOdd ? 0x03 : 0x02]), x]), false),
      curvePoint("hybrid", Buffer.concat([Buffer.from([yOdd ? 0x07 : 0x06]), x, y]), false),
      curvePoint("zero", Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]), false),
      curvePoint("truncated", T.publicKey.subarray(0, 64), false),
    ],
  };
}

interface Handshake {
  keys: SessionKeys;
  message1: Buffer;
  message2: Buffer;
  phoneTrace: TraceStep[];
}

function handshake(transport: TransportByte, pskBytes: Buffer, staticKey: KeyPair = T, payload1: Buffer = PAYLOAD1): Handshake {
  const phoneTrace: TraceStep[] = [];
  const hello = phoneHello({ remoteStatic: staticKey.publicKey, psk: pskBytes, transport, ephemeral: phoneE, trace: phoneTrace }, payload1, CONN);
  const computerTrace: TraceStep[] = [];
  const accepted = computerAccept(
    { staticKey, transport, candidates: [{ id: "device", psk: pskBytes }], ephemeral: computerE, trace: computerTrace },
    hello.message1,
  );
  if (!accepted) throw new Error("vector handshake rejected");
  const keys = hello.finish(accepted.message2);
  if (JSON.stringify(computerTrace) !== JSON.stringify(phoneTrace)) throw new Error("the two sides' traces differ");
  if (!keys.handshakeHash.equals(accepted.keys.handshakeHash)) throw new Error("handshake hashes differ");
  return { keys, message1: hello.message1, message2: accepted.message2, phoneTrace };
}

function handshakeVector(transport: TransportByte, pskName: "device" | "pairing") {
  const run = handshake(transport, PSK[pskName]);
  return {
    transport,
    psk: pskName,
    prologue: hex(prologue(transport)),
    payload1: hex(PAYLOAD1),
    payload2: hex(PAYLOAD2),
    trace: run.phoneTrace,
    message1: hex(run.message1),
    message2: hex(run.message2),
    kPc: hex(run.keys.kPc),
    kCp: hex(run.keys.kCp),
    handshakeHash: hex(run.keys.handshakeHash),
  };
}

const HTTP_REQUEST = "GET /api/health HTTP/1.1\r\nHost: companion\r\n\r\n";
const HTTP_RESPONSE = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}';

const recordFrames: { pc: Frame[]; cp: Frame[] } = {
  pc: [openFrame(1), dataFrame(1, Buffer.from(HTTP_REQUEST)), finFrame(1), pingFrame(1)],
  cp: [acceptFrame(1), dataFrame(1, Buffer.from(HTTP_RESPONSE)), finFrame(1), pingFrame(1, FLAG.ack)],
};

/** The computer's side of the V2 session, from the start. */
function computerSession(): SessionKeys {
  const hello = phoneHello({ remoteStatic: T.publicKey, psk: PSK.device, transport: TRANSPORT_RELAY, ephemeral: phoneE }, PAYLOAD1, CONN);
  const accepted = computerAccept({ staticKey: T, transport: TRANSPORT_RELAY, candidates: [{ id: "d", psk: PSK.device }], ephemeral: computerE }, hello.message1);
  if (!accepted) throw new Error("vector handshake rejected");
  return accepted.keys;
}

function v4() {
  const phone = handshake(TRANSPORT_RELAY, PSK.device).keys;
  const computer = computerSession();
  const records = [];
  for (const [direction, frames, cipher] of [["pc", recordFrames.pc, phone.send], ["cp", recordFrames.cp, computer.send]] as const) {
    for (const frame of frames) {
      const plaintext = encodeFrame(frame);
      const n = cipher.nonce;
      records.push({ direction, n, nonce: hex(nonceBytes(n)), frame: hex(plaintext), record: hex(cipher.seal(plaintext)) });
    }
  }
  return { session: "V2", kPc: hex(phone.kPc), kCp: hex(phone.kCp), records };
}

function v5() {
  const max = Buffer.alloc(MAX_DATA_PAYLOAD);
  for (let index = 0; index < max.length; index += 1) max[index] = index % 251;
  const frames: Array<[string, Frame, string]> = [
    ["open", openFrame(1), "phone opens stream 1: WindowUpdate SYN, delta 1,835,008"],
    ["accept", acceptFrame(1), "computer accepts: WindowUpdate ACK, delta 1,835,008"],
    ["refuse", resetFrame(1), "computer refuses, or either side resets: WindowUpdate RST, length 0"],
    ["data_0", dataFrame(1, Buffer.alloc(0)), "Data, empty"],
    ["data_1", dataFrame(1, Buffer.from("A")), "Data, one byte"],
    ["data_max", dataFrame(1, max), "Data, 65,507 bytes: byte i is i % 251"],
    ["fin", finFrame(1), "half close as sent: WindowUpdate FIN, length 0"],
    ["data_fin", dataFrame(1, Buffer.from("A"), FLAG.fin), "half close on Data: also valid on receipt"],
    ["window", windowFrame(1, 1024 * 1024), "grant 1 MiB"],
    ["ping_syn", pingFrame(0x01020304), "Ping SYN, opaque 0x01020304"],
    ["ping_ack", pingFrame(0x01020304, FLAG.ack), "Ping ACK, same opaque"],
    ["go_away_0", goAwayFrame(0), "GoAway normal"],
    ["go_away_1", goAwayFrame(1), "GoAway protocol error"],
    ["go_away_2", goAwayFrame(2), "GoAway internal error"],
    ["stream_3", openFrame(3), "the next stream the phone opens"],
  ];
  return frames.map(([name, frame, about]) => {
    const bytes = encodeFrame(frame);
    const decoded = decodeFrame(bytes);
    return { name, about, type: decoded.type, flags: decoded.flags, streamId: decoded.streamId, length: decoded.length, hex: hex(bytes) };
  });
}

function v6Handshake() {
  const relay = handshake(TRANSPORT_RELAY, PSK.device);
  const otherT = keyPairFromPrivate(INPUTS.otherTransportPrivate);
  const swapped = handshake(TRANSPORT_RELAY, PSK.device, otherT);
  const forged = (payload2: (conn: string) => Buffer) => {
    const accepted = computerAccept(
      { staticKey: T, transport: TRANSPORT_RELAY, candidates: [{ id: "d", psk: PSK.device }], ephemeral: computerE, payload2: (p1) => payload2(p1.conn) },
      relay.message1,
    );
    if (!accepted) throw new Error("vector handshake rejected");
    return accepted.message2;
  };
  const message1With = (payload1: Buffer) =>
    phoneHello({ remoteStatic: T.publicKey, psk: PSK.device, transport: TRANSPORT_RELAY, ephemeral: phoneE }, payload1, CONN).message1;
  const computer = (name: string, about: string, message1: Buffer, candidates: string[], transport: TransportByte = TRANSPORT_RELAY) => {
    const outcome = computerAccept(
      { staticKey: T, transport, candidates: candidates.map((id) => ({ id, psk: PSK[id as keyof typeof PSK] })), ephemeral: computerE },
      message1,
    );
    if (outcome) throw new Error(`${name} was accepted`);
    return { name, about, side: "computer", transport, candidates, message1: hex(message1), expect: "close_4001" };
  };
  const phone = (name: string, about: string, message2: Buffer) => {
    const hello = phoneHello({ remoteStatic: T.publicKey, psk: PSK.device, transport: TRANSPORT_RELAY, ephemeral: phoneE }, PAYLOAD1, CONN);
    let failed = false;
    try {
      hello.finish(message2);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error(`${name} was accepted`);
    return { name, about, side: "phone", transport: TRANSPORT_RELAY, session: "V2", message2: hex(message2), expect: "hard_stop" };
  };
  const tagIndex = relay.message1.length - 1;
  const p1 = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify(fields), "utf8");
  return [
    computer("wrong_psk", "V2 message 1; the computer holds only other devices' psks", relay.message1, ["pairing", "other"]),
    computer("prologue_mismatch", "V2 message 1 (relay) read as a direct connection", relay.message1, ["device"], TRANSPORT_DIRECT),
    computer("message1_key_bit", "one bit flipped in e.pub", flip(relay.message1, 1), ["device"]),
    computer("message1_ciphertext_bit", "one bit flipped in the payload ciphertext", flip(relay.message1, 65), ["device"]),
    computer("message1_tag_bit", "one bit flipped in the tag", flip(relay.message1, tagIndex), ["device"]),
    computer("message1_truncated", "shorter than e.pub plus a tag", relay.message1.subarray(0, 80), ["device"]),
    computer("message1_too_long", "longer than 65 + 512 + 16", Buffer.concat([relay.message1, Buffer.alloc(600)]), ["device"]),
    computer("payload1_v2", "decrypts, but payload1 has v = 2", message1With(p1({ v: 2, conn: CONN, app: "vector/1" })), ["device"]),
    computer("payload1_no_conn", "decrypts, but payload1 has no conn", message1With(p1({ v: 1, app: "vector/1" })), ["device"]),
    computer("payload1_short_conn", "decrypts, but conn is 15 bytes", message1With(p1({ v: 1, conn: b64u(INPUTS.conn.subarray(0, 15)) })), ["device"]),
    phone("message2_other_key", "message 2 from a responder holding a different T (a key swap)", swapped.message2),
    phone("message2_key_bit", "one bit flipped in the computer's e.pub", flip(relay.message2, 1)),
    phone("message2_ciphertext_bit", "one bit flipped in the payload ciphertext", flip(relay.message2, 65)),
    phone("message2_tag_bit", "one bit flipped in the tag", flip(relay.message2, relay.message2.length - 1)),
    phone("payload2_wrong_conn", "decrypts, but conn is not the one sent", forged(() => encodePayload2(b64u(INPUTS.otherConn)))),
    phone("payload2_v2", "decrypts, but v = 2", forged((conn) => Buffer.from(JSON.stringify({ v: 2, conn }), "utf8"))),
  ];
}

function v6Records() {
  const records = v4().records;
  const pc = records.filter((record) => record.direction === "pc").map((record) => Buffer.from(record.record, "hex"));
  const cp = records.filter((record) => record.direction === "cp").map((record) => Buffer.from(record.record, "hex"));
  const cases = [
    { name: "ciphertext_bit", about: "record 1 with one bit flipped", receiver: "computer", records: [pc[0], flip(pc[1], 0)], failsAt: 1 },
    { name: "tag_bit", about: "record 1 with the tag's last bit flipped", receiver: "computer", records: [pc[0], flip(pc[1], pc[1].length - 1)], failsAt: 1 },
    { name: "replay", about: "record 1 again at n = 2", receiver: "computer", records: [pc[0], pc[1], pc[1]], failsAt: 2 },
    { name: "reorder", about: "record 1 first", receiver: "computer", records: [pc[1], pc[0]], failsAt: 0 },
    { name: "drop", about: "record 0 dropped", receiver: "computer", records: [pc[1]], failsAt: 0 },
    { name: "truncated", about: "record 1 missing its last byte", receiver: "computer", records: [pc[0], pc[1].subarray(0, pc[1].length - 1)], failsAt: 1 },
    { name: "reflection_to_computer", about: "the computer's own record 0 sent back to it", receiver: "computer", records: [cp[0]], failsAt: 0 },
    { name: "reflection_to_phone", about: "the phone's own record 0 sent back to it", receiver: "phone", records: [pc[0]], failsAt: 0 },
    { name: "empty", about: "a zero-length record", receiver: "phone", records: [Buffer.alloc(0)], failsAt: 0 },
  ];
  const keys = handshake(TRANSPORT_RELAY, PSK.device).keys;
  for (const testCase of cases) {
    const receiver = testCase.receiver === "computer" ? computerSession().receive : keys.receive;
    let failedAt = -1;
    for (const [index, record] of testCase.records.entries()) {
      try {
        receiver.open(record);
      } catch {
        failedAt = index;
        break;
      }
    }
    if (failedAt !== testCase.failsAt) throw new Error(`${testCase.name} failed at ${failedAt}`);
  }
  return cases.map((testCase) => ({ ...testCase, session: "V2", records: testCase.records.map(hex) }));
}

function header(type: number, flags: number, streamId: number, length: number, version = 0): Buffer {
  const out = Buffer.alloc(12);
  out.writeUInt8(version, 0);
  out.writeUInt8(type, 1);
  out.writeUInt16BE(flags, 2);
  out.writeUInt32BE(streamId, 4);
  out.writeUInt32BE(length, 8);
  return out;
}

function v6Frames() {
  const cases: Array<[string, Buffer]> = [
    ["version_1", header(TYPE.windowUpdate, FLAG.syn, 1, 0, 1)],
    ["unknown_type", header(4, 0, 1, 0)],
    ["unknown_flag", header(TYPE.windowUpdate, 0x10, 1, 0)],
    ["data_65508", Buffer.concat([header(TYPE.data, 0, 1, MAX_DATA_PAYLOAD + 1), Buffer.alloc(MAX_DATA_PAYLOAD + 1)])],
    ["data_length_mismatch", Buffer.concat([header(TYPE.data, 0, 1, 5), Buffer.from("four")])],
    ["short", header(TYPE.windowUpdate, 0, 1, 0).subarray(0, 11)],
    ["window_trailing_byte", Buffer.concat([header(TYPE.windowUpdate, 0, 1, 0), Buffer.alloc(1)])],
    ["data_stream_0", header(TYPE.data, 0, 0, 0)],
    ["window_stream_0", header(TYPE.windowUpdate, 0, 0, 1)],
    ["ping_stream_1", header(TYPE.ping, FLAG.syn, 1, 0)],
    ["ping_syn_ack", header(TYPE.ping, FLAG.syn | FLAG.ack, 0, 0)],
    ["ping_no_flags", header(TYPE.ping, 0, 0, 0)],
    ["go_away_stream_1", header(TYPE.goAway, 0, 1, 0)],
    ["go_away_flags", header(TYPE.goAway, FLAG.fin, 0, 0)],
  ];
  return cases.map(([name, bytes]) => {
    let reason = "";
    try {
      decodeFrame(bytes);
    } catch (error) {
      reason = (error as YamuxError).reason;
    }
    if (!reason) throw new Error(`frame ${name} decoded`);
    // The data_65508 case is pinned by its header: the length field alone condemns it.
    return { name, hex: hex(name === "data_65508" ? bytes.subarray(0, 12) : bytes), reason };
  });
}

type ScriptStep = { in: Frame } | { open: true } | { consume: { stream: number; bytes: number } };

interface Script {
  name: string;
  about: string;
  role: Role;
  /** The computer side: accept every stream as soon as it opens, or never. */
  accept?: "immediate" | "never";
  steps: ScriptStep[];
}

function runScript(script: Script): { sent: string[]; errorAt: number | null } {
  const sent: string[] = [];
  let mux: Mux;
  mux = new Mux(script.role, {
    send: (frame) => sent.push(hex(encodeFrame(frame))),
    opened: (id) => (script.accept === "never" ? undefined : mux.accept(id)),
    data: () => {},
    ended: () => {},
    reset: () => {},
    writable: () => {},
  });
  for (const [index, step] of script.steps.entries()) {
    try {
      if ("open" in step) mux.open();
      else if ("consume" in step) mux.consumed(step.consume.stream, step.consume.bytes);
      else mux.receive(decodeFrame(encodeFrame(step.in)));
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      return { sent, errorAt: index };
    }
  }
  return { sent, errorAt: null };
}

/** Data frames on `streamId` carrying `total` bytes of zeros, each as large as allowed. */
function fill(streamId: number, total: number): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let left = total; left > 0; left -= MAX_DATA_PAYLOAD) steps.push({ in: dataFrame(streamId, Buffer.alloc(Math.min(left, MAX_DATA_PAYLOAD))) });
  return steps;
}

function scriptStep(step: ScriptStep) {
  if ("open" in step) return { open: true };
  if ("consume" in step) return { consume: step.consume };
  const bytes = encodeFrame(step.in);
  const payload = bytes.subarray(12);
  if (payload.length > 16 && payload.every((byte) => byte === 0)) return { in: { header: hex(bytes.subarray(0, 12)), fill: 0 } };
  return { in: { header: hex(bytes.subarray(0, 12)), ...(payload.length ? { payload: hex(payload) } : {}) } };
}

function v6Sessions() {
  const opens = Array.from({ length: 65 }, (_, index) => ({ in: openFrame(index * 2 + 1) }));
  const scripts: Script[] = [
    { name: "even_stream_open", about: "the phone opens stream 2", role: "computer", steps: [{ in: openFrame(2) }] },
    { name: "stream_reused", about: "stream 1 opened twice", role: "computer", steps: [{ in: openFrame(1) }, { in: openFrame(1) }] },
    { name: "stream_id_decreasing", about: "stream 3, then stream 1", role: "computer", steps: [{ in: openFrame(3) }, { in: openFrame(1) }] },
    { name: "never_opened_stream", about: "Data on stream 5 with no SYN", role: "computer", steps: [{ in: dataFrame(5, Buffer.from("x")) }] },
    { name: "ack_from_phone", about: "the phone sends ACK", role: "computer", steps: [{ in: openFrame(1) }, { in: acceptFrame(1) }] },
    { name: "syn_on_data", about: "SYN on a Data frame", role: "computer", steps: [{ in: dataFrame(1, Buffer.from("x"), FLAG.syn) }] },
    {
      name: "window_before_accept",
      about: "256 KiB arrive before the accept, then one more byte",
      role: "computer",
      accept: "never",
      steps: [{ in: openFrame(1) }, ...fill(1, INITIAL_WINDOW), { in: dataFrame(1, Buffer.alloc(1)) }],
    },
    {
      name: "window_after_accept",
      about: "2 MiB arrive with no grant from the computer, then one more byte",
      role: "computer",
      steps: [{ in: openFrame(1) }, ...fill(1, STREAM_WINDOW), { in: dataFrame(1, Buffer.alloc(1)) }],
    },
    { name: "data_after_fin", about: "Data after the phone's FIN", role: "computer", steps: [{ in: openFrame(1) }, { in: finFrame(1) }, { in: dataFrame(1, Buffer.from("x")) }] },
    { name: "computer_opens_stream", about: "the computer sends SYN", role: "phone", steps: [{ in: openFrame(2) }] },
    { name: "ack_unknown_stream", about: "ACK for a stream the phone never opened", role: "phone", steps: [{ in: acceptFrame(1) }] },
    { name: "duplicate_ack", about: "the same stream accepted twice", role: "phone", steps: [{ open: true }, { in: acceptFrame(1) }, { in: acceptFrame(1) }] },
    {
      name: "phone_window_exceeded",
      about: "2 MiB arrive at the phone with no grant, then one more byte",
      role: "phone",
      steps: [{ open: true }, { in: acceptFrame(1) }, ...fill(1, STREAM_WINDOW), { in: dataFrame(1, Buffer.alloc(1)) }],
    },
    { name: "too_many_streams", about: "64 streams are accepted, the 65th is reset", role: "computer", steps: opens },
    { name: "ping_answered", about: "Ping SYN is answered with Ping ACK and the same value", role: "computer", steps: [{ in: pingFrame(0xdeadbeef) }] },
    { name: "late_frames_ignored", about: "frames for a stream that was reset are ignored", role: "computer", steps: [{ in: openFrame(1) }, { in: resetFrame(1) }, { in: dataFrame(1, Buffer.from("x")) }, { in: windowFrame(1, 10) }] },
    {
      name: "window_grant",
      about: "the grant goes out once 1 MiB has been consumed, as one WindowUpdate",
      role: "computer",
      steps: [{ in: openFrame(1) }, ...fill(1, 1024 * 1024), { consume: { stream: 1, bytes: 1024 * 1024 - 1 } }, { consume: { stream: 1, bytes: 1 } }],
    },
    { name: "phone_open_ids", about: "the phone opens 1, 3, 5", role: "phone", steps: [{ open: true }, { open: true }, { open: true }] },
  ];
  return scripts.map((script) => {
    const result = runScript(script);
    return {
      name: script.name,
      about: script.about,
      role: script.role,
      ...(script.role === "computer" ? { accept: script.accept ?? "immediate" } : {}),
      steps: script.steps.map(scriptStep),
      expect: result.errorAt === null ? { sent: result.sent } : { errorAt: result.errorAt },
    };
  });
}

/** A valid descriptor whose encoding has a URL-safe character, spelled with `+` or `/` instead. */
function standardAlphabet(encode: (filler: string) => string): string {
  for (let size = 0; ; size += 1) {
    const text = encode("?".repeat(size));
    if (/[-_]/.test(text)) return text.replace(/[-_]/, (char) => (char === "-" ? "+" : "/"));
  }
}

/** The same bytes with the unused low bits of the last character set: a decoder that ignores them accepts it. */
function nonCanonicalTail(text: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const unusedBits = text.length % 4 === 2 ? 4 : text.length % 4 === 3 ? 2 : 0;
  if (!unusedBits) throw new Error("no unused bits");
  const last = alphabet.indexOf(text[text.length - 1]);
  return text.slice(0, -1) + alphabet[last | 1];
}

function v7() {
  const k = b64u(T.publicKey);
  const h = b64u(INPUTS.hostId);
  const r = ["relay1.openmausbot.com", "relay2.openmausbot.com"];
  const raw = (value: unknown) => b64u(Buffer.from(JSON.stringify(value), "utf8"));
  // 768 JSON bytes encode to exactly 1,024 characters; 769 to 1,026.
  const padded = (jsonBytes: number) => raw({ v: 1, k, h, r, x: "a".repeat(jsonBytes - JSON.stringify({ v: 1, k, h, r, x: "" }).length) });
  const valid = [
    { name: "relay", value: encodeDescriptor({ v: 1, k, h, r }) },
    { name: "direct_only", value: encodeDescriptor({ v: 1, k }) },
    { name: "four_relays", value: raw({ v: 1, k, h, r: ["relay1.openmausbot.com", "relay2.openmausbot.com", "relay3.openmausbot.com", "relay99.openmausbot.com"] }) },
    { name: "key_order_and_unknown_field", value: raw({ r, x: 1, h, k, v: 1 }) },
    { name: "at_1024_chars", value: padded(768) },
    { name: "routes_local", value: encodeDescriptor({ v: 1, k, routes: "local" }) },
    { name: "routes_any_with_relay", value: encodeDescriptor({ v: 1, k, h, r, routes: "any" }) },
    { name: "routes_any_without_relay", value: raw({ v: 1, k, routes: "any" }) },
  ];
  const offCurve = b64u(flip(T.publicKey, 64));
  const invalid = [
    { name: "over_1024_chars", value: padded(769) },
    { name: "bad_point", value: raw({ v: 1, k: offCurve }) },
    { name: "compressed_key", value: raw({ v: 1, k: b64u(T.publicKey.subarray(0, 33)) }) },
    { name: "missing_key", value: raw({ v: 1 }) },
    { name: "relay_host_suffix", value: raw({ v: 1, k, h, r: ["relay1.openmausbot.com.example.net"] }) },
    { name: "relay_host_zero", value: raw({ v: 1, k, h, r: ["relay0.openmausbot.com"] }) },
    { name: "relay_host_upper", value: raw({ v: 1, k, h, r: ["Relay1.openmausbot.com"] }) },
    { name: "relay_host_other_domain", value: raw({ v: 1, k, h, r: ["relay1.openmausbot.org"] }) },
    { name: "h_without_r", value: raw({ v: 1, k, h }) },
    { name: "r_without_h", value: raw({ v: 1, k, r }) },
    { name: "no_relays", value: raw({ v: 1, k, h, r: [] }) },
    { name: "five_relays", value: raw({ v: 1, k, h, r: [...r, "relay3.openmausbot.com", "relay4.openmausbot.com", "relay5.openmausbot.com"] }) },
    { name: "host_id_15_bytes", value: raw({ v: 1, k, h: b64u(INPUTS.hostId.subarray(0, 15)), r }) },
    { name: "v0", value: raw({ v: 0, k }) },
    { name: "v_string", value: raw({ v: "1", k }) },
    { name: "v_missing", value: raw({ k }) },
    { name: "padded_base64", value: `${encodeDescriptor({ v: 1, k })}=` },
    { name: "standard_base64_alphabet", value: standardAlphabet((x) => raw({ v: 1, k, h, r, x })) },
    { name: "non_canonical_base64", value: nonCanonicalTail(encodeDescriptor({ v: 1, k })) },
    { name: "key_standard_alphabet", value: raw({ v: 1, k: Buffer.from(T.publicKey).toString("base64") }) },
    { name: "not_json", value: b64u(Buffer.from("not json")) },
    { name: "json_array", value: raw([1]) },
    { name: "routes_unknown", value: raw({ v: 1, k, routes: "wifi" }) },
    { name: "routes_not_a_string", value: raw({ v: 1, k, routes: 1 }) },
    { name: "routes_local_with_relay", value: raw({ v: 1, k, h, r, routes: "local" }) },
    { name: "v2", value: raw({ v: 2, k }) },
    { name: "v2_unknown_shape", value: raw({ v: 2, keys: [1, 2, 3] }) },
  ];
  return {
    valid: valid.map(({ name, value }) => {
      const parsed = parseDescriptor(value);
      if (parsed.outcome !== "ok") throw new Error(`${name}: ${JSON.stringify(parsed)}`);
      return { name, value, chars: value.length, parsed: parsed.descriptor };
    }),
    invalid: invalid.map(({ name, value }) => {
      const parsed = parseDescriptor(value);
      if (parsed.outcome === "ok") throw new Error(`${name} parsed`);
      return { name, value, chars: value.length, outcome: parsed.outcome };
    }),
  };
}

function v8() {
  const signingKey = ed25519PrivateKey(INPUTS.tokenKeySeed);
  const publicKey = ed25519RawPublicKey(signingKey);
  const otherPublic = ed25519RawPublicKey(ed25519PrivateKey(INPUTS.otherTokenKeySeed));
  const iat = 1_793_836_800;
  const claims: RelayTokenClaims = { v: 1, kid: "k1", hid: b64u(INPUTS.hostId), iid: "6f1c2a4e-8b3d-4c5f-9a7e-1d2b3c4d5e6f", iat, exp: iat + 12 * 3600 };
  const token = mintRelayToken(claims, signingKey);
  const [body, signature] = token.split(".");
  const keys = (entries: Record<string, Buffer>) => new Map(Object.entries(entries));
  const tamperedBody = b64u(Buffer.from(JSON.stringify({ ...claims, iid: "00000000-0000-4000-8000-000000000000" })));
  const cases: Array<{ name: string; token: string; keys: Record<string, Buffer>; now: number; expectHid?: string }> = [
    { name: "valid", token, keys: { k1: publicKey }, now: iat + 60 },
    { name: "valid_two_keys", token, keys: { k2: otherPublic, k1: publicKey }, now: iat + 60 },
    { name: "valid_refresh_same_hid", token, keys: { k1: publicKey }, now: claims.exp - 1, expectHid: claims.hid },
    { name: "expired", token, keys: { k1: publicKey }, now: claims.exp },
    { name: "wrong_kid", token, keys: { k2: publicKey }, now: iat + 60 },
    { name: "bad_signature", token: `${body}.${b64u(flip(Buffer.from(signature, "base64url"), 0))}`, keys: { k1: publicKey }, now: iat + 60 },
    { name: "other_key", token, keys: { k1: otherPublic }, now: iat + 60 },
    { name: "payload_changed", token: `${tamperedBody}.${signature}`, keys: { k1: publicKey }, now: iat + 60 },
    { name: "wrong_hid_on_refresh", token, keys: { k1: publicKey }, now: iat + 60, expectHid: b64u(label("omb-e2e vector other host").subarray(0, 16)) },
    { name: "three_parts", token: `${token}.x`, keys: { k1: publicKey }, now: iat + 60 },
    { name: "longer_than_12_h", token: mintRelayToken({ ...claims, exp: claims.exp + 1 }, signingKey), keys: { k1: publicKey }, now: iat + 60 },
  ];
  return {
    seed: hex(INPUTS.tokenKeySeed),
    publicKey: hex(publicKey),
    publicKeyB64u: b64u(publicKey),
    relayTokenKeys: { k1: b64u(publicKey) },
    claims,
    payloadJson: JSON.stringify(claims),
    token,
    verify: cases.map((testCase) => {
      const result = verifyRelayToken(testCase.token, keys(testCase.keys), testCase.now, testCase.expectHid);
      return {
        name: testCase.name,
        token: testCase.token,
        keys: Object.fromEntries(Object.entries(testCase.keys).map(([kid, raw]) => [kid, b64u(raw)])),
        now: testCase.now,
        ...(testCase.expectHid ? { expectHid: testCase.expectHid } : {}),
        ...(result.ok ? { ok: true } : { ok: false, error: result.error }),
      };
    }),
  };
}

function v9() {
  const device = credentialVector("device", INPUTS.deviceToken);
  const pairing = credentialVector("pairing", INPUTS.pairingToken);
  const sid = b64u(label("omb-e2e vector sid").subarray(0, 16));
  return {
    about: "Relay messages for the vector host. JSON key order and whitespace are not significant on the wire.",
    host: [
      { t: "auth", v: 1, token: "<V8 token>" },
      { t: "admit", set: [device.admHash, pairing.admHash] },
      { t: "data", v: 1, sid, token: "<V8 token>" },
    ],
    relay: [
      { t: "hello", v: 1, node: "relay1", sessionsMax: 16 },
      { t: "open", sid },
      { t: "ready" },
      { t: "restarting", reconnectInMs: 0, tryForMs: 15000 },
    ],
    phone: [{ t: "phone", v: 1, hid: b64u(INPUTS.hostId), adm: device.admB64u }],
  };
}

export function buildVectors() {
  return {
    about:
      "OpenMausBot E2E wire spec v1 test vectors (companion/src/e2e/README.md). All binary values are hex unless a field ends in B64u. " +
      "Generated by companion/src/e2e/gen-vectors.ts; never edit by hand.",
    version: 1,
    inputs: {
      transportPrivate: hex(INPUTS.transportPrivate),
      phoneEphemeralPrivate: hex(INPUTS.phoneEphemeral),
      computerEphemeralPrivate: hex(INPUTS.computerEphemeral),
      deviceToken: INPUTS.deviceToken,
      pairingToken: INPUTS.pairingToken,
      hostId: hex(INPUTS.hostId),
      conn: hex(INPUTS.conn),
      connB64u: CONN,
      payload1: PAYLOAD1.toString("utf8"),
      payload2: PAYLOAD2.toString("utf8"),
      tokenKeySeed: hex(INPUTS.tokenKeySeed),
      otherTransportPrivate: hex(INPUTS.otherTransportPrivate),
      otherDeviceToken: INPUTS.otherDeviceToken,
      otherConn: hex(INPUTS.otherConn),
      otherTokenKeySeed: hex(INPUTS.otherTokenKeySeed),
    },
    V1: v1(),
    V2: handshakeVector(TRANSPORT_RELAY, "device"),
    V3: handshakeVector(TRANSPORT_DIRECT, "pairing"),
    V4: v4(),
    V5: v5(),
    V6: { handshake: v6Handshake(), records: v6Records(), frames: v6Frames(), sessions: v6Sessions() },
    V7: v7(),
    V8: v8(),
    V9: v9(),
  };
}

export const VECTORS_FILE = fileURLToPath(new URL("./vectors/v1.json", import.meta.url));
export const VECTORS_HASH_FILE = fileURLToPath(new URL("./vectors/v1.sha256", import.meta.url));

export const vectorsText = (): string => `${JSON.stringify(buildVectors(), null, 1)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = vectorsText();
  const digest = `${sha256(Buffer.from(text, "utf8")).toString("hex")}  v1.json\n`;
  if (process.argv.includes("--check")) {
    const same = readFileSync(VECTORS_FILE, "utf8") === text && readFileSync(VECTORS_HASH_FILE, "utf8") === digest;
    console.log(same ? "vectors are current" : "vectors are stale: run node companion/src/e2e/gen-vectors.ts");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(VECTORS_FILE, text);
  writeFileSync(VECTORS_HASH_FILE, digest);
  console.log(`wrote ${VECTORS_FILE} (${digest.split(" ")[0]})`);
}
