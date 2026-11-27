import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";

const RUNTIME_PREFIX = "omb-companion-origin-";
const SOCKET_NAME = "origin.sock";

/** Accept only the private endpoint shape allocated by Electron. A malformed
 * inherited environment value cannot turn this listener into another TCP
 * port or an attacker-chosen filesystem path. */
export function companionOriginSocket(
  value: string | undefined,
  platform = process.platform,
): string | null {
  if (!value) return null;
  if (platform === "win32") {
    return /^\\\\\.\\pipe\\openmausbot-companion-origin-[1-9][0-9]*-[0-9a-f-]{36}$/i.test(value)
      ? value
      : null;
  }
  if (
    !path.isAbsolute(value) ||
    path.basename(value) !== SOCKET_NAME ||
    !path.basename(path.dirname(value)).startsWith(RUNTIME_PREFIX) ||
    Buffer.byteLength(value) > 96
  ) {
    return null;
  }
  return value;
}

/** Bind the exact one-generation socket. Electron owns its private parent
 * directory and removes it only after this sidecar exits. */
export function listenCompanionOrigin(
  server: Server,
  socketPath: string,
  { platform = process.platform, fileSystem = fs } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      if (platform !== "win32") {
        try {
          fileSystem.chmodSync(socketPath, 0o600);
        } catch (error) {
          // A socket whose permissions could not be restricted must not stay
          // reachable, and startup must receive the failure rather than wait
          // forever on a promise whose listening callback threw.
          server.close();
          reject(error);
          return;
        }
      }
      server.on("error", (error: Error) => {
        console.warn(`companion: private origin error — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}
