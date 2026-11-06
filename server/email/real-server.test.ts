// The Email connector against a real mail server (Postfix and Dovecot in Docker): odd headers, UTF-8 subjects, a PDF, and a
// real send. Not in CI, which has no such server; run it with
//   _plans/christoph-2026-11-04/mail/start-test-mail-server.sh, then the two exports it prints, then vitest on this file.
// One made-up mailbox on a made-up domain.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listMailboxes, listMessages, readMessage, searchMessages, sendMessage, testSending, type EmailGuard } from "./client.ts";
import { createEmailService } from "./service.ts";

const ADDRESS = "tester@omb-test.example", EMPTY = "empty@omb-test.example", COPY = "copy@omb-test.example";
const PASSWORD = "fake pässword-with spaces 7";
const HOST = "mail.omb-test.example";
const IMAPS = 11993, IMAP = 11143, SMTPS = 11465, SUBMISSION = 11587;
/** The made-up name is the real server on loopback; its certificate is for that name. */
const guard: EmailGuard = async ({ host }) => ({ host: "127.0.0.1", servername: host });
const AUTOCONFIG = `<clientConfig><emailProvider id="x">
  <incomingServer type="imap"><hostname>${HOST}</hostname><port>${IMAPS}</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>${HOST}</hostname><port>${SUBMISSION}</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;
const discover = { fetchText: async (url: string) => (url.includes("autoconfig.omb-test.example") ? AUTOCONFIG : null), mx: async () => [], srv: async () => [], cname: async () => [], reverse: async () => [] };

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1"), randomBytes(2048), Buffer.from("\n%%EOF\n")]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"), "latin1");
const utf8 = (lines: string[]) => Buffer.from(lines.join("\r\n"), "utf8");

/** A subject as a mail program encodes it. */
const encoded = (text: string) => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
const MESSAGES: Record<string, Buffer> = {
  utf8Subject: crlf(["From: =?UTF-8?Q?M=C3=BCller=2C_Hans?= <hans@example.net>", "To: tester@omb-test.example", `Subject: ${encoded("Rechnung für März – Überweisung ✓")}`, "Date: Mon, 2 Nov 2026 10:00:00 +0100", "Message-ID: <utf8@example.net>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", Buffer.from("Grüße aus Österreich", "utf8").toString("latin1")]),
  rawUtf8: utf8(["From: raw@example.net", "To: tester@omb-test.example", "Subject: Rohes Betreff ohne Kodierung: Größe", "Date: Mon, 2 Nov 2026 10:01:00 +0100", "", "body"]),
  // The shape that broke a bot's own server: a subject that is a lone ")".
  parenSubject: crlf(["From: paren@example.net", "To: tester@omb-test.example", "Subject: )", "Date: Mon, 2 Nov 2026 10:02:00 +0100", "", "the subject is a lone parenthesis"]),
  folded: crlf(["From: folded@example.net", "To: tester@omb-test.example, \"Second, Person\" <second@example.net>,", "\tthird@example.net", "Subject: A subject", "  folded onto", "\ttwo more lines", "Date: Mon, 2 Nov 2026 10:03:00 +0100", "X-Odd: (((", "", "folded"]),
  unknownCharset: crlf(["From: odd@example.net", "To: tester@omb-test.example", "Subject: =?x-unknown-charset?Q?caf=E9?= and =?UTF-8?B?not base64!?=", "Date: not a date at all", "", "odd"]),
  noHeaders: crlf(["X-Only: this", "", "no from, no subject, no date"]),
  undisclosed: crlf(["From: <>", "To: undisclosed-recipients:;", "Subject: ", "Date: Mon, 2 Nov 2026 10:04:00 +0100", "", "empty from and group to"]),
  latin1: crlf(["From: latin@example.net", "To: tester@omb-test.example", "Subject: =?ISO-8859-1?Q?Gr=FC=DFe?=", "Date: Mon, 2 Nov 2026 10:05:00 +0100", "MIME-Version: 1.0", "Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable", "", "Gr=FC=DFe aus Wien"]),
  htmlOnly: crlf(["From: html@example.net", "To: tester@omb-test.example", "Subject: Only HTML", "Date: Mon, 2 Nov 2026 10:06:00 +0100", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", "<html><body><h1>Heading</h1><p>Some <b>bold</b> words.</p><script>alert(1)</script></body></html>"]),
  withPdf: crlf(["From: invoices@example.net", "To: tester@omb-test.example", `Subject: ${encoded("Rechnung März")}`, "Date: Mon, 2 Nov 2026 10:07:00 +0100", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "", "See the attached invoice.", "--b1", 'Content-Type: application/pdf; name="x.pdf"', "Content-Transfer-Encoding: base64", "Content-Disposition: attachment; filename*=UTF-8''..%2F..%2FRechnung%20M%C3%A4rz.pdf", "", ...(PDF.toString("base64").match(/.{1,76}/gu) ?? []), "--b1--", ""]),
};

describe.skipIf(!process.env.OMB_EMAIL_REAL_TEST)("Email against a real mail server", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-mail-real-"));
  const service = createEmailService({ dataDir: root, publicOnly: false, discover, guard });
  const uids: Record<string, number> = {};
  const admin = () => { const client = new ImapFlow({ host: "127.0.0.1", port: IMAPS, secure: true, servername: HOST, tls: { servername: HOST }, auth: { user: ADDRESS, pass: PASSWORD }, logger: false } as never); client.on("error", () => {}); return client; };

  beforeAll(async () => {
    const client = admin();
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      if ((client.mailbox as { exists: number }).exists) await client.messageDelete("1:*");
      for (const [name, raw] of Object.entries(MESSAGES)) {
        const added = await client.append("INBOX", raw, []);
        uids[name] = (added as { uid: number }).uid;
      }
    } finally { lock.release(); await client.logout(); }
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("connects from an address and a password, finding the servers, and proves it read a real header", async () => {
    const answer = await service.connect({ address: ADDRESS, password: PASSWORD });
    expect(answer).toMatchObject({ ok: true, account: { imapHost: HOST, smtpHost: HOST }, inbox: { messages: Object.keys(MESSAGES).length }, sending: { ok: true } });
    if (answer.ok) expect(answer.inbox.newest?.subject).toBe("Rechnung März");
  }, 60_000);

  it("a wrong password is refused by the real server, and nothing is saved", async () => {
    const other = createEmailService({ dataDir: mkdtempSync(join(root, "wrong-")), publicOnly: false, discover, guard });
    expect(await other.connect({ address: ADDRESS, password: "fake-wrong" })).toMatchObject({ ok: false, error: expect.stringContaining("did not accept") });
    expect(other.status().state).toBe("signed-out");
  }, 60_000);

  it("an empty mailbox connects and says it is empty", async () => {
    const other = createEmailService({ dataDir: mkdtempSync(join(root, "empty-")), publicOnly: false, discover, guard });
    expect(await other.connect({ address: EMPTY, password: PASSWORD })).toMatchObject({ ok: true, inbox: { messages: 0 } });
  }, 60_000);

  const account = () => service.store.get(ADDRESS)!;

  it("STARTTLS on the IMAP port works, and the implicit-TLS sending port too", async () => {
    const other = createEmailService({ dataDir: mkdtempSync(join(root, "starttls-")), publicOnly: false, discover, guard });
    expect(await other.connect({ address: ADDRESS, password: PASSWORD, imapHost: HOST, imapPort: IMAP, smtpHost: HOST, smtpPort: SMTPS })).toMatchObject({ ok: true, sending: { ok: true } });
    await testSending(account(), { host: HOST, port: SMTPS, secure: true }, guard);
  }, 60_000);

  it("lists every odd message with what its headers really say", async () => {
    const { total, messages } = await listMessages(account(), guard, { mailbox: "INBOX", limit: 50 });
    expect(total).toBe(Object.keys(MESSAGES).length);
    const by = (name: string) => messages.find((message) => message.uid === uids[name])!;
    expect(by("utf8Subject").subject).toBe("Rechnung für März – Überweisung ✓");
    expect(by("utf8Subject").from).toContain("Müller, Hans");
    expect(by("rawUtf8").subject).toContain("Größe");
    expect(by("parenSubject").subject, "a lone parenthesis is the subject, not the end of a reply").toBe(")");
    expect(by("folded").subject).toMatch(/^A subject\s+folded onto\s+two more lines$/u);
    expect(by("folded").to).toHaveLength(3);
    expect(by("latin1").subject).toBe("Grüße");
    expect(by("noHeaders")).toMatchObject({ from: "", subject: "" });
    expect(typeof by("unknownCharset").subject).toBe("string");
    expect(by("unknownCharset").date, "a date that isn't one falls back to when it arrived").not.toBeUndefined();
    for (const message of messages) expect(message.subject === ")" && message.uid !== uids.parenSubject, `uid ${message.uid}`).toBe(false);
    expect(messages.map((message) => message.uid), "newest first").toEqual(messages.map((message) => message.uid).sort((a, b) => b - a));
  }, 60_000);

  it("reads text in any charset, and HTML as words without its script", async () => {
    expect((await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.utf8Subject! })).text).toBe("Grüße aus Österreich");
    expect((await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.latin1! })).text).toBe("Grüße aus Wien");
    const html = await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.htmlOnly! });
    expect(html.text).toContain("Some bold words");
    expect(html.text).not.toContain("<script>");
    expect((await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.noHeaders! })).text).toContain("no from, no subject");
  }, 60_000);

  it("reading leaves a message unread", async () => {
    await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.latin1! });
    const { messages } = await listMessages(account(), guard, { mailbox: "INBOX", limit: 50 });
    expect(messages.find((message) => message.uid === uids.latin1)?.unread).toBe(true);
  }, 60_000);

  it("a PDF comes through whole, and its name can't climb out of the folder", async () => {
    const folder = join(root, "uploads");
    const message = await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.withPdf!, saveTo: folder });
    expect(message.text).toContain("See the attached invoice");
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments[0]!;
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.size).toBe(PDF.length);
    expect(attachment.savedTo!.startsWith(`${folder}/`)).toBe(true);
    expect(attachment.savedTo).toMatch(/Rechnung März\.pdf$/u);
    expect(sha(readFileSync(attachment.savedTo!))).toBe(sha(PDF));
    const unsaved = await readMessage(account(), guard, { mailbox: "INBOX", uid: uids.withPdf! });
    expect(unsaved.attachments[0]!.savedTo, "named, not saved, unless asked").toBeUndefined();
  }, 60_000);

  it("searches by a word with umlauts, by sender and by date", async () => {
    expect((await searchMessages(account(), guard, { mailbox: "INBOX", limit: 50, subject: "März" })).messages.map((one) => one.uid).sort()).toEqual([uids.utf8Subject, uids.withPdf].sort());
    expect((await searchMessages(account(), guard, { mailbox: "INBOX", limit: 50, from: "paren@example.net" })).messages.map((one) => one.uid)).toEqual([uids.parenSubject]);
    expect((await searchMessages(account(), guard, { mailbox: "INBOX", limit: 50, since: "2030-01-01" })).messages).toEqual([]);
    expect((await searchMessages(account(), guard, { mailbox: "INBOX", limit: 50, text: "parenthesis", unread: true })).found).toBe(1);
  }, 60_000);

  it("sends for real: it arrives with its UTF-8 intact, threaded, and a copy is in Sent", async () => {
    const marker = `Größe ✓ ${randomBytes(4).toString("hex")}`;
    const sent = await sendMessage(account(), guard, { to: [ADDRESS], subject: `Test ${marker}`, text: `Body ${marker}`, inReplyTo: "<utf8@example.net>" });
    expect(sent.accepted).toEqual([ADDRESS]);
    expect(sent.rejected).toEqual([]);
    expect(sent.filed).toBe(true);
    let arrived: Awaited<ReturnType<typeof searchMessages>> = { found: 0, messages: [] };
    for (let tries = 0; tries < 30 && !arrived.messages.length; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      arrived = await searchMessages(account(), guard, { mailbox: "INBOX", limit: 5, subject: marker });
    }
    expect(arrived.messages).toHaveLength(1);
    const read = await readMessage(account(), guard, { mailbox: "INBOX", uid: arrived.messages[0]!.uid });
    expect(read.subject).toBe(`Test ${marker}`);
    expect(read.text).toBe(`Body ${marker}`);
    expect(read.inReplyTo).toBe("<utf8@example.net>");
    const sentBox = (await listMailboxes(account(), guard)).find((box) => box.role === "sent")!;
    expect((await searchMessages(account(), guard, { mailbox: sentBox.path, limit: 5, subject: marker })).messages).toHaveLength(1);
  }, 90_000);

  it("a bcc goes but isn't in the headers", async () => {
    const marker = randomBytes(4).toString("hex");
    const sent = await sendMessage(account(), guard, { to: [ADDRESS], bcc: [COPY], subject: `Bcc ${marker}`, text: "x" });
    expect(sent.accepted.sort()).toEqual([ADDRESS, COPY].sort());
    let arrived: Awaited<ReturnType<typeof searchMessages>> = { found: 0, messages: [] };
    for (let tries = 0; tries < 30 && !arrived.messages.length; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      arrived = await searchMessages(account(), guard, { mailbox: "INBOX", limit: 5, subject: `Bcc ${marker}` });
    }
    const client = admin();
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const raw = await client.fetchOne(String(arrived.messages[0]!.uid), { source: true }, { uid: true });
      expect(raw && raw.source!.toString("utf8")).not.toContain(COPY);
    } finally { lock.release(); await client.logout(); }
  }, 90_000);
});
