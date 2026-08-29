import { randomBytes } from "node:crypto";

export const FIREBASE_PUSH_ENCRYPTION_KEY_FIELD = "firebasePushEncryptionKey";
export const FIREBASE_SERVICE_ACCOUNT_FIELD = "firebaseServiceAccountJson";

const SERVICE_ACCOUNT_FIELDS = [
  "type",
  "project_id",
  "private_key_id",
  "private_key",
  "client_email",
  "client_id",
  "auth_uri",
  "token_uri",
  "auth_provider_x509_cert_url",
  "client_x509_cert_url",
  "universe_domain",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Key(value) {
  if (typeof value !== "string" || !value) return false;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return false;
  }
  return decoded.length === 32 && decoded.toString("base64") === value;
}

/** Validate and normalize the subset of a Google service-account document the
 * FCM sender needs. Client-only google-services.json deliberately fails this
 * boundary because it has no private key or service-account identity. */
export function parseFirebaseServiceAccount(input) {
  let value;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("Invalid Firebase service-account JSON");
  }
  if (!isRecord(value)) throw new Error("Invalid Firebase service-account JSON");

  const required = ["type", "project_id", "private_key", "client_email", "token_uri"];
  if (required.some((field) => typeof value[field] !== "string" || !value[field].trim())) {
    throw new Error("Firebase service-account JSON requires a private key and service-account identity");
  }
  if (value.type !== "service_account" || !value.private_key.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("Firebase service-account JSON requires a private key and service-account identity");
  }

  const normalized = {};
  for (const field of SERVICE_ACCOUNT_FIELDS) {
    if (typeof value[field] === "string" && value[field]) normalized[field] = value[field];
  }
  return normalized;
}

/** Return a copy with a stable, OS-encrypted 32-byte key added when absent.
 * Invalid existing keys are left untouched so startup cannot silently strand
 * already-encrypted push targets by rotating the key under them. */
export function ensureFirebasePushEncryptionKey(credentials, generate = randomBytes) {
  const current = isRecord(credentials) ? { ...credentials } : {};
  if (isBase64Key(current[FIREBASE_PUSH_ENCRYPTION_KEY_FIELD])) return current;
  if (Object.hasOwn(current, FIREBASE_PUSH_ENCRYPTION_KEY_FIELD)) return current;
  const generated = generate(32);
  if (!generated || typeof generated.length !== "number" || generated.length !== 32) {
    throw new Error("Could not generate the Firebase push encryption key");
  }
  current[FIREBASE_PUSH_ENCRYPTION_KEY_FIELD] = Buffer.from(generated).toString("base64");
  return current;
}

/** Shape only the two companion secrets into child-process environment values.
 * Malformed stored values fail closed and are omitted; secrets never enter
 * argv or the caller's logs. */
export function firebaseCredentialEnv(credentials) {
  const env = {};
  const key = credentials?.[FIREBASE_PUSH_ENCRYPTION_KEY_FIELD];
  if (isBase64Key(key)) env.OMB_PUSH_ENCRYPTION_KEY = key;

  const rawAccount = credentials?.[FIREBASE_SERVICE_ACCOUNT_FIELD];
  if (typeof rawAccount === "string" && rawAccount) {
    try {
      const account = parseFirebaseServiceAccount(rawAccount);
      env.OMB_FIREBASE_SERVICE_ACCOUNT_B64 = Buffer.from(JSON.stringify(account), "utf8").toString("base64");
    } catch {
      /* malformed credentials stay unavailable until explicitly re-imported */
    }
  }
  return env;
}

export function firebaseCredentialStatus(credentials) {
  const rawAccount = credentials?.[FIREBASE_SERVICE_ACCOUNT_FIELD];
  let projectId;
  if (typeof rawAccount === "string" && rawAccount) {
    try {
      projectId = parseFirebaseServiceAccount(rawAccount).project_id;
    } catch {
      /* malformed credentials are intentionally reported as unconfigured */
    }
  }
  const status = {
    pushEncryptionKeyConfigured: isBase64Key(credentials?.[FIREBASE_PUSH_ENCRYPTION_KEY_FIELD]),
    serviceAccountConfigured: typeof projectId === "string",
  };
  if (projectId) status.projectId = projectId;
  return status;
}

/** Import a downloaded service-account file through a caller-supplied
 * encrypted-update seam. The path is deliberately not returned and the
 * returned result contains only public project metadata. */
export async function importFirebaseServiceAccountFile({ filePath, readFile, updateCredentials }) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("A Firebase service-account file is required");
  if (typeof readFile !== "function" || typeof updateCredentials !== "function") {
    throw new Error("Firebase service-account import is unavailable");
  }
  const parsed = parseFirebaseServiceAccount(await readFile(filePath));
  const serialized = JSON.stringify(parsed);
  await updateCredentials((credentials) => ({
    ...(isRecord(credentials) ? credentials : {}),
    [FIREBASE_SERVICE_ACCOUNT_FIELD]: serialized,
  }));
  return { configured: true, projectId: parsed.project_id };
}
