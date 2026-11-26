import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startFakeSmtp, testCertificate, trustTestCertificate, type FakeSmtp } from "../testing/fake-smtp.ts";
import { createEmailHost } from "./host.ts";
import { createEmailService } from "./service.ts";
import type { EmailToolResult } from "./tools.ts";

const stored = vi.hoisted(() => ({ copies: 0 }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  on() {} async connect() {} async logout() {}
  async list() { return [{ path: "Sent", specialUse: "\\Sent" }]; }
  async append() { stored.copies++; }
} }));

const ADDRESS = "sender@example.test", HOST = "smtp.example.test", PASSWORD = "fixture-password";
const certificate = testCertificate([HOST]);
const servers: FakeSmtp[] = [], dirs: string[] = [];
let untrust = () => {};
beforeAll(() => { if (certificate) untrust = trustTestCertificate(certificate.cert); });
afterAll(() => untrust());
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe.skipIf(!certificate)("mail dispatch after a turn ends", () => {
  it.each([
    { wait: "reply", stop: true }, { wait: "smtp address", stop: true },
    { wait: "reply", stop: false }, { wait: "smtp address", stop: false },
  ])("waits on $wait with stop=$stop before contacting SMTP", async ({ wait, stop }) => {
    stored.copies = 0;
    const smtp = await startFakeSmtp({ certificate: certificate!, security: "tls", mechanisms: ["PLAIN"], users: { [ADDRESS]: PASSWORD } });
    servers.push(smtp);
    const dataDir = mkdtempSync(join(tmpdir(), "omb-email-turn-")); dirs.push(dataDir);
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const pause = async () => { reached(); await ready; };
    let active = true;
    const service = createEmailService({ dataDir, publicOnly: false, guard: async ({ host }) => {
      if (wait === "smtp address" && host === HOST) await pause();
      return { host: "127.0.0.1", servername: host };
    } });
    service.store.put({ address: ADDRESS, username: ADDRESS, password: PASSWORD, connectedAt: 1,
      imap: { host: "imap.example.test", port: 993, secure: true }, smtp: { host: HOST, port: smtp.port, secure: true } });
    const rows: unknown[] = [];
    const host = createEmailHost({ service, dataDir, bot: () => ({ id: "bot", name: "Bot" }), inRoom: () => false,
      appendMessage: (_thread, message) => rows.push(message), markOutside() {}, run: { readMessage: async () => {
        await pause();
        return { uid: 1, from: "recipient@example.test", to: [ADDRESS], subject: "Question", date: null, unread: true,
          cc: [], replyTo: [], messageId: "<original@example.test>", text: "Original", truncated: false, attachments: [] };
      } } });
    const pending = (host.handle({ method: "tools/call", params: { name: "EMAIL_SEND_MESSAGE", arguments: {
      to: ["recipient@example.test"], subject: "Reply", text: "The requested reply.", ...(wait === "reply" ? { reply_to_uid: 1 } : {}),
    } } }, { botId: "bot", threadId: "thread" }, () => {
      if (!active) throw Object.assign(new Error("The turn ended."), { status: 401 });
    }) as Promise<EmailToolResult>).catch((error: unknown) => error);
    try {
      await waiting;
      if (stop) active = false;
      release();
      const answer = await pending;
      if (stop) {
        expect(smtp.received).toEqual([]);
        expect(smtp.signIns).toEqual([]);
        expect(stored.copies).toBe(0);
        expect(rows).toEqual([]);
      } else {
        expect(answer).not.toBeInstanceOf(Error);
        expect((answer as EmailToolResult).isError).toBeUndefined();
        expect(smtp.received).toHaveLength(1);
        expect(smtp.received[0]).toMatchObject({ from: ADDRESS, to: ["recipient@example.test"] });
        expect(smtp.received[0]!.data).toContain("The requested reply.");
        if (wait === "reply") expect(smtp.received[0]!.data).toContain("In-Reply-To: <original@example.test>");
        expect(stored.copies).toBe(1);
        expect(rows).toHaveLength(1);
      }
    } finally { release(); await pending; }
  });
});
