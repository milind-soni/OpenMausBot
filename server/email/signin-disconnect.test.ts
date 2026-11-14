import { type AddressInfo } from "node:net";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { testCertificate, trustTestCertificate } from "../testing/fake-smtp.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import { testSending } from "./client.ts";

const HOST = "smtp.disconnected.example";
const certificate = testCertificate([HOST]);
const servers: Server[] = [];
const sockets = new Set<TLSSocket>();
let untrust = () => {};
beforeAll(() => { if (certificate) untrust = trustTestCertificate(certificate.cert); });
afterAll(() => untrust());
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe.skipIf(!certificate)("outgoing sign-in checks when the SMTP peer disconnects", () => {
  it.each(["greeting", "auth"] as const)("rejects a connection closed during %s", async (stage) => {
    let reached = false;
    const server = createServer(certificate!, (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      if (stage === "greeting") {
        reached = true;
        socket.end();
        return;
      }
      socket.write("220 fake.smtp.test ready\r\n");
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (line.startsWith("EHLO ")) socket.write("250-fake.smtp.test\r\n250 AUTH PLAIN\r\n");
          if (line.startsWith("AUTH ")) {
            reached = true;
            socket.end();
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await expect(testSending(
      { username: "test@example.test", password: "fake-password" },
      { host: HOST, port, secure: true },
      async () => ({ host: "127.0.0.1", servername: HOST }),
    )).rejects.toMatchObject({ fault: "no-answer", message: `${HOST} didn't answer on port ${port}.` });
    expect(reached).toBe(true);
  }, hostTimeout(10_000));
});
