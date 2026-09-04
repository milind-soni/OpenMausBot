import { createECDH, createHash, type webcrypto } from "node:crypto";

import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

export const PHONE_SECRET_PROTOCOL_VERSION = 1 as const;
export const PHONE_SECRET_INFO = "OpenMausBot phone credential v1";
export const PHONE_SECRET_MAX_BYTES = 4_096;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROUTE_ID = /^[\w-]{1,128}$/;
const TARGET_ID = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export interface PhoneSecretEnvelope {
  version: 1;
  keyId: string;
  deviceId: string;
  target: string;
  requestKey: string;
  encapsulatedKey: string;
  ciphertext: string;
}

export interface PhoneSecretContext extends PhoneSecretEnvelope {
  botId: string;
  threadId: string;
  messageId: string;
}

interface PhoneSecretIdentity {
  keyId: string;
  privateKey: CryptoKey;
}

type SendPrivateMessage = (message: {
  type: "openmausbot:phone-secret-save";
  requestId: string;
  target: string;
  value: string;
}) => boolean;

type PendingSave = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PhoneSecretError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PhoneSecretError";
    this.status = status;
  }
}

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const INFO = new TextEncoder().encode(PHONE_SECRET_INFO);

const decodeBase64URL = (value: unknown, expectedBytes?: number): Uint8Array | null => {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (
      (expectedBytes !== undefined && decoded.length !== expectedBytes) ||
      decoded.toString("base64url") !== value
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
};

export function phoneSecretKeyIdFromJwk(jwk: webcrypto.JsonWebKey): string | null {
  const x = decodeBase64URL(jwk.x, 32);
  const y = decodeBase64URL(jwk.y, 32);
  if (!x || !y) return null;
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([4]), x, y]))
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/** A single canonical string is used by Swift and TypeScript. Every dynamic
 * field is route-safe ASCII and therefore cannot contain the newline
 * separator. Authenticating this metadata prevents a relay from moving one
 * ciphertext to another bot, conversation, card, device, or credential. */
export function phoneSecretAAD(context: Pick<
  PhoneSecretContext,
  "keyId" | "deviceId" | "botId" | "threadId" | "messageId" | "target" | "requestKey"
>): Uint8Array {
  const fields = [
    "openmausbot-phone-credential-v1",
    context.keyId,
    context.deviceId,
    context.botId,
    context.threadId,
    context.messageId,
    context.target,
    context.requestKey,
  ];
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(context.keyId) ||
    !fields.slice(2, 6).every((value) => ROUTE_ID.test(value)) ||
    !TARGET_ID.test(context.target) ||
    !ROUTE_ID.test(context.requestKey)
  ) {
    throw new PhoneSecretError("The credential request metadata is invalid");
  }
  return new TextEncoder().encode(fields.join("\n"));
}

/**
 * A stable, non-secret operation id for one exact HPKE envelope. Electron
 * uses it to join a retry whose HTTP response was lost instead of validating
 * and writing the same credential twice. A freshly encrypted submission has
 * a different encapsulated key/ciphertext and therefore a different id.
 */
export function phoneSecretOperationId(context: PhoneSecretContext): string {
  const aad = phoneSecretAAD(context);
  return createHash("sha256")
    .update(aad)
    .update("\0")
    .update(String(context.version))
    .update("\n")
    .update(context.encapsulatedKey)
    .update("\n")
    .update(context.ciphertext)
    .digest("base64url");
}

export function assertPhoneSecretRequestMatches(
  context: Pick<PhoneSecretContext, "deviceId" | "target" | "requestKey">,
  authenticatedDeviceId: string,
  expected: { target: string; requestKey: string },
): void {
  if (
    context.deviceId !== authenticatedDeviceId ||
    context.target !== expected.target ||
    context.requestKey !== expected.requestKey
  ) {
    throw new PhoneSecretError("This encrypted credential does not belong to this request", 409);
  }
}

/** Serializes the state transition for one pending credential card. Exact
 * retransmissions join the original operation; a separately encrypted value
 * cannot be mistaken for that retry, and callers can block dismiss/resume
 * while the operating-system store is committing. */
export class PhoneSecretSubmissionRegistry {
  private readonly active = new Map<
    string,
    {
      operationId: string;
      promise: Promise<void>;
      resources: ReadonlySet<string>;
    }
  >();
  private readonly mutations = new Set<string>();

  private resources(scope: {
    botId?: string;
    threadId?: string;
    groupId?: string;
  }): Set<string> {
    return new Set([
      ...(scope.botId ? [`bot:${scope.botId}`] : []),
      ...(scope.threadId ? [`thread:${scope.threadId}`] : []),
      ...(scope.groupId ? [`group:${scope.groupId}`] : []),
    ]);
  }

  private hasActiveResource(resources: ReadonlySet<string>): boolean {
    return [...this.active.values()].some((entry) =>
      [...resources].some((resource) => entry.resources.has(resource))
    );
  }

  has(cardKey: string): boolean {
    return this.active.has(cardKey);
  }

  hasBot(botId: string): boolean {
    return this.hasActiveResource(this.resources({ botId }));
  }

  hasThread(threadId: string): boolean {
    return this.hasActiveResource(this.resources({ threadId }));
  }

  hasGroup(groupId: string): boolean {
    return this.hasActiveResource(this.resources({ groupId }));
  }

  /** Claim a structural mutation before its first await. A submission and a
   * destructive/rewind mutation can then never both pass their preflight
   * checks and invalidate each other while the OS credential store is slow. */
  claimMutation(scope: {
    botId?: string;
    threadId?: string;
    groupId?: string;
  }): (() => void) | null {
    const resources = this.resources(scope);
    if (
      resources.size === 0 ||
      this.hasActiveResource(resources) ||
      [...resources].some((resource) => this.mutations.has(resource))
    ) {
      return null;
    }
    for (const resource of resources) this.mutations.add(resource);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const resource of resources) this.mutations.delete(resource);
    };
  }

  async run(
    scope: { cardKey: string; botId: string; threadId: string; groupId?: string },
    operationId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const running = this.active.get(scope.cardKey);
    if (running) {
      if (running.operationId !== operationId) {
        throw new PhoneSecretError("Another credential submission is already being saved", 409);
      }
      await running.promise;
      return;
    }

    const resources = this.resources(scope);
    if ([...resources].some((resource) => this.mutations.has(resource))) {
      throw new PhoneSecretError("This credential request is being changed. Try again.", 409);
    }

    // Deferring work by one microtask lets the registry publish the active
    // entry before decrypt/save begins, so no synchronous callback can slip a
    // competing state transition through the gap.
    const promise = Promise.resolve().then(work);
    const entry = { operationId, promise, resources };
    this.active.set(scope.cardKey, entry);
    try {
      await promise;
    } finally {
      if (this.active.get(scope.cardKey) === entry) this.active.delete(scope.cardKey);
    }
  }
}

async function importIdentity(message: Record<string, unknown>): Promise<PhoneSecretIdentity> {
  if (message.version !== PHONE_SECRET_PROTOCOL_VERSION) {
    throw new PhoneSecretError("The desktop credential key version is unsupported", 503);
  }
  const keyId = String(message.keyId ?? "");
  const candidate = message.privateKey;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new PhoneSecretError("The desktop credential key is unavailable", 503);
  }
  const privateKey = candidate as webcrypto.JsonWebKey;
  const x = decodeBase64URL(privateKey.x, 32);
  const y = decodeBase64URL(privateKey.y, 32);
  const d = decodeBase64URL(privateKey.d, 32);
  if (
    privateKey.kty !== "EC" ||
    privateKey.crv !== "P-256" ||
    !x ||
    !y ||
    !d ||
    phoneSecretKeyIdFromJwk(privateKey) !== keyId
  ) {
    throw new PhoneSecretError("The desktop credential key is invalid", 503);
  }
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey(undefined, "uncompressed").equals(
      Buffer.concat([Buffer.from([4]), x, y]),
    )) {
      throw new Error("mismatched public point");
    }
  } catch {
    throw new PhoneSecretError("The desktop credential key is invalid", 503);
  }
  const imported = await suite.kem.importKey("jwk", {
    kty: "EC",
    crv: "P-256",
    x: privateKey.x,
    y: privateKey.y,
    d: privateKey.d,
    ext: true,
    key_ops: ["deriveBits"],
  }, false);
  return { keyId, privateKey: imported };
}

function decodeSaveResult(raw: unknown): { requestId: string; ok: boolean; error?: string } | null {
  const message = (raw as { data?: unknown } | null)?.data ?? raw;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  if (value.type !== "openmausbot:phone-secret-save-result") return null;
  if (typeof value.requestId !== "string" || !ROUTE_ID.test(value.requestId) || typeof value.ok !== "boolean") {
    return null;
  }
  return {
    requestId: value.requestId,
    ok: value.ok,
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 180) } : {}),
  };
}

/**
 * Owns the narrow private bridge between the embedded server and Electron's
 * OS-encrypted credential document. The phone-facing HTTP route gives this
 * class ciphertext only. Plaintext exists only after HPKE opens it on the
 * desktop and is immediately handed to the already-existing credential save
 * path; it is never returned to HTTP, chat, SQLite, SSE, or logs.
 */
export class PhoneSecretBridge {
  private identity: Promise<PhoneSecretIdentity> | null = null;
  private readonly pending = new Map<string, PendingSave>();
  private active = 0;
  private readonly send: SendPrivateMessage;
  private readonly timeoutMs: number;
  private readonly maximumPending: number;

  constructor(
    send: SendPrivateMessage,
    // Provider validation is part of the encrypted-store transaction and can
    // legitimately take tens of seconds. This remains bounded, but outlives
    // every provider's own deadline so a late successful save is not reported
    // as a failure and then repeated underneath the user.
    // Stay materially below the outer HTTPS proxy and phone deadlines. This
    // leaves enough time for their JSON response to travel after a slow
    // provider validation instead of turning a committed save into a client
    // timeout at Cloudflare's boundary.
    timeoutMs = 90_000,
    maximumPending = 8,
  ) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.maximumPending = maximumPending;
  }

  receive(raw: unknown): boolean {
    const message = (raw as { data?: unknown } | null)?.data ?? raw;
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const record = message as Record<string, unknown>;
    if (record.type === "openmausbot:phone-secret-key") {
      // Keep the rejection inside the promise. A request receives a bounded
      // 503; an invalid parent message must never become an unhandled reject.
      this.identity = importIdentity(record);
      void this.identity.catch(() => {});
      return true;
    }
    const result = decodeSaveResult(record);
    if (!result) return false;
    const pending = this.pending.get(result.requestId);
    if (!pending) return true;
    this.pending.delete(result.requestId);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve();
    else pending.reject(new PhoneSecretError(result.error || "The credential could not be saved", 503));
    return true;
  }

  async provide(context: PhoneSecretContext): Promise<void> {
    if (this.active >= this.maximumPending) {
      throw new PhoneSecretError("Another secure credential is still being saved. Try again.", 429);
    }
    this.active += 1;
    try {
      await this.provideWithinLimit(context);
    } finally {
      this.active -= 1;
    }
  }

  private async provideWithinLimit(context: PhoneSecretContext): Promise<void> {
    if (!this.identity) {
      throw new PhoneSecretError(
        "Secure phone entry is not ready on this computer. Reopen OpenMausBot and try again.",
        503,
      );
    }
    const identity = await this.identity.catch(() => {
      throw new PhoneSecretError(
        "Secure phone entry is not ready on this computer. Reopen OpenMausBot and try again.",
        503,
      );
    });
    if (context.version !== PHONE_SECRET_PROTOCOL_VERSION || context.keyId !== identity.keyId) {
      throw new PhoneSecretError("This phone was paired with an older security key. Pair it again by QR code.", 409);
    }

    const encapsulatedKey = decodeBase64URL(context.encapsulatedKey, 65);
    const ciphertext = decodeBase64URL(context.ciphertext);
    if (
      !encapsulatedKey ||
      !ciphertext ||
      ciphertext.length <= 16 ||
      ciphertext.length > PHONE_SECRET_MAX_BYTES + 16
    ) {
      throw new PhoneSecretError("The encrypted credential is invalid");
    }

    let opened: ArrayBuffer;
    try {
      opened = await suite.open(
        { recipientKey: identity.privateKey, enc: encapsulatedKey, info: INFO },
        ciphertext,
        phoneSecretAAD(context),
      );
    } catch {
      throw new PhoneSecretError("The encrypted credential could not be verified");
    }

    const openedBytes = new Uint8Array(opened);
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(openedBytes).trim();
    } catch {
      throw new PhoneSecretError("The encrypted credential is not valid text");
    } finally {
      openedBytes.fill(0);
    }
    if (!value || Buffer.byteLength(value) > PHONE_SECRET_MAX_BYTES) {
      throw new PhoneSecretError("The credential must be between 1 and 4096 bytes");
    }

    const requestId = phoneSecretOperationId(context);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PhoneSecretError("The operating-system credential store did not respond. Try again.", 504));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      if (this.send({
        type: "openmausbot:phone-secret-save",
        requestId,
        target: context.target,
        value,
      })) return;
      clearTimeout(timer);
      this.pending.delete(requestId);
      reject(new PhoneSecretError("Secure phone entry is unavailable in this build.", 503));
    });
  }
}
