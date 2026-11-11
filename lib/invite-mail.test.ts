// @vitest-environment node
import { createServer } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { sendInviteMail } from "./invite-mail";

import { convexStore, signedBridge, type Backend } from "../testing/convex-store";

// Delivery claims live in Convex, so a retry on any instance sees the first one.
const backend = vi.hoisted(() => ({ current: null as Backend | null }));
vi.mock("./integration-bridge", async importOriginal => ({
  ...await importOriginal<typeof import("./integration-bridge")>(),
  integrationBridge: (operation: string, args: unknown) => signedBridge((backend.current ??= convexStore()), operation, args),
}));
afterEach(() => vi.unstubAllEnvs());

test("PG1 O-012: actual loopback SMTP delivery, explicit failure and same-request duplicate suppression", async () => {
  const messages: string[] = [];
  let reject = false;
  const server = createServer(socket => {
    socket.setEncoding("utf8"); socket.write("220 pg1.test SMTP\r\n");
    let buffer = "", data = false;
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) break;
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false;
          socket.write("250 delivered\r\n"); continue;
        }
        const at = buffer.indexOf("\r\n"), command = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        if (/^EHLO|^HELO/.test(command)) socket.write("250-pg1.test\r\n250 AUTH PLAIN\r\n");
        else if (command.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (command.startsWith("MAIL FROM") && reject) socket.write("550 fixture failure\r\n");
        else if (command === "DATA") { data = true; socket.write("354 send data\r\n"); }
        else if (command === "QUIT") { socket.end("221 bye\r\n"); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("SMTP fixture failed");
  for (const [key, value] of Object.entries({ ORIGIN_SMTP_HOST: "127.0.0.1", ORIGIN_SMTP_PORT: String(address.port), ORIGIN_SMTP_SECURE: "false", ORIGIN_SMTP_USER: "fixture", ORIGIN_SMTP_PASSWORD: "fixture", ORIGIN_SMTP_FROM: "Origin <origin@pg1.test>", ORIGIN_PUBLIC_URL: "http://127.0.0.1:3000" })) vi.stubEnv(key, value);
  try {
    const invite = { token: "fixture-token", teamName: "PG1 SMTP workspace" };
    for (let i = 0; i < 2; i++) expect(await sendInviteMail(invite, "invitee@pg1.test", "Owner", "pg1-delivery")).toEqual({ sent: true, inviteLink: "http://127.0.0.1:3000/join/fixture-token" });
    expect(messages).toHaveLength(1); expect(messages[0]).toContain("invitee@pg1.test"); expect(messages[0]).toContain("/join/fixture-token");
    reject = true;
    for (let i = 0; i < 2; i++) expect(await sendInviteMail(invite, "failure@pg1.test", "Owner", "pg1-failure")).toMatchObject({ sent: false, inviteLink: expect.stringContaining("fixture-token") });
    expect(messages).toHaveLength(1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
