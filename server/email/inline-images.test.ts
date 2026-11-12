import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import "../server-line-packs.ts";
import { createEmailService } from "./service.ts";
import { createEmailHost } from "./host.ts";
import type { EmailToolResult } from "./tools.ts";
import { beforeEach, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { inlineAttachments, openGuard, sendMessage } from "./client.ts";
import type { EmailAccount } from "./store.ts";
import { emailToolCallProblem } from "./tools.ts";

const fake = vi.hoisted(() => ({ raw: Buffer.alloc(0) as Buffer, filed: Buffer.alloc(0) as Buffer, envelope: {} as any, fail: false, smtpCalls: 0, imapCalls: 0 }));
vi.mock("nodemailer", () => ({ createTransport: () => { fake.smtpCalls++; return ({ sendMail: async ({ raw, envelope }: any) => { fake.raw = raw; fake.envelope = envelope; return { accepted: envelope.to }; }, close() {} }); } }));
vi.mock("imapflow", () => ({ ImapFlow: class { constructor() { fake.imapCalls++; } on() {} async connect() {} async logout() {} async list() { return [{ path: "Sent", specialUse: "\\Sent" }]; } async append(_path: string, raw: Buffer) { if (fake.fail) throw Error("offline"); fake.filed = Buffer.from(raw); } } }));
const png = largePng();
const image = { cid: "logo", data_base64: png.toString("base64") };
const account = { address: "me@example.test", username: "fake", password: "fake", smtp: { host: "fake.invalid", port: 465, secure: true }, imap: { host: "fake.invalid", port: 993, secure: true } } as EmailAccount;
const input = { to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["bcc@example.test"], subject: "test", text: "plain" };
beforeEach(() => { fake.fail = false; fake.smtpCalls = 0; fake.imapCalls = 0; });
it("composes alternatives, original PNG CID bytes, recipients and reply headers; files the identical raw", async () => {
  const result = await sendMessage(account, openGuard, { ...input, html: '<p>rich<img src="cid:logo"></p>', inline_images: [image], inReplyTo: "<original@example.test>" });
  const parsed = await simpleParser(fake.raw, { skipImageLinks: true });
  expect(fake.raw.toString()).toContain("multipart/alternative");
  expect(parsed.text?.trim()).toBe("plain");
  expect(parsed.html).toContain("cid:logo");
  expect(parsed.attachments[0]?.content).toEqual(png);
  expect(parsed.attachments[0]?.contentId).toBe("<logo>");
  expect(parsed.inReplyTo).toBe("<original@example.test>");
  expect(parsed.references).toBe("<original@example.test>");
  expect(fake.envelope.to).toEqual([...input.to, ...input.cc, ...input.bcc]);
  expect(fake.filed).toEqual(fake.raw);
  expect(result.filed).toBe(true);
});
it("keeps old text calls and reports failed filing", async () => {
  fake.fail = true;
  expect((await sendMessage(account, openGuard, input)).filed).toBe(false);
  expect((await simpleParser(fake.raw)).text?.trim()).toBe("plain");
});
it("rejects unknown inputs, URLs, paths, malformed PNG, duplicate CIDs and size/count excess before transport", () => {
  for (const extra of [{ path: "/tmp/logo.png" }, { url: "https://example.test/a" }, { raw: "mime" }, { inline_images: [{ ...image, path: "/tmp/a" }] }, { inline_images: [{ cid: "a", data_base64: "https://example.test" }] }, { inline_images: [{ cid: "a", data_base64: Buffer.from("no png").toString("base64") }] }, { inline_images: [image, image] }, { inline_images: Array(5).fill(image) }, { inline_images: [{ ...image, data_base64: "A".repeat(1_398_108) }] }]) {
    expect(emailToolCallProblem("EMAIL_SEND_MESSAGE", { ...input, ...extra })).not.toBeNull();
  }
  expect(emailToolCallProblem("EMAIL_SEND_MESSAGE", input)).toBeNull();
  expect(emailToolCallProblem("EMAIL_SEND_MESSAGE", { ...input, html: "rich", inline_images: [image] })).toBeNull();
  expect(() => inlineAttachments([{ ...image, data_base64: "file:///tmp/a" }])).toThrow();
});

async function withHost(run: (call: (args: Record<string, unknown>) => Promise<EmailToolResult>) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-inline-host-"));
  try {
    const service = createEmailService({ dataDir, publicOnly: false, guard: openGuard, discover: { fetchText: async () => null, mx: async () => [], srv: async () => [], cname: async () => [], reverse: async () => [] }, test: { mailbox: (async () => ({ messages: 1 })) as never, sending: (async () => {}) as never } });
    await service.connect({ address: "me@shop.example", password: "fake-password" });
    const host = createEmailHost({ service, dataDir, bot: () => ({ id: "b1", name: "Test" }), inRoom: () => false, appendMessage() {}, markOutside() {}, run: { readMessage: (async () => ({ messageId: "<original@example.test>" })) as never } });
    await run((args) => host.handle({ method: "tools/call", params: { name: "EMAIL_SEND_MESSAGE", arguments: args } }, { botId: "b1", threadId: "t1" }, () => {}) as Promise<EmailToolResult>);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

function largePng() {
  const chunk = (kind: string, data: Buffer) => {
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(512); ihdr.writeUInt32BE(400, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Array.from({ length: 400 }, () => Buffer.concat([Buffer.from([0]), randomBytes(512 * 4)]));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

it("rejects combined size, missing text, paths and URLs in host before any SMTP/IMAP construction", async () => {
  const big = largePng();
  expect(big.length).toBeGreaterThan(512 * 1024);
  expect(big.length).toBeLessThanOrEqual(1024 * 1024);
  const one = { cid: "one", data_base64: big.toString("base64") };
  expect(inlineAttachments([one])[0]?.content).toEqual(big);
  await withHost(async (call) => {
    const { text: _text, ...missingText } = input;
    for (const args of [{ ...input, inline_images: [one, { ...one, cid: "two" }] }, missingText, { ...input, inline_images: [{ ...image, path: "/tmp/logo.png" }] }, { ...input, inline_images: [{ ...image, url: "https://example.test/logo.png" }] }]) {
      expect((await call(args)).isError).toBe(true);
      expect(fake.smtpCalls).toBe(0);
      expect(fake.imapCalls).toBe(0);
    }
  });
});

it("preserves HTML and inline PNG bytes through the native host and client", async () => {
  const html = '<!doctype html><html><body><p>Synthetic message.</p><div style="font-family:sans-serif"><b>Example Sender</b><img src="cid:logo" width="99" height="28" alt="Example logo"></div></body></html>';
  await withHost(async (call) => {
    const result = await call({ ...input, html, inline_images: [image], reply_to_uid: 9 });
    expect(result.isError).toBeUndefined();
    const parsed = await simpleParser(fake.raw, { skipImageLinks: true });
    expect(parsed.html).toBe(html);
    expect(parsed.attachments[0]?.content).toEqual(png);
    expect(parsed.attachments[0]?.contentId).toBe("<logo>");
    expect(parsed.inReplyTo).toBe("<original@example.test>");
    expect(parsed.references).toBe("<original@example.test>");
    expect(parsed.to).toMatchObject({ value: [{ address: input.to[0] }] });
    expect(parsed.cc).toMatchObject({ value: [{ address: input.cc[0] }] });
    expect(fake.filed).toEqual(fake.raw);
    expect(fake.smtpCalls).toBe(1); expect(fake.imapCalls).toBe(1);
  });
});
