import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A short-lived capability for a single Codex run. No OAuth credentials cross the command line. */
export async function startChatGptTokenBridge(accessToken: () => Promise<string>) {
  const secret = randomBytes(32).toString("hex");
  const directory = process.platform === "win32" ? undefined : mkdtempSync(join(tmpdir(), "omb-auth-"));
  const path = directory ? join(directory, "s") : `\\\\.\\pipe\\omb-auth-${randomBytes(16).toString("hex")}`;
  const connections = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let input = "";
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 128) return socket.destroy();
      if (!input.endsWith("\n")) return;
      socket.removeAllListeners("data");
      const actual = Buffer.from(input.trim());
      const expected = Buffer.from(secret);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return socket.destroy();
      void accessToken().then((token) => {
        if (!closed) socket.end(token);
      }, () => socket.destroy());
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    env: { OMB_CODEX_AUTH_SOCKET: path, OMB_CODEX_AUTH_SECRET: secret },
    close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      server.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}
