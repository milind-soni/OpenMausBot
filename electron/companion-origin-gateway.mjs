// The hosted connector never talks to the reusable LAN listener on :8810.
// A guardian process owns this loopback gateway instead and forwards to one
// per-launch Unix socket / Windows named pipe belonging to the exact sidecar
// Electron started. If either owner disappears, the route fails closed.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MANAGED_COMPANION_ORIGIN_HOST = "127.0.0.1";
export const MANAGED_COMPANION_ORIGIN_PORT = 8812;

const RUNTIME_PREFIX = "omb-companion-origin-";
const SOCKET_NAME = "origin.sock";

const currentUserId = () => {
  if (process.getuid) return process.getuid();
  const uid = os.userInfo().uid;
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : undefined;
};

export function validCompanionOriginTarget(target, platform = process.platform) {
  if (!Number.isSafeInteger(target?.pid) || target.pid <= 0) return false;
  if (Object.prototype.toString.call(target?.socketPath) !== "[object String]") return false;
  if (platform === "win32") {
    return /^\\\\\.\\pipe\\openmausbot-companion-origin-[1-9][0-9]*-[0-9a-f-]{36}$/i.test(
      target.socketPath,
    );
  }
  return (
    path.isAbsolute(target.socketPath) &&
    path.basename(target.socketPath) === SOCKET_NAME &&
    path.basename(path.dirname(target.socketPath)).startsWith(RUNTIME_PREFIX)
  );
}

/** Allocate a private, unguessable address for one sidecar launch. */
export function createCompanionOriginEndpoint({
  platform = process.platform,
  fileSystem = fs,
  processId = process.pid,
  identifier = randomUUID,
  temporaryRoot,
  currentUid = currentUserId(),
} = {}) {
  if (platform === "win32") {
    return Object.freeze({
      pid: processId,
      socketPath: `\\\\.\\pipe\\openmausbot-companion-origin-${processId}-${identifier()}`,
      directory: null,
    });
  }

  // Darwin's sockaddr_un path is short. /tmp resolves to /private/tmp there
  // and keeps this comfortably below the limit even when userData is long.
  const root = temporaryRoot ?? fileSystem.realpathSync("/tmp");
  const directory = fileSystem.mkdtempSync(path.join(root, RUNTIME_PREFIX));
  try {
    fileSystem.chmodSync(directory, 0o700);
    const stat = fileSystem.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (currentUid !== undefined && stat.uid !== currentUid)
    ) {
      throw new Error("The companion origin directory is unsafe");
    }
    const socketPath = path.join(directory, SOCKET_NAME);
    if (Buffer.byteLength(socketPath) > 96) {
      throw new Error("The companion origin socket path is too long");
    }
    return Object.freeze({ pid: processId, socketPath, directory });
  } catch (error) {
    try {
      fileSystem.rmdirSync(directory);
    } catch {}
    throw error;
  }
}

/** Clean only the exact socket/directory allocated above. */
export function cleanupCompanionOriginEndpoint(
  endpoint,
  { platform = process.platform, fileSystem = fs, currentUid = currentUserId() } = {},
) {
  if (platform === "win32" || !endpoint?.directory) return;
  const directory = endpoint.directory;
  if (
    path.basename(directory).startsWith(RUNTIME_PREFIX) === false ||
    path.dirname(endpoint.socketPath) !== directory ||
    path.basename(endpoint.socketPath) !== SOCKET_NAME
  ) {
    return;
  }
  try {
    const directoryStat = fileSystem.lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (currentUid !== undefined && directoryStat.uid !== currentUid)
    ) {
      return;
    }
    try {
      const socketStat = fileSystem.lstatSync(endpoint.socketPath);
      if (
        socketStat.isSocket() &&
        !socketStat.isSymbolicLink() &&
        (currentUid === undefined || socketStat.uid === currentUid)
      ) {
        fileSystem.unlinkSync(endpoint.socketPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
    fileSystem.rmdirSync(directory);
  } catch {
    // A live, foreign, or concurrently changed endpoint is left untouched.
  }
}

/** Verify that the exact private sidecar origin is answering with the
 * companion identity. Every terminal request/response event settles the
 * promise: this probe runs inside the serialized Companion lifecycle, so a
 * request left pending would wedge both start and stop for the app session. */
export function companionOriginHealth(
  target,
  { request = http.request, timeoutMs = 1_000 } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const outgoing = request(
      {
        headers: { accept: "application/json" },
        method: "GET",
        path: "/api/health",
        socketPath: target.socketPath,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4096) {
            finish(false);
            response.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return finish(false);
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.app === "openmausbot");
          } catch {
            finish(false);
          }
        });
        response.once("aborted", () => finish(false));
        response.once("error", () => finish(false));
        response.once("close", () => finish(false));
      },
    );
    outgoing.once("timeout", () => {
      finish(false);
      outgoing.destroy();
    });
    outgoing.once("error", () => finish(false));
    outgoing.once("close", () => finish(false));
    outgoing.end();
  });
}

function unavailable(response) {
  if (response.headersSent) return response.destroy();
  const body = JSON.stringify({ error: "companion origin unavailable" });
  response.writeHead(503, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEndHeaders(headers = {}) {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  const connection = Array.isArray(headers.connection)
    ? headers.connection.join(",")
    : String(headers.connection ?? "");
  for (const name of connection.split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())),
  );
}

function upgradeHeaders(headers = {}) {
  if (String(headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  return {
    ...endToEndHeaders(headers),
    connection: "Upgrade",
    upgrade: "websocket",
  };
}

function writeUpgrade(socket, response) {
  const lines = [];
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = response.headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`
      + `${lines.join("\r\n")}\r\n\r\n`,
  );
}

function destroySockets(sockets) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}

/** Loopback gateway owned by the connector guardian. The target is immutable
 * for one guardian lifetime, and is checked again for every request. */
export function createCompanionOriginGateway({
  target,
  originHost = MANAGED_COMPANION_ORIGIN_HOST,
  originPort = MANAGED_COMPANION_ORIGIN_PORT,
  isTargetAlive = () => true,
  createServer = http.createServer,
  request = http.request,
  upstreamTimeoutMs = 30_000,
} = {}) {
  if (!validCompanionOriginTarget(target)) {
    throw new Error("The companion origin target is invalid");
  }
  let accepting = true;
  let listening = false;
  let transition = Promise.resolve();
  const upgradedSockets = new Set();

  const server = createServer((incoming, outgoing) => {
    if (!accepting || !isTargetAlive(target)) return unavailable(outgoing);
    const upstream = request(
      {
        headers: endToEndHeaders(incoming.headers),
        method: incoming.method,
        path: incoming.url,
        socketPath: target.socketPath,
        timeout: upstreamTimeoutMs,
      },
      (response) => {
        upstream.setTimeout(0);
        if (!accepting || !isTargetAlive(target)) {
          response.destroy();
          return unavailable(outgoing);
        }
        outgoing.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
        // `pipe` does not carry source failures to the destination. A
        // sidecar restart in the middle of a response must tear down the
        // client response instead of leaving it waiting forever for bytes
        // (and possibly a content-length) that will never arrive.
        response.once("error", () => outgoing.destroy());
        response.once("aborted", () => outgoing.destroy());
        response.once("close", () => {
          if (!response.complete) outgoing.destroy();
        });
        response.pipe(outgoing);
      },
    );
    upstream.once("timeout", () => upstream.destroy(new Error("companion origin timed out")));
    upstream.once("error", () => unavailable(outgoing));
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    if (!accepting || !isTargetAlive(target)) return socket.destroy();
    const headers = upgradeHeaders(incoming.headers);
    if (!headers || incoming.method !== "GET") return socket.destroy();
    upgradedSockets.add(socket);
    let remoteSocket = null;
    const release = () => {
      upgradedSockets.delete(socket);
      if (remoteSocket) upgradedSockets.delete(remoteSocket);
    };
    socket.once("close", release);
    const upstream = request({
      headers,
      method: "GET",
      path: incoming.url,
      socketPath: target.socketPath,
      timeout: upstreamTimeoutMs,
    });
    upstream.once("timeout", () => upstream.destroy(new Error("companion origin upgrade timed out")));
    upstream.once("upgrade", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      remote.setTimeout(0);
      if (!accepting || !isTargetAlive(target)) {
        remote.destroy();
        socket.destroy();
        return;
      }
      writeUpgrade(socket, response);
      remoteSocket = remote;
      upgradedSockets.add(remote);
      remote.once("close", release);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
    });
    upstream.once("response", (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  return Object.freeze({
    start() {
      return serialize(async () => {
        if (listening) return server.address();
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ exclusive: true, host: originHost, port: originPort });
        });
        listening = true;
        return server.address();
      });
    },

    invalidate() {
      accepting = false;
      server.closeAllConnections?.();
      destroySockets(upgradedSockets);
    },

    close() {
      return serialize(async () => {
        accepting = false;
        server.closeAllConnections?.();
        destroySockets(upgradedSockets);
        if (!listening) return;
        await new Promise((resolve) => server.close(() => resolve()));
        listening = false;
      });
    },
  });
}
