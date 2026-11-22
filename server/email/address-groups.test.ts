import { expect, it, vi } from "vitest";

import { openGuard, readMessage } from "./client.ts";
import type { EmailAccount } from "./store.ts";

const fake = vi.hoisted(() => ({ source: Buffer.alloc(0) as Buffer }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  on() {} async connect() {} async logout() {}
  async getMailboxLock() { return { release() {} }; }
  async fetchOne(_uid: string, query: { source?: boolean }) {
    return query.source ? { uid: 9, source: fake.source } : { uid: 9, size: fake.source.length };
  }
} }));

const account: EmailAccount = {
  address: "me@example.test", username: "me", password: "fixture-only", connectedAt: 0,
  imap: { host: "imap.example.test", port: 993, secure: true },
};

async function read(headers: string[]) {
  fake.source = Buffer.from(["From: Sender <sender@example.test>", "Subject: Meeting notes", ...headers, "", "Hello"].join("\r\n"));
  return readMessage(account, openGuard, { mailbox: "INBOX", uid: 9 });
}

it("reads the actual recipients in address groups, alongside ordinary addresses", async () => {
  const message = await read([
    "To: Team: Alice <alice@example.test>, Bob <bob@example.test>;, Carol <carol@example.test>",
    "Cc: Reviewers: Dora <dora@example.test>;, copied@example.test",
    "Reply-To: Support: Help <help@example.test>;",
  ]);
  expect(message.to).toEqual(["Alice <alice@example.test>", "Bob <bob@example.test>", "Carol <carol@example.test>"]);
  expect(message.cc).toEqual(["Dora <dora@example.test>", "copied@example.test"]);
  expect(message.replyTo).toEqual(["Help <help@example.test>"]);
  expect(message.from).toBe("Sender <sender@example.test>");
});

it("does not invent an address for an undisclosed or empty group", async () => {
  const message = await read([
    "To: undisclosed-recipients:;",
    "Cc: Reviewers:;, copied@example.test",
    "Reply-To: Support:;",
  ]);
  expect(message.to).toEqual([]);
  expect(message.cc).toEqual(["copied@example.test"]);
  expect(message.replyTo).toEqual([]);
});

it("keeps ordinary and absent address headers", async () => {
  const message = await read(["To: Alice <alice@example.test>, bob@example.test"]);
  expect(message.to).toEqual(["Alice <alice@example.test>", "bob@example.test"]);
  expect(message.cc).toEqual([]);
  expect(message.replyTo).toEqual([]);
});
