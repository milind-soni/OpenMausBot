import fs from "node:fs";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { companionOriginSocket, listenCompanionOrigin } from "../src/origin.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("private managed origin", () => {
  it("accepts only the one-generation UDS or named-pipe shape", () => {
    expect(companionOriginSocket(undefined)).toBeNull();
    expect(companionOriginSocket("127.0.0.1:8810")).toBeNull();
    expect(companionOriginSocket("/tmp/origin.sock", "linux")).toBeNull();
    expect(
      companionOriginSocket("/tmp/omb-companion-origin-test/origin.sock", "linux"),
    ).toBe("/tmp/omb-companion-origin-test/origin.sock");
    expect(
      companionOriginSocket(
        "\\\\.\\pipe\\openmausbot-companion-origin-42-12345678-1234-1234-1234-123456789abc",
        "win32",
      ),
    ).toContain("openmausbot-companion-origin-42");
    expect(companionOriginSocket("\\\\.\\pipe\\foreign", "win32")).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "binds a private socket that serves the same HTTP handler",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-companion-origin-test-"));
      directories.push(directory);
      fs.chmodSync(directory, 0o700);
      const socketPath = path.join(directory, "origin.sock");
      const server = createServer((_incoming, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ app: "openmausbot" }));
      });
      await listenCompanionOrigin(server, socketPath);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

      const body = await new Promise<string>((resolve, reject) => {
        const outgoing = request({ socketPath, path: "/api/health" }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        outgoing.once("error", reject);
        outgoing.end();
      });
      expect(JSON.parse(body)).toEqual({ app: "openmausbot" });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects and closes the socket when its permissions cannot be restricted",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-companion-origin-test-"));
      directories.push(directory);
      fs.chmodSync(directory, 0o700);
      const socketPath = path.join(directory, "origin.sock");
      const server = createServer();
      const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
      const fileSystem = {
        ...fs,
        chmodSync() {
          throw new Error("permissions unavailable");
        },
      };

      await expect(
        listenCompanionOrigin(server, socketPath, { platform: "linux", fileSystem }),
      ).rejects.toThrow("permissions unavailable");
      await closed;
      expect(server.listening).toBe(false);
    },
  );
});
