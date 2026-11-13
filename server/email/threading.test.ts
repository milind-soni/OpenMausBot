import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import "../server-line-packs.ts";
import { openGuard } from "./client.ts";
import { createEmailHost } from "./host.ts";
import { createEmailService } from "./service.ts";
import type { EmailToolResult } from "./tools.ts";

const fake = vi.hoisted(() => ({ source: Buffer.alloc(0) as Buffer, raw: Buffer.alloc(0) as Buffer, filed: Buffer.alloc(0) as Buffer }));
vi.mock("nodemailer", () => ({ createTransport: () => ({
  async sendMail({ raw, envelope }: { raw: Buffer; envelope: { to: string[] } }) { fake.raw = raw; return { accepted: envelope.to }; },
  close() {},
}) }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  on() {} async connect() {} async logout() {}
  async getMailboxLock() { return { release() {} }; }
  async fetchOne(_uid: string, query: { source?: boolean }) {
    return query.source ? { uid: 9, source: fake.source } : { uid: 9, size: fake.source.length };
  }
  async list() { return [{ path: "Sent", specialUse: "\\Sent" }]; }
  async append(_path: string, raw: Buffer) { fake.filed = Buffer.from(raw); }
} }));
const dirs: string[] = [];
beforeEach(() => { fake.source = fake.raw = fake.filed = Buffer.alloc(0); });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

it.each([
  { name: "multiple ancestors", headers: ["Message-ID: <parent@example.test>", "References: <root@example.test>\r\n <middle@example.test>"], references: ["<root@example.test>", "<middle@example.test>", "<parent@example.test>"], parent: "<parent@example.test>" },
  { name: "one ancestor", headers: ["Message-ID: <parent@example.test>", "References: <root@example.test>"], references: ["<root@example.test>", "<parent@example.test>"], parent: "<parent@example.test>" },
  { name: "a single In-Reply-To fallback", headers: ["Message-ID: <parent@example.test>", "In-Reply-To: <root@example.test>"], references: ["<root@example.test>", "<parent@example.test>"], parent: "<parent@example.test>" },
  { name: "multiple In-Reply-To IDs without inventing a chain", headers: ["Message-ID: <parent@example.test>", "In-Reply-To: <first@example.test> <second@example.test>"], references: ["<parent@example.test>"], parent: "<parent@example.test>" },
  { name: "ancestors without a parent Message-ID", headers: ["References: <root@example.test> <middle@example.test>"], references: ["<root@example.test>", "<middle@example.test>"], parent: undefined },
  { name: "an In-Reply-To fallback without a parent Message-ID", headers: ["In-Reply-To: <root@example.test>"], references: ["<root@example.test>"], parent: undefined },
  { name: "a first reply", headers: ["Message-ID: <parent@example.test>"], references: ["<parent@example.test>"], parent: "<parent@example.test>" },
  { name: "an original without any threading headers", headers: [], references: [], parent: undefined },
])("preserves $name through IMAP parsing, the host and outgoing MIME", async ({ headers, references, parent }) => {
  fake.source = Buffer.from(["From: sender@example.test", "To: me@shop.example", "Subject: Thread", ...headers, "", "Original"].join("\r\n"));
  const dataDir = mkdtempSync(join(tmpdir(), "omb-email-threading-")); dirs.push(dataDir);
  const service = createEmailService({ dataDir, publicOnly: false, guard: openGuard, discover: { fetchText: async () => null, mx: async () => [], srv: async () => [], cname: async () => [], reverse: async () => [] }, test: { mailbox: (async () => ({ messages: 1 })) as never, sending: (async () => {}) as never } });
  await service.connect({ address: "me@shop.example", password: "fake-password" });
  const host = createEmailHost({ service, dataDir, bot: () => ({ id: "b1", name: "Test" }), inRoom: () => false, appendMessage() {}, markOutside() {} });
  const result = await host.handle({ method: "tools/call", params: { name: "EMAIL_SEND_MESSAGE", arguments: { to: ["sender@example.test"], subject: "Re: Thread", text: "Reply", reply_to_uid: 9 } } }, { botId: "b1", threadId: "t1" }, () => {}) as EmailToolResult;
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  const parsed = await simpleParser(fake.raw);
  expect(parsed.inReplyTo).toBe(parent);
  expect(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).toEqual(references);
  expect(parsed.text?.trim()).toBe("Reply");
  expect(fake.filed).toEqual(fake.raw);
});
