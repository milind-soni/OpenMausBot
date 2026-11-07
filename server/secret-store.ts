// Keeps credentials out of config.json. Opt-in with OMB_SECRET_STORE=keychain (macOS Keychain or Linux libsecret);
// anything else, or a platform without a backend, leaves config.json exactly as before.
//
// On save, every credential leaf is written to the OS store and replaced in the file by a reference string; on load the
// references are swapped back. The reference names only the JSON path, never the value, so a backup, a log line or a
// screenshot of config.json carries no secret.
import { execFileSync } from "node:child_process";
import type { JsonObject, JsonValue } from "../shared/json.ts";

export const SECRET_REF_PREFIX = "omb-secret-ref:v1:";
export const SECRET_SERVICE = "openmausbot";

/** Leaf names that hold a credential. `apiKeyEnv` and friends name an env variable, so they never match. */
const SECRET_LEAF = /^(key|apiKey|token|secret|password|fishKey|geminiKey|accessToken|refreshToken)$/;
/** Containers whose every string child is a credential (OpenCode's providerKeys: env name → key). */
const SECRET_CONTAINER = new Set(["providerKeys"]);

export interface SecretBackend {
  readonly name: string;
  get(account: string): string | undefined;
  set(account: string, value: string): void;
}

type Json = JsonValue;

export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_REF_PREFIX);
}

function refFor(path: string): string {
  return `${SECRET_REF_PREFIX}${path}`;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The account name a secret is stored under: its dotted JSON path, keys escaped so no two paths collide. */
export function accountFor(segments: readonly string[]): string {
  return segments.map((segment) => segment.replace(/\\/g, "\\\\").replace(/\./g, "\\.")).join(".");
}

function walk(value: Json, segments: string[], parentKey: string | undefined, visit: (segments: string[], leaf: string) => Json): Json {
  if (Array.isArray(value)) return value.map((item, index) => walk(item, [...segments, String(index)], undefined, visit));
  if (!isPlainObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const path = [...segments, key];
    const secretHere = typeof child === "string" && child !== "" && (SECRET_LEAF.test(key) || (parentKey !== undefined && SECRET_CONTAINER.has(parentKey)));
    out[key] = secretHere ? visit(path, child as string) : walk(child, path, key, visit);
  }
  return out;
}

export interface SealResult {
  config: Json;
  stored: number;
  failed: string[];
}

/** Moves every credential into the backend. A secret that fails to store stays in the file: losing a key is worse than
 * keeping it in a 0600 file, and the caller logs the account (never the value). */
export function sealSecrets(config: Json, backend: SecretBackend): SealResult {
  let stored = 0;
  const failed: string[] = [];
  const sealed = walk(config, [], undefined, (segments, leaf) => {
    if (isSecretRef(leaf)) return leaf;
    const account = accountFor(segments);
    try {
      backend.set(account, leaf);
      stored += 1;
      return refFor(account);
    } catch {
      failed.push(account);
      return leaf;
    }
  });
  return { config: sealed, stored, failed };
}

export interface UnsealResult {
  config: Json;
  missing: string[];
}

/** Swaps references back for values. A reference whose secret is gone becomes absent, so the integration reads as
 * "not configured" instead of sending the reference string to a provider as if it were a key. */
export function unsealSecrets(config: Json, backend: SecretBackend): UnsealResult {
  const missing: string[] = [];
  const strip = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(strip);
    if (!isPlainObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretRef(child)) {
        const account = child.slice(SECRET_REF_PREFIX.length);
        let secret: string | undefined;
        try {
          secret = backend.get(account);
        } catch {
          secret = undefined;
        }
        if (secret === undefined) missing.push(account);
        else out[key] = secret;
        continue;
      }
      out[key] = strip(child);
    }
    return out;
  };
  return { config: strip(config), missing };
}

// ---- Backends -------------------------------------------------------------------------------------------------

type Exec = (file: string, args: string[], input?: string) => string;

const defaultExec: Exec = (file, args, input) =>
  execFileSync(file, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });

/** Quotes one argument for `security -i`, which tokenizes like a shell: double quotes with \ and " escaped. */
function securityQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** macOS login Keychain via /usr/bin/security. Values go in on stdin (`security -i`), never on argv, so `ps` cannot see them. */
export function macKeychainBackend(exec: Exec = defaultExec, service = SECRET_SERVICE): SecretBackend {
  return {
    name: "macOS Keychain",
    get(account) {
      try {
        return exec("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]).replace(/\n$/, "");
      } catch (error) {
        // 44 = errSecItemNotFound: a missing item is an answer, anything else (locked keychain) is a failure.
        if ((error as { status?: number }).status === 44) return undefined;
        throw error;
      }
    },
    set(account, value) {
      if (/[\r\n]/.test(value)) throw new Error("multi-line secrets are not supported by the Keychain backend");
      const line = ["add-generic-password", "-U", "-s", securityQuote(service), "-a", securityQuote(account), "-l", securityQuote(`OpenMausBot ${account}`), "-w", securityQuote(value)].join(" ");
      exec("/usr/bin/security", ["-i"], `${line}\n`);
      // `security -i` exits 0 even when a command inside it fails, so read the item back to prove it landed.
      if (this.get(account) !== value) throw new Error(`Keychain did not keep ${account}`);
    },
  };
}

/** Linux Secret Service via `secret-tool` (libsecret). The value goes in on stdin. */
export function libsecretBackend(exec: Exec = defaultExec, service = SECRET_SERVICE): SecretBackend {
  return {
    name: "Secret Service (libsecret)",
    get(account) {
      try {
        const out = exec("secret-tool", ["lookup", "service", service, "account", account]);
        return out === "" ? undefined : out.replace(/\n$/, "");
      } catch (error) {
        if ((error as { status?: number }).status === 1) return undefined;
        throw error;
      }
    },
    set(account, value) {
      exec("secret-tool", ["store", `--label=OpenMausBot ${account}`, "service", service, "account", account], value);
    },
  };
}

/** The backend OMB_SECRET_STORE asks for, or undefined to keep the classic plaintext file. */
export function configuredSecretBackend(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretBackend | undefined {
  const wanted = env.OMB_SECRET_STORE?.trim().toLowerCase();
  if (!wanted || wanted === "file" || wanted === "off") return undefined;
  if (wanted !== "keychain" && wanted !== "os") return undefined;
  if (platform === "darwin") return macKeychainBackend();
  if (platform === "linux") return libsecretBackend();
  return undefined;
}

/** In-memory backend for tests and for a dry run. */
export function memoryBackend(seed: Record<string, string> = {}): SecretBackend & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(seed));
  return {
    name: "memory",
    entries,
    get: (account) => entries.get(account),
    set: (account, value) => void entries.set(account, value),
  };
}
