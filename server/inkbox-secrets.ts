import { randomUUID } from "node:crypto";
import type { InkboxSecretStore } from "../shared/inkbox-setup.ts";
import {
  INKBOX_SECRET_REQUEST, INKBOX_SECRET_RESPONSE, INKBOX_STORAGE_ERROR,
  validInkboxRequestId, validInkboxSecretDocument,
} from "../electron/inkbox-credentials.mjs";

type ParentPort = {
  postMessage(message: object): void;
  on(event: "message", callback: (event: { data?: unknown }) => void): unknown;
};
type Pending = {
  operation: "read" | "write";
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown | null): void;
  reject(error: Error): void;
};

/** Electron supplies this port privately. Plain Node/dev and remote servers
 * cannot substitute an HTTP route, renderer IPC call, file or environment key. */
export function createInkboxSecretStore(parentPort?: ParentPort): InkboxSecretStore & { close(): void } {
  const pending = new Map<string, Pending>();
  let closed = false;
  const fail = () => new Error(INKBOX_STORAGE_ERROR);
  parentPort?.on("message", event => {
    if (closed || !event.data || typeof event.data !== "object") return;
    const data = event.data as Record<string, unknown>;
    if (data.type !== INKBOX_SECRET_RESPONSE || !validInkboxRequestId(data.requestId)) return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    const allowed = new Set(["type", "requestId", "ok", ...(data.ok === true ? ["value"] : ["error"])]);
    if (Object.keys(data).some(key => !allowed.has(key)) || data.ok !== true) { entry.reject(fail()); return; }
    if (entry.operation === "read") {
      if (data.value !== null && !validInkboxSecretDocument(data.value)) { entry.reject(fail()); return; }
      entry.resolve(data.value === null ? null : structuredClone(data.value));
    } else if (Object.hasOwn(data, "value")) entry.reject(fail());
    else entry.resolve(null);
  });

  function request(operation: "read" | "write", value?: unknown): Promise<unknown | null> {
    if (closed || !parentPort || pending.size >= 32 ||
      (operation === "write" && value !== null && !validInkboxSecretDocument(value))) return Promise.reject(fail());
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); reject(fail()); }, 5_000);
      timer.unref?.();
      pending.set(requestId, { operation, resolve, reject, timer });
      try {
        parentPort.postMessage({ type: INKBOX_SECRET_REQUEST, requestId, operation,
          ...(operation === "write" ? { value: structuredClone(value) } : {}) });
      } catch {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(fail());
      }
    });
  }

  return {
    available: Boolean(parentPort),
    read: () => request("read"),
    async write(value) { await request("write", value); },
    close() {
      closed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(fail()); }
      pending.clear();
    },
  };
}
