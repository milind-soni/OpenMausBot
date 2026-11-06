import { createECDH } from "node:crypto";

/** The computer's transport key for the end-to-end phone connection, kept in the secure credential document. Separate
 * from the phone-secret HPKE key: one key, one job. Its presence is what turns the encrypted connection on, and it
 * never goes away by itself, so phones that pinned it keep reaching this computer on Wi-Fi even signed out. */
export const E2E_TRANSPORT_KEY_FIELD = "e2eTransportKey";
export const E2E_IDENTITY_VERSION = 1;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encode = (bytes) => Buffer.from(bytes).toString("base64url");

function decode(value, bytes) {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === bytes && encode(decoded) === value ? decoded : null;
}

/** The public point is rebuilt from the scalar before the record is trusted, so a torn write never advertises a key
 * this computer can't use. */
export function readE2EIdentity(credentials) {
  const candidate = credentials?.[E2E_TRANSPORT_KEY_FIELD];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (candidate.version !== E2E_IDENTITY_VERSION) return null;
  const scalar = decode(candidate.privateKey, 32);
  if (!scalar) return null;
  let publicKey;
  try {
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(scalar);
    publicKey = encode(curve.getPublicKey(undefined, "uncompressed"));
  } catch {
    return null;
  }
  if (candidate.publicKey !== publicKey) return null;
  return { version: E2E_IDENTITY_VERSION, privateKey: candidate.privateKey, publicKey };
}

export function createE2EIdentity() {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  const raw = curve.getPrivateKey();
  const identity = {
    version: E2E_IDENTITY_VERSION,
    privateKey: encode(Buffer.concat([Buffer.alloc(32 - raw.length), raw])),
    publicKey: encode(curve.getPublicKey(undefined, "uncompressed")),
  };
  if (!readE2EIdentity({ [E2E_TRANSPORT_KEY_FIELD]: identity })) throw new Error("The connection key could not be verified");
  return identity;
}

export function withE2EIdentity(credentials, identity) {
  const verified = readE2EIdentity({ [E2E_TRANSPORT_KEY_FIELD]: identity });
  if (!verified) throw new Error("The connection key is invalid");
  return { ...credentials, [E2E_TRANSPORT_KEY_FIELD]: verified };
}

/** The private half travels only over Electron's in-memory utility-process port: never argv, env, logs, renderer IPC,
 * companion state or a QR. `relay` is null until this computer holds a relay token. */
export function companionE2EMessage(identity, relay) {
  const verified = identity ? readE2EIdentity({ [E2E_TRANSPORT_KEY_FIELD]: identity }) : null;
  return {
    type: "openmausbot:companion-e2e",
    transportKey: verified?.privateKey ?? null,
    relay: verified && relay ? { hostId: relay.hostId, nodes: [...relay.nodes], relayToken: relay.token } : null,
  };
}
