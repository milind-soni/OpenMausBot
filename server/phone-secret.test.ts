import { createHash, webcrypto } from "node:crypto";

import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { describe, expect, it, vi } from "vitest";

import {
  PHONE_SECRET_INFO,
  PhoneSecretBridge,
  PhoneSecretError,
  PhoneSecretSubmissionRegistry,
  assertPhoneSecretRequestMatches,
  phoneSecretAAD,
  phoneSecretOperationId,
  type PhoneSecretContext,
} from "./phone-secret.ts";

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

async function keyMaterial() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const keyId = createHash("sha256").update(raw).digest().subarray(0, 16).toString("base64url");
  return {
    publicKey: await suite.kem.deserializePublicKey(raw),
    message: { type: "openmausbot:phone-secret-key", version: 1, keyId, privateKey },
    keyId,
  };
}

const baseContext = (keyId: string): Omit<PhoneSecretContext, "encapsulatedKey" | "ciphertext"> => ({
  version: 1,
  keyId,
  deviceId: "paired-device-1",
  botId: "bot-1",
  threadId: "thread-1",
  messageId: "message-1",
  target: "ttsKey",
  requestKey: "credential-request-1",
});

async function seal(
  context: Omit<PhoneSecretContext, "encapsulatedKey" | "ciphertext">,
  publicKey: CryptoKey,
  value = "elevenlabs-secret",
): Promise<PhoneSecretContext> {
  const encrypted = await suite.seal(
    { recipientPublicKey: publicKey, info: new TextEncoder().encode(PHONE_SECRET_INFO) },
    new TextEncoder().encode(value),
    phoneSecretAAD(context),
  );
  return {
    ...context,
    encapsulatedKey: Buffer.from(encrypted.enc).toString("base64url"),
    ciphertext: Buffer.from(encrypted.ct).toString("base64url"),
  };
}

describe("PhoneSecretBridge", () => {
  it("opens an envelope produced by Apple's CryptoKit HPKE implementation", async () => {
    let bridge!: PhoneSecretBridge;
    const send = vi.fn((message: { requestId: string; value: string }) => {
      expect(message.value).toBe("swift-to-node-secret");
      queueMicrotask(() => bridge.receive({
        type: "openmausbot:phone-secret-save-result",
        requestId: message.requestId,
        ok: true,
      }));
      return true;
    });
    bridge = new PhoneSecretBridge(send, 200);
    bridge.receive({
      type: "openmausbot:phone-secret-key",
      version: 1,
      keyId: "taWSR_nZ7ojlH_0Z3tar6Q",
      privateKey: {
        kty: "EC",
        crv: "P-256",
        x: "g8FDXb91acXUNkuxNk7dWDQ0aN2zn6On2HeOGOvZOjs",
        y: "bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU",
        d: "5B-SwYLGXc04u4v7YLpzFrwj2JjysBFaJevOPl3h3Zg",
      },
    });

    await expect(bridge.provide({
      version: 1,
      keyId: "taWSR_nZ7ojlH_0Z3tar6Q",
      deviceId: "paired-device-1",
      botId: "bot-1",
      threadId: "thread-1",
      messageId: "message-1",
      target: "ttsKey",
      requestKey: "credential-request-1",
      encapsulatedKey: "BDhy_5hMSvVIy3zGSmBwBECAedYBAwwFLvbWoXCGTJyLRH1cItoQXo9NBcEG0cTQV_VwaEf5judXcsJlh2jfW7Q",
      ciphertext: "CjM0CnBT8NYd_BHAXJRKFrbYrSw6OgMIlJLAKs8VUPSSCsa2",
    })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("opens the card-bound envelope and saves through the private parent", async () => {
    const material = await keyMaterial();
    let bridge!: PhoneSecretBridge;
    const send = vi.fn((message: { requestId: string; value: string; target: string }) => {
      expect(message.value).toBe("elevenlabs-secret");
      expect(message.target).toBe("ttsKey");
      queueMicrotask(() => bridge.receive({
        type: "openmausbot:phone-secret-save-result",
        requestId: message.requestId,
        ok: true,
      }));
      return true;
    });
    bridge = new PhoneSecretBridge(send, 200);
    expect(bridge.receive(material.message)).toBe(true);

    await expect(bridge.provide(await seal(baseContext(material.keyId), material.publicKey))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses metadata tampering before plaintext reaches the private parent", async () => {
    const material = await keyMaterial();
    const send = vi.fn(() => true);
    const bridge = new PhoneSecretBridge(send, 50);
    bridge.receive(material.message);
    const envelope = await seal(baseContext(material.keyId), material.publicKey);

    await expect(bridge.provide({ ...envelope, botId: "another-bot" })).rejects.toMatchObject({
      message: "The encrypted credential could not be verified",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("requires the exact pinned desktop key", async () => {
    const material = await keyMaterial();
    const bridge = new PhoneSecretBridge(() => true, 50);
    bridge.receive(material.message);
    const envelope = await seal(baseContext(material.keyId), material.publicKey);

    await expect(bridge.provide({
      ...envelope,
      keyId: "AAAAAAAAAAAAAAAAAAAAAA",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("fails closed when no embedded Electron parent supplied a key", async () => {
    const bridge = new PhoneSecretBridge(() => true, 50);
    await expect(bridge.provide({
      ...baseContext("AAAAAAAAAAAAAAAAAAAAAA"),
      encapsulatedKey: "A".repeat(87),
      ciphertext: "A".repeat(24),
    })).rejects.toEqual(expect.objectContaining<Partial<PhoneSecretError>>({ status: 503 }));
  });

  it("rejects a private scalar that does not match the advertised public point", async () => {
    const material = await keyMaterial();
    const other = await keyMaterial();
    const bridge = new PhoneSecretBridge(() => true, 50);
    bridge.receive({
      ...material.message,
      privateKey: {
        ...material.message.privateKey,
        d: other.message.privateKey.d,
      },
    });

    await expect(bridge.provide({
      ...baseContext(material.keyId),
      encapsulatedKey: "A".repeat(87),
      ciphertext: "A".repeat(24),
    })).rejects.toMatchObject({ status: 503 });
  });

  it("turns a private-store refusal into a bounded client error", async () => {
    const material = await keyMaterial();
    let bridge!: PhoneSecretBridge;
    bridge = new PhoneSecretBridge((message) => {
      queueMicrotask(() => bridge.receive({
        type: "openmausbot:phone-secret-save-result",
        requestId: message.requestId,
        ok: false,
        error: "The operating-system credential store is unavailable",
      }));
      return true;
    }, 200);
    bridge.receive(material.message);

    await expect(bridge.provide(await seal(baseContext(material.keyId), material.publicKey))).rejects.toMatchObject({
      status: 503,
      message: "The operating-system credential store is unavailable",
    });
  });

  it("bounds the entire decrypt-and-save operation under concurrent load", async () => {
    const material = await keyMaterial();
    const envelope = await seal(baseContext(material.keyId), material.publicKey);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let firstRequestId = "";
    const bridge = new PhoneSecretBridge((message) => {
      firstRequestId = message.requestId;
      markStarted();
      return true;
    }, 200, 1);
    bridge.receive(material.message);

    const first = bridge.provide(envelope);
    await started;
    await expect(bridge.provide(envelope)).rejects.toMatchObject({ status: 429 });
    bridge.receive({
      type: "openmausbot:phone-secret-save-result",
      requestId: firstRequestId,
      ok: true,
    });
    await expect(first).resolves.toBeUndefined();
  });
});

describe("phoneSecretAAD", () => {
  it("has the exact stable cross-platform serialization", () => {
    expect(new TextDecoder().decode(phoneSecretAAD(baseContext("AAAAAAAAAAAAAAAAAAAAAA")))).toBe([
      "openmausbot-phone-credential-v1",
      "AAAAAAAAAAAAAAAAAAAAAA",
      "paired-device-1",
      "bot-1",
      "thread-1",
      "message-1",
      "ttsKey",
      "credential-request-1",
    ].join("\n"));
  });

  it("binds an envelope to the authenticated phone and pending card", () => {
    const context = baseContext("AAAAAAAAAAAAAAAAAAAAAA");
    expect(() => assertPhoneSecretRequestMatches(context, "paired-device-1", {
      target: "ttsKey",
      requestKey: "credential-request-1",
    })).not.toThrow();
    for (const candidate of [
      { ...context, deviceId: "another-device" },
      { ...context, target: "xaiApiKey" },
      { ...context, requestKey: "another-request" },
    ]) {
      expect(() => assertPhoneSecretRequestMatches(candidate, "paired-device-1", {
        target: "ttsKey",
        requestKey: "credential-request-1",
      })).toThrow(expect.objectContaining({ status: 409 }));
    }
  });

  it("gives an exact encrypted retry one stable desktop operation id", async () => {
    const material = await keyMaterial();
    const envelope = await seal(baseContext(material.keyId), material.publicKey);
    const operationId = phoneSecretOperationId(envelope);
    expect(operationId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(phoneSecretOperationId({ ...envelope })).toBe(operationId);
    expect(phoneSecretOperationId({
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`,
    })).not.toBe(operationId);
  });
});

describe("PhoneSecretSubmissionRegistry", () => {
  it("joins only an exact retry and locks the card transition until commit", async () => {
    const registry = new PhoneSecretSubmissionRegistry();
    const scope = {
      cardKey: "thread:message:request",
      botId: "bot-1",
      threadId: "thread-1",
      groupId: "group-1",
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const work = vi.fn(async () => { await blocked; });
    const duplicateWork = vi.fn(async () => {});

    const first = registry.run(scope, "operation-1", work);
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
    expect(registry.has("thread:message:request")).toBe(true);
    expect(registry.hasBot("bot-1")).toBe(true);
    expect(registry.hasThread("thread-1")).toBe(true);
    expect(registry.hasGroup("group-1")).toBe(true);
    expect(registry.claimMutation({ botId: "bot-1" })).toBeNull();
    expect(registry.claimMutation({ threadId: "thread-1" })).toBeNull();
    expect(registry.claimMutation({ groupId: "group-1" })).toBeNull();
    const exactRetry = registry.run(scope, "operation-1", duplicateWork);
    await expect(registry.run(
      scope,
      "operation-2",
      duplicateWork,
    )).rejects.toMatchObject({ status: 409 });
    expect(duplicateWork).not.toHaveBeenCalled();

    release();
    await expect(Promise.all([first, exactRetry])).resolves.toEqual([undefined, undefined]);
    expect(registry.has("thread:message:request")).toBe(false);
    expect(registry.hasBot("bot-1")).toBe(false);
    expect(registry.hasThread("thread-1")).toBe(false);
    expect(registry.hasGroup("group-1")).toBe(false);
  });

  it("refuses a submission while an overlapping structural mutation is claimed", async () => {
    const registry = new PhoneSecretSubmissionRegistry();
    const release = registry.claimMutation({ threadId: "thread-1" });
    expect(release).toBeTypeOf("function");
    expect(registry.claimMutation({ threadId: "thread-1" })).toBeNull();

    await expect(registry.run({
      cardKey: "thread:message:request",
      botId: "bot-1",
      threadId: "thread-1",
    }, "operation-1", async () => {})).rejects.toMatchObject({ status: 409 });

    release?.();
    await expect(registry.run({
      cardKey: "thread:message:request",
      botId: "bot-1",
      threadId: "thread-1",
    }, "operation-1", async () => {})).resolves.toBeUndefined();
  });
});
