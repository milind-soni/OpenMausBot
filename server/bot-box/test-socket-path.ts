import { basename, join } from "node:path";
import { connect } from "node:net";

export function testSocketPath(directory: string, name: string): string {
  if (process.platform !== "win32") return join(directory, name);
  const safeName = name.replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "-");
  return `\\\\.\\pipe\\omb-${basename(directory)}-${safeName}`;
}

export function connectTestSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      socket.destroy();
      resolve();
    });
  });
}
