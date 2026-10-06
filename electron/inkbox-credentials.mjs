import { createHash } from "node:crypto";
import path from "node:path";

export const INKBOX_SECRET_REQUEST = "openmausbot:inkbox-secret:request";
export const INKBOX_SECRET_RESPONSE = "openmausbot:inkbox-secret:response";
export const INKBOX_STORAGE_ERROR = "Secure Inkbox storage is unavailable.";
const MAX_BYTES = 65_536;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const plain = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** This is an opaque private document, never a renderer snapshot. The setup
 * coordinator owns its domain schema; both ends of the bridge enforce JSON
 * safety, size and version before it can enter the encrypted credential file. */
export function validInkboxSecretDocument(value) {
  try {
    if (!plain(value) || Object.getOwnPropertyDescriptor(value, "version")?.value !== 1) return false;
    let bytes = 0, nodes = 0;
    const seen = new WeakSet();
    function valid(node, depth) {
      if (++nodes > 8192 || depth > 16) return false;
      if (node === null || typeof node === "boolean") return true;
      if (typeof node === "number") return Number.isFinite(node);
      if (typeof node === "string") {
        bytes += Buffer.byteLength(node, "utf8");
        return bytes <= MAX_BYTES;
      }
      if (typeof node !== "object" || seen.has(node)) return false;
      const array = Array.isArray(node);
      if (!array && !plain(node)) return false;
      seen.add(node);
      const keys = Reflect.ownKeys(node).filter(key => !(array && key === "length"));
      if (keys.length > 8192 || (array && (keys.length !== node.length || node.length > 8192))) return false;
      for (const key of keys) {
        if (typeof key !== "string" || forbiddenKeys.has(key) || (array && !/^(0|[1-9][0-9]*)$/.test(key))) return false;
        bytes += Buffer.byteLength(key, "utf8");
        const descriptor = Object.getOwnPropertyDescriptor(node, key);
        if (bytes > MAX_BYTES || !descriptor.enumerable || !("value" in descriptor) || !valid(descriptor.value, depth + 1)) return false;
      }
      seen.delete(node);
      return true;
    }
    return valid(value, 0) && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES;
  } catch { return false; }
}

export function validInkboxRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validRequest(value) {
  try {
    if (!plain(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(["type", "requestId", "operation", "value"]);
    if (Reflect.ownKeys(descriptors).some(key => !allowed.has(key) || !("value" in descriptors[key]))) return false;
    if (value.type !== INKBOX_SECRET_REQUEST || !validInkboxRequestId(value.requestId)) return false;
    if (value.operation === "read") return !Object.hasOwn(value, "value");
    return value.operation === "write" && Object.hasOwn(value, "value") &&
      (value.value === null || validInkboxSecretDocument(value.value));
  } catch { return false; }
}

/** Only the main process's owned utility child may call receive. No renderer
 * IPC is registered. All mutations share the application's credential queue. */
export function createInkboxCredentialBridge({ workspacePath, credentials, isAvailable, isCurrent }) {
  const key = `inkboxWorkspace:${createHash("sha256").update(path.resolve(workspacePath)).digest("hex")}`;
  const processes = new WeakMap();
  return {
    receive(proc, message) {
      if (!isCurrent(proc) || !validRequest(message)) return false;
      let requests = processes.get(proc);
      if (!requests) { requests = { active: new Set(), completed: new Set() }; processes.set(proc, requests); }
      if (requests.active.size >= 32 || requests.active.has(message.requestId) || requests.completed.has(message.requestId)) return false;
      requests.active.add(message.requestId);
      // Copy now: callers cannot change a queued write after validation.
      const value = message.operation === "write" ? structuredClone(message.value) : null;
      void (async () => {
        let response;
        try {
          if (!(await isAvailable()) || !isCurrent(proc)) throw new Error(INKBOX_STORAGE_ERROR);
          if (message.operation === "write") {
            await credentials.update(current => {
              if (!isCurrent(proc)) throw new Error(INKBOX_STORAGE_ERROR);
              if (value === null) delete current[key];
              else current[key] = value;
              return current;
            });
            response = { ok: true };
          } else {
            const current = credentials.read();
            const saved = Object.hasOwn(current, key) ? current[key] : null;
            if (saved !== null && !validInkboxSecretDocument(saved)) throw new Error(INKBOX_STORAGE_ERROR);
            response = { ok: true, value: saved === null ? null : structuredClone(saved) };
          }
        } catch { response = { ok: false, error: INKBOX_STORAGE_ERROR }; }
        finally {
          requests.active.delete(message.requestId);
          requests.completed.add(message.requestId);
          if (requests.completed.size > 256) requests.completed.delete(requests.completed.values().next().value);
        }
        if (isCurrent(proc)) {
          try { proc.postMessage({ type: INKBOX_SECRET_RESPONSE, requestId: message.requestId, ...response }); }
          catch { /* The child exited. Never log a credential-bearing response. */ }
        }
      })();
      return true;
    },
  };
}
