import { createECDH, createHash, createHmac, randomBytes, webcrypto } from "node:crypto";

export const PHONE_SECRET_PROTOCOL_VERSION = 1;
export const PHONE_SECRET_CREDENTIAL_KEY = "phoneSecretHpke";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encodeBase64URL = (bytes) => Buffer.from(bytes).toString("base64url");

const decodeBase64URL = (value, bytes) => {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== bytes || encodeBase64URL(decoded) !== value) return null;
    return decoded;
  } catch {
    return null;
  }
};

export function phoneSecretKeyId(publicKey) {
  const raw = decodeBase64URL(publicKey, 65);
  if (!raw || raw[0] !== 4) return null;
  return createHash("sha256").update(raw).digest().subarray(0, 16).toString("base64url");
}

/**
 * Read the desktop's HPKE recipient identity from the OS-encrypted credential
 * document. The public point is reconstructed from the private JWK before the
 * record is trusted, so a partial/corrupt write can never advertise a key the
 * desktop cannot actually open.
 */
export function readPhoneSecretIdentity(credentials) {
  const candidate = credentials?.[PHONE_SECRET_CREDENTIAL_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (candidate.version !== PHONE_SECRET_PROTOCOL_VERSION) return null;

  const privateKey = candidate.privateKey;
  if (!privateKey || typeof privateKey !== "object" || Array.isArray(privateKey)) return null;
  if (privateKey.kty !== "EC" || privateKey.crv !== "P-256") return null;
  const x = decodeBase64URL(privateKey.x, 32);
  const y = decodeBase64URL(privateKey.y, 32);
  const d = decodeBase64URL(privateKey.d, 32);
  if (!x || !y || !d) return null;

  // Derive the point directly from the scalar instead of round-tripping a
  // JWK. Some OpenSSL builds preserve the JWK-supplied x/y on re-export even
  // when they do not match d, so that round-trip is not a portable proof.
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const derivedPublicKey = ecdh.getPublicKey(undefined, "uncompressed");
    const suppliedPublicKey = Buffer.concat([Buffer.from([4]), x, y]);
    if (!derivedPublicKey.equals(suppliedPublicKey)) return null;
  } catch {
    return null;
  }

  const publicKey = encodeBase64URL(Buffer.concat([Buffer.from([4]), x, y]));
  const keyId = phoneSecretKeyId(publicKey);
  if (!keyId || candidate.publicKey !== publicKey || candidate.keyId !== keyId) return null;

  return {
    version: PHONE_SECRET_PROTOCOL_VERSION,
    keyId,
    publicKey,
    privateKey: {
      kty: "EC",
      crv: "P-256",
      x: privateKey.x,
      y: privateKey.y,
      d: privateKey.d,
    },
  };
}

export async function createPhoneSecretIdentity() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const [publicBytes, exportedPrivate] = await Promise.all([
    webcrypto.subtle.exportKey("raw", pair.publicKey),
    webcrypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  const publicKey = encodeBase64URL(publicBytes);
  const keyId = phoneSecretKeyId(publicKey);
  if (
    !keyId ||
    exportedPrivate.kty !== "EC" ||
    exportedPrivate.crv !== "P-256" ||
    !exportedPrivate.x ||
    !exportedPrivate.y ||
    !exportedPrivate.d
  ) {
    throw new Error("The operating system could not create a phone credential key");
  }
  const identity = {
    version: PHONE_SECRET_PROTOCOL_VERSION,
    keyId,
    publicKey,
    privateKey: {
      kty: "EC",
      crv: "P-256",
      x: exportedPrivate.x,
      y: exportedPrivate.y,
      d: exportedPrivate.d,
    },
  };
  if (!readPhoneSecretIdentity({ [PHONE_SECRET_CREDENTIAL_KEY]: identity })) {
    throw new Error("The phone credential key could not be verified");
  }
  return identity;
}

export function withPhoneSecretIdentity(credentials, identity) {
  const verified = readPhoneSecretIdentity({ [PHONE_SECRET_CREDENTIAL_KEY]: identity });
  if (!verified) throw new Error("The phone credential key is invalid");
  return { ...credentials, [PHONE_SECRET_CREDENTIAL_KEY]: verified };
}

/** Only the embedded server receives the private half, through Electron's
 * in-memory utility-process port. It never enters argv, environment, logs,
 * renderer IPC, companion state, or a pairing QR. */
export function phoneSecretPrivateKeyMessage(identity) {
  const verified = readPhoneSecretIdentity({ [PHONE_SECRET_CREDENTIAL_KEY]: identity });
  if (!verified) return null;
  return {
    type: "openmausbot:phone-secret-key",
    version: verified.version,
    keyId: verified.keyId,
    privateKey: verified.privateKey,
  };
}

export function decodePhoneSecretSaveRequest(rawMessage) {
  const message = rawMessage?.data ?? rawMessage;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.type !== "openmausbot:phone-secret-save") return null;
  if (typeof message.requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(message.requestId)) return null;
  if (typeof message.target !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(message.target)) return null;
  if (typeof message.value !== "string") return null;
  const value = message.value.trim();
  if (!value || Buffer.byteLength(value) > 4_096) return null;
  return { requestId: message.requestId, target: message.target, value };
}

export function phoneSecretSaveResult(requestId, ok, error) {
  const result = {
    type: "openmausbot:phone-secret-save-result",
    requestId,
    ok: ok === true,
  };
  if (!result.ok && typeof error === "string" && error.trim()) {
    result.error = error.trim().slice(0, 180);
  }
  return result;
}

/**
 * Deduplicate the private desktop save by the stable envelope operation id.
 * This matters when the credential committed but a phone, tunnel, or proxy
 * lost the success response: the retry receives the cached result and never
 * starts a second provider validation/write. Only the non-secret target and
 * status are retained; the plaintext value falls out of scope as soon as the
 * save settles.
 */
export function createPhoneSecretSaveCoordinator(save, maximumCompleted = 512) {
  const active = new Map();
  const completed = new Map();
  const limit = Math.max(1, Number.isSafeInteger(maximumCompleted) ? maximumCompleted : 512);
  // The private IPC operation id is already the hash of the exact HPKE
  // envelope. Keep a process-random-keyed fingerprint only while a save is
  // active so a malformed duplicate cannot join with another plaintext.
  // Completed entries retain target + status only, never a stable derivative
  // of the user's secret.
  const activeSignatureKey = randomBytes(32);
  const signature = (request) => createHmac("sha256", activeSignatureKey)
    .update(request.target)
    .update("\0")
    .update(request.value)
    .digest("base64url");

  return async (request) => {
    const running = active.get(request.requestId);
    if (running) {
      const requestSignature = signature(request);
      if (running.signature !== requestSignature) {
        return phoneSecretSaveResult(request.requestId, false, "The credential save retry did not match");
      }
      return running.promise;
    }

    const prior = completed.get(request.requestId);
    if (prior) {
      if (prior.target !== request.target) {
        return phoneSecretSaveResult(request.requestId, false, "The credential save retry did not match");
      }
      // Refresh insertion order so a genuinely retried operation is the last
      // bounded cache entry to be evicted.
      completed.delete(request.requestId);
      completed.set(request.requestId, prior);
      return prior.result;
    }

    const requestSignature = signature(request);
    const operation = {
      signature: requestSignature,
      promise: Promise.resolve()
        .then(() => save(request.target, request.value))
        .then(
          () => phoneSecretSaveResult(request.requestId, true),
          (error) => phoneSecretSaveResult(
            request.requestId,
            false,
            error instanceof Error ? error.message : String(error),
          ),
        )
        .then((result) => {
          active.delete(request.requestId);
          // A committed save is safe to replay forever within the bounded
          // cache: this is the lost-response case the operation id exists to
          // cover. A failure is retryable (provider outage, locked keychain,
          // validation timeout), so retaining it would strand this exact
          // encrypted envelope until hundreds of unrelated saves evicted it.
          if (result.ok) {
            completed.set(request.requestId, { target: request.target, result });
            while (completed.size > limit) completed.delete(completed.keys().next().value);
          }
          return result;
        }),
    };
    active.set(request.requestId, operation);
    return operation.promise;
  };
}
