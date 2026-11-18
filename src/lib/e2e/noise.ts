import { b64u, concat, fromB64u, utf8, type Bytes } from "./bytes.ts";
import { hmacSha256, sha256 } from "./credentials.ts";

const PROTOCOL_NAME = "Noise_NKpsk0_P256_AESGCM_SHA256";
export const PUBLIC_KEY_BYTES = 65;
export const TAG_BYTES = 16;
export const MAX_RECORD_BYTES = 65_535;
const MAX_RECORD_PLAINTEXT = MAX_RECORD_BYTES - TAG_BYTES;
export const MAX_HANDSHAKE_PAYLOAD = 512;
const MAX_HANDSHAKE_MESSAGE = PUBLIC_KEY_BYTES + MAX_HANDSHAKE_PAYLOAD + TAG_BYTES;
export const CONN_BYTES = 16;
const MAX_APP_CHARS = 40;
/** A sender closes the session (1000) before a direction's counter reaches this. */
const NONCE_LIMIT = 2 ** 32;

export const TRANSPORT_RELAY = 0x01;
export const TRANSPORT_DIRECT = 0x02;
export type TransportByte = typeof TRANSPORT_RELAY | typeof TRANSPORT_DIRECT;

/** Every handshake or record failure. The reason is for tests and local logs; it never goes on the wire. */
export class NoiseError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`e2e: ${reason}`);
    this.reason = reason;
  }
}

const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const EMPTY = new Uint8Array(0);
const hex = (bytes: Bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const prologue = (transport: TransportByte): Bytes => concat(utf8("omb-e2e/1"), Uint8Array.of(0x00, transport));

export interface KeyPair {
  privateKey: CryptoKey;
  /** 65 bytes, uncompressed. */
  publicKey: Bytes;
}

/** The private half can't be exported. */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(EC, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** A fixed key pair, for the vectors: WebCrypto takes a bare scalar only with its public point. */
export async function importKeyPair(privateKey: Bytes, publicKey: Bytes): Promise<KeyPair> {
  if (privateKey.length !== 32 || publicKey.length !== PUBLIC_KEY_BYTES || publicKey[0] !== 0x04) throw new NoiseError("bad_key_pair");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: b64u(privateKey), x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33)) };
  return { privateKey: await crypto.subtle.importKey("jwk", jwk, EC, false, ["deriveBits"]), publicKey };
}

/** Only the 65-byte uncompressed form: WebCrypto also takes compressed points, which the wire forbids. The import
 * refuses off-curve points and coordinates at or above p. */
async function publicKey(bytes: Bytes): Promise<CryptoKey> {
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) throw new NoiseError("bad_point");
  try {
    return await crypto.subtle.importKey("raw", bytes, EC, false, []);
  } catch {
    throw new NoiseError("bad_point");
  }
}

export const isPublicKey = (bytes: Bytes): Promise<boolean> => publicKey(bytes).then(() => true, () => false);

/** The 32-byte X coordinate of the shared point. */
async function dh(privateKey: CryptoKey, peer: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
}

/** HKDF as Noise defines it: HMAC-SHA256 chained from the chaining key, which is RFC 5869 with empty info. */
async function hkdf(chainingKey: Bytes, ikm: Bytes, outputs: 2 | 3): Promise<Bytes[]> {
  const temp = await hmacSha256(chainingKey, ikm);
  const out: Bytes[] = [];
  for (let index = 1; index <= outputs; index += 1) out.push(await hmacSha256(temp, concat(out[index - 2] ?? EMPTY, Uint8Array.of(index))));
  return out;
}

function nonceBytes(n: number): Bytes {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n));
  return nonce;
}

class CipherState {
  readonly keyBytes: Bytes | null;
  #key: Promise<CryptoKey> | null = null;
  #n = 0;

  constructor(key: Bytes | null = null) {
    this.keyBytes = key;
  }

  get nonce(): number {
    return this.#n;
  }

  /** Each call takes its counter when it is made, so records get counters in call order however the awaits
   * resolve. A failure ends the session, so a counter spent on one is never needed again. */
  #params(ad: Bytes): AesGcmParams {
    if (this.#n >= NONCE_LIMIT) throw new NoiseError("nonce_exhausted");
    return { name: "AES-GCM", iv: nonceBytes(this.#n++), additionalData: ad, tagLength: TAG_BYTES * 8 };
  }

  /** Imported on first use: most handshake keys are replaced before they encrypt anything. */
  #aes(keyBytes: Bytes): Promise<CryptoKey> {
    return (this.#key ??= crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  async encryptWithAd(ad: Bytes, plaintext: Bytes): Promise<Bytes> {
    if (!this.keyBytes) return plaintext.slice();
    const params = this.#params(ad);
    return new Uint8Array(await crypto.subtle.encrypt(params, await this.#aes(this.keyBytes), plaintext));
  }

  async decryptWithAd(ad: Bytes, ciphertext: Bytes): Promise<Bytes> {
    if (!this.keyBytes) return ciphertext.slice();
    if (ciphertext.length < TAG_BYTES) throw new NoiseError("short_ciphertext");
    const params = this.#params(ad);
    try {
      return new Uint8Array(await crypto.subtle.decrypt(params, await this.#aes(this.keyBytes), ciphertext));
    } catch {
      throw new NoiseError("aead");
    }
  }
}

export interface TraceStep {
  step: string;
  h: string;
  ck: string;
  /** The cipher key after this step, or null before the first MixKey. */
  k: string | null;
}

class SymmetricState {
  h: Bytes;
  ck: Bytes;
  cipher = new CipherState();
  readonly #trace: TraceStep[] | null;

  /** The protocol name is 31 bytes, so Noise pads it to 32 instead of hashing it. */
  constructor(trace: TraceStep[] | null) {
    this.h = new Uint8Array(32);
    this.h.set(utf8(PROTOCOL_NAME));
    this.ck = this.h.slice();
    this.#trace = trace;
  }

  mark(step: string): void {
    this.#trace?.push({ step, h: hex(this.h), ck: hex(this.ck), k: this.cipher.keyBytes ? hex(this.cipher.keyBytes) : null });
  }

  async mixHash(data: Bytes): Promise<void> {
    this.h = await sha256(concat(this.h, data));
  }

  async mixKey(ikm: Bytes): Promise<void> {
    const [ck, key] = await hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }

  async mixKeyAndHash(ikm: Bytes): Promise<void> {
    const [ck, tempH, key] = await hkdf(this.ck, ikm, 3);
    this.ck = ck;
    await this.mixHash(tempH);
    this.cipher = new CipherState(key);
  }

  async encryptAndHash(plaintext: Bytes): Promise<Bytes> {
    const out = await this.cipher.encryptWithAd(this.h, plaintext);
    await this.mixHash(out);
    return out;
  }

  async decryptAndHash(ciphertext: Bytes): Promise<Bytes> {
    const out = await this.cipher.decryptWithAd(this.h, ciphertext);
    await this.mixHash(ciphertext);
    return out;
  }
}

/** One direction's records. Each binary WebSocket message after the handshake is exactly one; seal or open them in
 * the order they go on or come off the wire. */
export class RecordCipher {
  readonly #state: CipherState;
  #failed = false;
  #opening: Promise<unknown> = Promise.resolve();

  constructor(state: CipherState) {
    this.#state = state;
  }

  get nonce(): number {
    return this.#state.nonce;
  }

  async seal(plaintext: Bytes): Promise<Bytes> {
    if (plaintext.length > MAX_RECORD_PLAINTEXT) throw new NoiseError("record_too_large");
    return this.#state.encryptWithAd(EMPTY, new Uint8Array(plaintext));
  }

  /** Any failure is a hard stop: after one, every later record is refused too. Opens run one at a time in call
   * order, so a record never opens while an earlier one could still fail. */
  open(record: Bytes): Promise<Bytes> {
    const copy = copyRecord(record);
    const opened = this.#opening.then(() => this.#openNext(copy));
    this.#opening = opened.catch(() => undefined);
    return opened;
  }

  /** `record` is the caller's bytes copied at the call, or why they could not be copied. */
  async #openNext(record: Bytes | NoiseError): Promise<Bytes> {
    if (this.#failed) throw new NoiseError("failed");
    try {
      if (record instanceof NoiseError) throw record;
      return await this.#state.decryptWithAd(EMPTY, record);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }
}

/** A failed copy (too large, or a detached buffer) is returned, not thrown, so it fails in its place in the queue. */
function copyRecord(record: Bytes): Bytes | NoiseError {
  if (record.length > MAX_RECORD_BYTES) return new NoiseError("record_too_large");
  try {
    return new Uint8Array(record);
  } catch {
    return new NoiseError("bad_record");
  }
}

export interface SessionKeys {
  send: RecordCipher;
  receive: RecordCipher;
  handshakeHash: Bytes;
  /** For the vectors. */
  kPc: Bytes;
  kCp: Bytes;
}

export const newConn = (): Bytes => crypto.getRandomValues(new Uint8Array(CONN_BYTES));

export function encodePayload1(conn: Bytes, app: string): Bytes {
  if (conn.length !== CONN_BYTES) throw new NoiseError("bad_conn");
  if (app.length > MAX_APP_CHARS) throw new NoiseError("app_too_long");
  return utf8(JSON.stringify({ v: 1, conn: b64u(conn), app }));
}

const parseJson = (bytes: Bytes): unknown => {
  try {
    // ignoreBOM keeps a leading BOM, which JSON.parse refuses, as the computer side does.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null;
  }
};

/** The `conn` that message 2 must echo, from payload 1 checked as the wire spec says (the computer refuses
 * anything else). */
function payload1Conn(bytes: Bytes): string {
  const value = parseJson(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NoiseError("bad_payload1");
  const { v, conn, app } = value as { v?: unknown; conn?: unknown; app?: unknown };
  if (v !== 1 || typeof conn !== "string" || fromB64u(conn)?.length !== CONN_BYTES) throw new NoiseError("bad_payload1");
  if (app !== undefined && (typeof app !== "string" || app.length > MAX_APP_CHARS)) throw new NoiseError("bad_payload1");
  return conn;
}

/** Key order and whitespace are free; `v` and `conn` are not. */
function checkPayload2(bytes: Bytes, conn: string): "ok" | "version" | "conn" {
  const value = bytes.length <= MAX_HANDSHAKE_PAYLOAD ? parseJson(bytes) : null;
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { v?: unknown }).v !== 1) return "version";
  return (value as { conn?: unknown }).conn === conn ? "ok" : "conn";
}

export interface PhoneHandshakeOptions {
  /** The pinned transport key `T.pub`. */
  remoteStatic: Bytes;
  psk: Bytes;
  transport: TransportByte;
  /** Fixed in tests and vectors; fresh otherwise. */
  ephemeral?: KeyPair;
  trace?: TraceStep[];
}

export interface PhoneHello {
  message1: Bytes;
  /** Rejects with a NoiseError on any failure: every one is a hard stop. */
  finish(message2: Bytes): Promise<SessionKeys>;
}

/** `payload1` is exact bytes so vectors can pin them; it and every option are read once at the call, before the
 * first await. Message 2 must echo payload 1's `conn`. */
export async function phoneHello(options: PhoneHandshakeOptions, payload1Bytes: Bytes): Promise<PhoneHello> {
  if (payload1Bytes.length > MAX_HANDSHAKE_PAYLOAD) throw new NoiseError("payload_too_large");
  const payload1 = new Uint8Array(payload1Bytes);
  const conn = payload1Conn(payload1);
  if (options.remoteStatic.length !== PUBLIC_KEY_BYTES) throw new NoiseError("bad_point");
  if (options.psk.length !== 32) throw new NoiseError("bad_psk");
  const pinned = new Uint8Array(options.remoteStatic);
  const pskBytes = new Uint8Array(options.psk);
  const { transport, trace, ephemeral } = options;
  const fixedEphemeral = ephemeral && { privateKey: ephemeral.privateKey, publicKey: new Uint8Array(ephemeral.publicKey) };
  const remoteStatic = await publicKey(pinned);
  const state = new SymmetricState(trace ?? null);
  state.mark("init");
  await state.mixHash(prologue(transport));
  state.mark("prologue");
  await state.mixHash(pinned);
  state.mark("s");
  await state.mixKeyAndHash(pskBytes);
  state.mark("msg1.psk");
  const e = fixedEphemeral ?? (await generateKeyPair());
  await state.mixHash(e.publicKey);
  await state.mixKey(e.publicKey);
  state.mark("msg1.e");
  await state.mixKey(await dh(e.privateKey, remoteStatic));
  state.mark("msg1.es");
  const message1 = concat(e.publicKey, await state.encryptAndHash(payload1));
  state.mark("msg1.payload");
  let done = false;
  return {
    message1,
    async finish(reply) {
      if (done) throw new NoiseError("finished");
      done = true;
      if (reply.length < PUBLIC_KEY_BYTES + TAG_BYTES || reply.length > MAX_HANDSHAKE_MESSAGE) throw new NoiseError("message2_size");
      const message2 = new Uint8Array(reply);
      const re = message2.subarray(0, PUBLIC_KEY_BYTES);
      const ee = await dh(e.privateKey, await publicKey(re));
      await state.mixHash(re);
      await state.mixKey(re);
      state.mark("msg2.e");
      await state.mixKey(ee);
      state.mark("msg2.ee");
      const payload2 = await state.decryptAndHash(message2.subarray(PUBLIC_KEY_BYTES));
      state.mark("msg2.payload");
      const check = checkPayload2(payload2, conn);
      if (check !== "ok") throw new NoiseError(`payload2_${check}`);
      const [kPc, kCp] = await hkdf(state.ck, EMPTY, 2);
      return {
        send: new RecordCipher(new CipherState(kPc)),
        receive: new RecordCipher(new CipherState(kCp)),
        handshakeHash: state.h,
        kPc: kPc.slice(),
        kCp: kCp.slice(),
      };
    },
  };
}
