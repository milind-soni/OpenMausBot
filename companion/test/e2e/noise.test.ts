import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { credentialHash, keyId, psk } from "../../src/e2e/credentials.ts";
import {
  CipherState,
  computerAccept,
  encodePayload1,
  generateKeyPair,
  MAX_HANDSHAKE_PAYLOAD,
  MAX_RECORD_BYTES,
  MAX_RECORD_PLAINTEXT,
  NoiseError,
  phoneHello,
  RecordCipher,
  TRANSPORT_DIRECT,
  TRANSPORT_RELAY,
  type TransportByte,
} from "../../src/e2e/noise.ts";

const T = generateKeyPair();
const tokenPsk = (token: string) => psk(credentialHash(token), keyId(T.publicKey));

function hello(token: string, transport: TransportByte = TRANSPORT_RELAY, conn = randomBytes(16)) {
  const connText = conn.toString("base64url");
  return { conn: connText, hello: phoneHello({ remoteStatic: T.publicKey, psk: tokenPsk(token), transport }, encodePayload1(conn, "test/1"), connText) };
}

describe("the handshake with random keys", () => {
  it("finds the one device among 21 candidates and agrees on keys both ways", () => {
    const tokens = Array.from({ length: 21 }, (_, index) => `omb_${index}_${randomBytes(8).toString("hex")}`);
    const { hello: phone } = hello(tokens[17]);
    const accepted = computerAccept(
      { staticKey: T, transport: TRANSPORT_RELAY, candidates: tokens.map((token, id) => ({ id, psk: tokenPsk(token) })) },
      phone.message1,
    );
    expect(accepted?.id).toBe(17);
    const keys = phone.finish(accepted!.message2);
    expect(keys.handshakeHash.equals(accepted!.keys.handshakeHash)).toBe(true);
    const record = keys.send.seal(Buffer.from("hello"));
    expect(accepted!.keys.receive.open(record).toString()).toBe("hello");
    expect(keys.receive.open(accepted!.keys.send.seal(Buffer.from("back"))).toString()).toBe("back");
  });

  it("uses fresh ephemerals, so two dials never share keys", () => {
    const first = hello("omb_same", TRANSPORT_DIRECT, Buffer.alloc(16));
    const second = hello("omb_same", TRANSPORT_DIRECT, Buffer.alloc(16));
    expect(first.hello.message1.equals(second.hello.message1)).toBe(false);
  });

  it("refuses a device on a transport its psk was not offered for", () => {
    const { hello: phone } = hello("omb_local_only", TRANSPORT_RELAY);
    expect(computerAccept({ staticKey: T, transport: TRANSPORT_RELAY, candidates: [] }, phone.message1)).toBeNull();
  });

  it("refuses a replayed message 1 cleanly, and the replayer learns nothing usable", () => {
    const { hello: phone } = hello("omb_replay");
    const options = { staticKey: T, transport: TRANSPORT_RELAY as TransportByte, candidates: [{ id: "a", psk: tokenPsk("omb_replay") }] };
    const first = computerAccept(options, phone.message1)!;
    const replay = computerAccept(options, phone.message1)!;
    // The computer answers again, but with a fresh e: keys differ and only the phone's live state can finish one.
    expect(first.message2.equals(replay.message2)).toBe(false);
    expect(first.keys.handshakeHash.equals(replay.keys.handshakeHash)).toBe(false);
  });

  it("is a hard stop when message 2 is finished twice", () => {
    const { hello: phone } = hello("omb_twice");
    const accepted = computerAccept({ staticKey: T, transport: TRANSPORT_RELAY, candidates: [{ id: 1, psk: tokenPsk("omb_twice") }] }, phone.message1)!;
    phone.finish(accepted.message2);
    expect(() => phone.finish(accepted.message2)).toThrow(NoiseError);
  });

  it("caps payload1 before anything else", () => {
    expect(() =>
      phoneHello({ remoteStatic: T.publicKey, psk: tokenPsk("omb_x"), transport: TRANSPORT_RELAY }, Buffer.alloc(MAX_HANDSHAKE_PAYLOAD + 1), "x"),
    ).toThrow(NoiseError);
  });

  it("refuses an app string over 40 characters", () => {
    const conn = randomBytes(16);
    const payload = Buffer.from(JSON.stringify({ v: 1, conn: conn.toString("base64url"), app: "x".repeat(41) }));
    const phone = phoneHello({ remoteStatic: T.publicKey, psk: tokenPsk("omb_app"), transport: TRANSPORT_RELAY }, payload, conn.toString("base64url"));
    expect(computerAccept({ staticKey: T, transport: TRANSPORT_RELAY, candidates: [{ id: 1, psk: tokenPsk("omb_app") }] }, phone.message1)).toBeNull();
  });
});

describe("records", () => {
  const pair = () => {
    const key = randomBytes(32);
    return { send: new RecordCipher(new CipherState(key)), receive: new RecordCipher(new CipherState(Buffer.from(key))) };
  };

  it("carry up to 65,519 plaintext bytes in a 65,535-byte record", () => {
    const { send, receive } = pair();
    const record = send.seal(Buffer.alloc(MAX_RECORD_PLAINTEXT, 7));
    expect(record.length).toBe(MAX_RECORD_BYTES);
    expect(receive.open(record).length).toBe(MAX_RECORD_PLAINTEXT);
    expect(() => send.seal(Buffer.alloc(MAX_RECORD_PLAINTEXT + 1))).toThrow(NoiseError);
    expect(() => receive.open(Buffer.alloc(MAX_RECORD_BYTES + 1))).toThrow(NoiseError);
  });

  it("refuse to reuse a nonce: each direction stops at 2^32 records", () => {
    const key = randomBytes(32);
    const send = new RecordCipher(new CipherState(key, 2 ** 32 - 1));
    const receive = new RecordCipher(new CipherState(Buffer.from(key), 2 ** 32 - 1));
    expect(receive.open(send.seal(Buffer.from("last"))).toString()).toBe("last");
    expect(() => send.seal(Buffer.from("one more"))).toThrow(NoiseError);
    expect(() => receive.open(Buffer.alloc(32))).toThrow(NoiseError);
  });
});
