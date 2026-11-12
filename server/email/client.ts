// The mail itself: IMAP through ImapFlow, parsing through mailparser, sending through Nodemailer, all in the server
// process. The password never crosses into a bot's box: a bot asks for a message and gets its text. One connection per
// call, closed after it, so nothing stays signed in between turns.
// Security: only over TLS with a certificate valid for the host, so a wrong guess at a host never gets the password; on
// a Cloud home only to public addresses, and to the address the check saw, the same rule as the box's way out.
import { constants, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { isIP } from "node:net";

import type { EmailAccount, EmailServer } from "./store.ts";

export class EmailError extends Error {
  /** `password`: the server refused the sign-in. `network`: no answer, or no valid TLS. `server`: it answered no.
   * `sending`: the outgoing server, which says why in a SendingError. */
  readonly code: "password" | "network" | "server" | "refused" | "not-found" | "too-big" | "sending";
  constructor(code: EmailError["code"], message: string) {
    super(message);
    this.name = "EmailError";
    this.code = code;
  }
}

/** The real address to connect to, or a refusal; off a Cloud home the name as it is. */
export type EmailGuard = (server: { host: string; port: number }) => Promise<{ host: string; servername?: string }>;
export const openGuard: EmailGuard = async ({ host }) => ({ host });

const CONNECT_MS = 10_000;
const COMMAND_MS = 45_000;
const TLS = { minVersion: "TLSv1.2" as const };
/** Past this a message is not read: its size says so instead. */
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
export const MAX_TEXT_CHARS = 40_000;
export const LIST_MAX = 50;

type Address = { name?: string; address?: string };
const named = (address: Address | undefined) => (address ? (address.name ? `${address.name} <${address.address ?? ""}>` : address.address ?? "") : "");
const names = (list: Address[] | undefined) => (list ?? []).map(named).filter(Boolean);
const isoDate = (value: unknown) => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

function failure(error: unknown): EmailError {
  if (error instanceof EmailError) return error;
  const known = error as { authenticationFailed?: boolean; mailboxMissing?: boolean; tlsFailed?: boolean; code?: string; message?: string; responseCode?: number };
  if (known?.authenticationFailed || known?.code === "EAUTH") return new EmailError("password", "The mail server did not accept this address and password.");
  if (known?.mailboxMissing) return new EmailError("not-found", "That mailbox doesn't exist. EMAIL_LIST_MAILBOXES names the ones there are.");
  if (known?.tlsFailed) return new EmailError("network", "The mail server did not answer over a secure connection.");
  const code = String(known?.code ?? "");
  if (/^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ESOCKET|ETLS|EDNS|ECONNECTION|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO|ERR_TLS|ERR_SSL)/u.test(code) || /timeout|certificate|TLS|socket|closed/iu.test(known?.message ?? "")) {
    return new EmailError("network", "The mail server did not answer over a secure connection.");
  }
  // A server's own words are outside text: kept out of what a person or bot reads, apart from their shape.
  return new EmailError("server", `The mail server said no${known?.responseCode ? ` (${known.responseCode})` : ""}.`);
}

async function imapSession<T>(account: Pick<EmailAccount, "username" | "password" | "imap">, guard: EmailGuard, run: (client: import("imapflow").ImapFlow) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import("imapflow");
  const at = await guard(account.imap);
  const client = new ImapFlow({
    host: at.host, port: account.imap.port, secure: account.imap.secure,
    ...(at.servername ? { servername: at.servername } : {}),
    // Never in the clear: without TLS the client stops before it sends anything.
    ...(account.imap.secure ? {} : { doSTARTTLS: true }),
    auth: { user: account.username, pass: account.password },
    tls: { ...TLS, ...(at.servername ? { servername: at.servername } : {}) },
    logger: false, disableAutoIdle: true, connectionTimeout: CONNECT_MS, greetingTimeout: CONNECT_MS, socketTimeout: COMMAND_MS,
  } as ConstructorParameters<typeof ImapFlow>[0]);
  // A dropped connection reports here too; the call's own promise carries the failure.
  client.on("error", () => {});
  try {
    await client.connect();
    return await run(client);
  } catch (error) {
    throw failure(error);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** A header is a field name and a colon. What a broken reader gets back, such as a lone ")", is not one. */
export const readsAsHeaders = (raw: string): boolean => /^[!-9;-~]+:/mu.test(raw);

export interface MessageSummary { uid: number; from: string; to: string[]; subject: string; date: string | null; unread: boolean; size?: number }

function summary(message: { uid: number; envelope?: { from?: Address[]; to?: Address[]; subject?: string; date?: unknown }; flags?: Set<string>; size?: number; internalDate?: unknown }): MessageSummary {
  return {
    uid: message.uid,
    from: names(message.envelope?.from)[0] ?? "",
    to: names(message.envelope?.to),
    subject: message.envelope?.subject ?? "",
    date: isoDate(message.envelope?.date) ?? isoDate(message.internalDate),
    unread: !message.flags?.has("\\Seen"),
    ...(message.size ? { size: message.size } : {}),
  };
}

const QUERY = { uid: true, envelope: true, flags: true, size: true, internalDate: true } as const;

/** What a connection test proves: this mailbox opens, and a real header of its newest message reads back as one. */
export async function testMailbox(account: Pick<EmailAccount, "username" | "password" | "imap">, guard: EmailGuard): Promise<{ messages: number; newest?: { from: string; subject: string } }> {
  return imapSession(account, guard, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const open = client.mailbox;
      const messages = open ? open.exists : 0;
      if (!messages) return { messages: 0 };
      const newest = await client.fetchOne("*", { uid: true, envelope: true, headers: true });
      const raw = newest && newest.headers ? newest.headers.toString("utf8") : "";
      if (!newest || !readsAsHeaders(raw)) throw new EmailError("server", "The mailbox opened, but its messages' headers could not be read.");
      return { messages, newest: { from: names(newest.envelope?.from)[0] ?? "", subject: newest.envelope?.subject ?? "" } };
    } finally { lock.release(); }
  });
}

/** Why an outgoing server can't send: `missing` no such name; `no-answer` nothing answered on that port; `wrong-security`
 * it speaks TLS the other way on that port (from the first byte, or upgraded with STARTTLS); `certificate` its
 * certificate isn't valid for the name; `no-tls` no secure connection on offer; `no-sign-in` no sign-in on offer;
 * `password` it refused the sign-in; `refused` not a place this host may reach; `rejected` it refused a message's
 * sender or recipients; `server` any other no. */
export type SendingFault = "missing" | "no-answer" | "wrong-security" | "certificate" | "no-tls" | "no-sign-in" | "password" | "refused" | "rejected" | "server";

/** Faults that stay until the person changes something; the others may pass on their own. */
export const LASTING_SENDING_FAULTS: ReadonlySet<SendingFault> = new Set(["missing", "wrong-security", "certificate", "no-tls", "no-sign-in", "password", "refused"]);

const where = (server: EmailServer) => `${server.host}:${server.port}`;

/** One plain sentence that names the server. */
export function sendingSentence(fault: SendingFault, server: EmailServer, responseCode?: number): string {
  switch (fault) {
    case "missing": return `There is no mail server called ${server.host}.`;
    case "no-answer": return `${server.host} didn't answer on port ${server.port}.`;
    case "wrong-security": return server.secure
      ? `${where(server)} starts without TLS and upgrades with STARTTLS; choose STARTTLS for it, not SSL/TLS.`
      : `${where(server)} expects SSL/TLS from the first byte; choose SSL/TLS for it, not STARTTLS.`;
    case "certificate": return `The certificate of ${server.host} isn't valid for that name, so the password wasn't sent there.`;
    case "no-tls": return `${where(server)} doesn't offer a secure connection, so the password wasn't sent there.`;
    case "no-sign-in": return `${where(server)} doesn't offer a sign-in for sending.`;
    case "password": return `The outgoing server ${where(server)} refused the password.`;
    case "refused": return "My Cloud can only reach mail servers on the public internet.";
    case "rejected": return `The outgoing server ${where(server)} refused this message's sender or recipients${responseCode ? ` (${responseCode})` : ""}.`;
    case "server": return `The outgoing server ${where(server)} said no${responseCode ? ` (${responseCode})` : ""}.`;
  }
}

/** An outgoing server's no, with the server it came from. Its message is ours, never the server's words. */
export class SendingError extends EmailError {
  readonly fault: SendingFault;
  readonly server: EmailServer;
  constructor(fault: SendingFault, server: EmailServer, responseCode?: number) {
    super("sending", sendingSentence(fault, server, responseCode));
    this.name = "SendingError";
    this.fault = fault;
    this.server = server;
  }
}

/** What a Nodemailer failure means, from its codes: the server's own text is never kept. */
export function sendingError(error: unknown, server: EmailServer): SendingError {
  if (error instanceof SendingError) return error;
  if (error instanceof EmailError) return new SendingError(error.code === "refused" ? "refused" : "missing", server);
  const known = (error ?? {}) as { code?: string; originalCode?: string; responseCode?: number; message?: string };
  const code = `${known.code ?? ""} ${known.originalCode ?? ""}`;
  const message = known.message ?? "";
  const answered = typeof known.responseCode === "number" ? known.responseCode : undefined;
  if (/ENOTFOUND|EAI_AGAIN|EDNS|ENODATA/u.test(code)) return new SendingError("missing", server);
  if (/CERT|ALTNAME|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO/u.test(code) || /certificate|altnames/iu.test(message)) return new SendingError("certificate", server);
  // Nodemailer's words for the two mix-ups: STARTTLS on a port that starts in TLS waits for a greeting that never comes,
  // and TLS on a port that starts in the clear reads its plain greeting as a broken TLS record.
  if (!server.secure && /greeting never received/iu.test(message)) return new SendingError("wrong-security", server);
  if (server.secure && (/WRONG_VERSION_NUMBER|PACKET_LENGTH_TOO_LONG|RECORD_LAYER/u.test(code) || /wrong version number|packet length too long|record layer failure/iu.test(message))) return new SendingError("wrong-security", server);
  if (known.code === "EAUTH") {
    if (answered && answered >= 500 && answered <= 504) return new SendingError("no-sign-in", server);
    return answered && answered >= 530 ? new SendingError("password", server) : new SendingError("server", server, answered);
  }
  if (known.code === "ETLS") return new SendingError("no-tls", server);
  if (known.code === "EENVELOPE" || known.code === "EMESSAGE") return new SendingError("rejected", server, answered);
  if (answered) return new SendingError("server", server, answered);
  return new SendingError("no-answer", server);
}

function smtpOptions(server: EmailServer, at: { host: string; servername?: string }) {
  return {
    host: at.host, port: server.port, secure: server.secure,
    // Never in the clear: on a port that upgrades, no STARTTLS means nothing more is sent.
    requireTLS: !server.secure,
    tls: { ...TLS, ...(at.servername ? { servername: at.servername } : {}) },
    connectionTimeout: CONNECT_MS, greetingTimeout: CONNECT_MS, socketTimeout: COMMAND_MS,
  };
}

/** Whether this outgoing server answers over TLS with a valid certificate and offers a sign-in, and, given a login, takes
 * it. Nothing is sent, and without a login no password either. */
export async function testSending(login: { username: string; password: string } | null, server: EmailServer, guard: EmailGuard): Promise<void> {
  const { default: SMTPConnection } = await import("nodemailer/lib/smtp-connection");
  let at: { host: string; servername?: string };
  try { at = await guard(server); } catch (error) { throw sendingError(error, server); }
  const connection = new SMTPConnection(smtpOptions(server, at));
  // A failure after the answer below reports here too; the awaited step carries it.
  connection.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => { connection.once("error", reject); connection.connect(() => { connection.removeListener("error", reject); resolve(); }); });
    if (!connection.secure) throw new SendingError("no-tls", server);
    if (!connection.allowsAuth) throw new SendingError("no-sign-in", server);
    if (login) await new Promise<void>((resolve, reject) => connection.login({ user: login.username, pass: login.password }, (error) => (error ? reject(error) : resolve())));
  } catch (error) {
    throw sendingError(error, server);
  } finally { connection.close(); }
}

/** The sign-in an account sends with: the outgoing server's own, else the incoming one's. */
export const sendingLogin = (account: Pick<EmailAccount, "username" | "password" | "smtpUsername" | "smtpPassword">) =>
  ({ username: account.smtpUsername ?? account.username, password: account.smtpPassword ?? account.password });

async function smtpTransport(account: Pick<EmailAccount, "username" | "password" | "smtpUsername" | "smtpPassword">, server: EmailServer, guard: EmailGuard) {
  const { createTransport } = await import("nodemailer");
  const at = await guard(server);
  const login = sendingLogin(account);
  return createTransport({ ...smtpOptions(server, at), auth: { user: login.username, pass: login.password } });
}

export async function listMailboxes(account: EmailAccount, guard: EmailGuard): Promise<Array<{ path: string; role?: string }>> {
  return imapSession(account, guard, async (client) => (await client.list()).map((box) => ({ path: box.path, ...(box.specialUse ? { role: box.specialUse.replace(/^\\/u, "").toLowerCase() } : {}) })));
}

export async function listMessages(account: EmailAccount, guard: EmailGuard, input: { mailbox: string; limit: number; beforeUid?: number }): Promise<{ total: number; messages: MessageSummary[] }> {
  return imapSession(account, guard, async (client) => {
    const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
    try {
      const total = client.mailbox ? client.mailbox.exists : 0;
      if (!total) return { total: 0, messages: [] };
      const out: MessageSummary[] = [];
      if (input.beforeUid) {
        const uids = (await client.search({ uid: `1:${input.beforeUid - 1}` }, { uid: true })) || [];
        for await (const message of client.fetch(uids.slice(-input.limit), QUERY, { uid: true })) out.push(summary(message));
      } else {
        for await (const message of client.fetch(`${Math.max(1, total - input.limit + 1)}:*`, QUERY)) out.push(summary(message));
      }
      return { total, messages: out.sort((a, b) => b.uid - a.uid) };
    } finally { lock.release(); }
  });
}

export interface SearchInput { mailbox: string; limit: number; text?: string; from?: string; to?: string; subject?: string; since?: string; before?: string; unread?: boolean }

export async function searchMessages(account: EmailAccount, guard: EmailGuard, input: SearchInput): Promise<{ found: number; messages: MessageSummary[] }> {
  return imapSession(account, guard, async (client) => {
    const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
    try {
      const uids = (await client.search({
        ...(input.text ? { text: input.text } : {}), ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}), ...(input.subject ? { subject: input.subject } : {}),
        ...(input.since ? { since: input.since } : {}), ...(input.before ? { before: input.before } : {}), ...(input.unread ? { seen: false } : {}),
      }, { uid: true })) || [];
      const out: MessageSummary[] = [];
      if (uids.length) for await (const message of client.fetch(uids.slice(-input.limit), QUERY, { uid: true })) out.push(summary(message));
      return { found: uids.length, messages: out.sort((a, b) => b.uid - a.uid) };
    } finally { lock.release(); }
  });
}

export interface InboxEntry { uid: number; at: number; from: string; subject: string }

/** When the server received a message, which a sender can't write. A message naming anything but one sender has from "". */
export function inboxEntry(message: { uid: number; internalDate?: unknown; envelope?: { from?: Address[]; subject?: string } }): InboxEntry {
  const received = message.internalDate instanceof Date ? message.internalDate.getTime() : Number.NaN;
  const senders = message.envelope?.from ?? [];
  return { uid: message.uid, at: Number.isFinite(received) ? received : 0, from: senders.length === 1 ? senders[0]!.address ?? "" : "", subject: message.envelope?.subject ?? "" };
}

const DAY_MS = 86_400_000;

/** The newest inbox messages received around `sinceMs` or later; the caller keeps the exact window. Never marks one read. */
export async function recentInbox(account: EmailAccount, guard: EmailGuard, input: { sinceMs: number; limit: number }): Promise<InboxEntry[]> {
  return imapSession(account, guard, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      // IMAP SINCE compares whole dates in the server's own time zone (RFC 9051), so a day's margin keeps a message from being missed.
      const uids = (await client.search({ since: new Date(input.sinceMs - DAY_MS) }, { uid: true })) || [];
      const out: InboxEntry[] = [];
      if (uids.length) for await (const message of client.fetch(uids.slice(-input.limit), QUERY, { uid: true })) out.push(inboxEntry(message));
      return out.sort((a, b) => b.at - a.at);
    } finally { lock.release(); }
  });
}

export interface ReadMessage extends MessageSummary {
  cc: string[];
  replyTo: string[];
  messageId?: string;
  inReplyTo?: string;
  text: string;
  truncated: boolean;
  attachments: Array<{ filename: string; contentType: string; size: number; savedTo?: string }>;
}

/** A file name that stays inside the folder, from a name a stranger wrote. */
export function safeAttachmentName(raw: string | undefined, index: number): string {
  const name = basename((raw ?? "").replaceAll("\\", "/")).replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[.\s]+/u, "").slice(-120).trim();
  return name || `attachment-${index + 1}`;
}

/** Security: `folder` is the server's own and read-only in the box, so a bot can't plant a link in it, and the file is
 * only ever created new, never written through one. */
export function saveAttachment(folder: string, name: string, content: Buffer): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  for (let n = 0; ; n++) {
    const path = join(folder, n ? `${n}-${name}` : name);
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && n < 99) continue;
      throw error;
    }
    try { writeSync(fd, content); } finally { closeSync(fd); }
    return path;
  }
}

/** Reads one message by uid: never marks it read. `saveTo`: its attachments go to files there. */
export async function readMessage(account: EmailAccount, guard: EmailGuard, input: { mailbox: string; uid: number; saveTo?: string }): Promise<ReadMessage> {
  return imapSession(account, guard, async (client) => {
    const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
    try {
      const head = await client.fetchOne(String(input.uid), QUERY, { uid: true });
      if (!head) throw new EmailError("not-found", `No message with uid ${input.uid} in ${input.mailbox}.`);
      if ((head.size ?? 0) > MAX_MESSAGE_BYTES) throw new EmailError("too-big", `This message is ${Math.round((head.size ?? 0) / 1024 ** 2)} MB, too big to read here.`);
      const full = await client.fetchOne(String(input.uid), { uid: true, source: true }, { uid: true });
      if (!full || !full.source) throw new EmailError("not-found", `No message with uid ${input.uid} in ${input.mailbox}.`);
      const { simpleParser } = await import("mailparser");
      const parsed = await simpleParser(full.source, { skipImageLinks: true, skipTextLinks: true });
      const text = (parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]*>/gu, " ") : "")).trim();
      const list = (value: typeof parsed.to) => (Array.isArray(value) ? value : value ? [value] : []).flatMap((group) => group.value.map((one) => named({ ...(one.name ? { name: one.name } : {}), ...(one.address ? { address: one.address } : {}) }))).filter(Boolean);
      return {
        ...summary(head),
        from: list(parsed.from)[0] ?? summary(head).from,
        to: list(parsed.to),
        cc: list(parsed.cc),
        replyTo: list(parsed.replyTo),
        subject: parsed.subject ?? summary(head).subject,
        ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
        ...(typeof parsed.inReplyTo === "string" ? { inReplyTo: parsed.inReplyTo } : {}),
        text: text.slice(0, MAX_TEXT_CHARS),
        truncated: text.length > MAX_TEXT_CHARS,
        attachments: parsed.attachments.map((attachment, index) => ({
          filename: attachment.filename ?? `attachment-${index + 1}`,
          contentType: attachment.contentType,
          size: attachment.size,
          ...(input.saveTo ? { savedTo: saveAttachment(input.saveTo, safeAttachmentName(attachment.filename, index), attachment.content) } : {}),
        })),
      };
    } finally { lock.release(); }
  });
}

export const MAX_SEND_JSON_BYTES = 900_000;
export const MAX_INLINE_BYTES = 256 * 1024;
export const MAX_INLINE_BASE64_CHARS = 4 * Math.ceil(MAX_INLINE_BYTES / 3);

export function checkSendBudget(input: object): void {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_SEND_JSON_BYTES) throw new EmailError("too-big", "Email arguments exceed the 900000-byte UTF-8 JSON budget; shorten text/HTML or reduce images.");
}

export interface InlineImage { cid: string; data_base64: string }

export function inlineAttachments(images: InlineImage[] = []) {
  if (!Array.isArray(images) || images.length > 4) throw new EmailError("refused", "At most four inline PNG images are allowed.");
  const cids = new Set<string>();
  let total = 0;
  return images.map((image) => {
    if (!image || Object.keys(image).some((key) => !["cid", "data_base64"].includes(key)) || typeof image.cid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u.test(image.cid) || cids.has(image.cid)) throw new EmailError("refused", "Inline images need unique, safe CIDs and base64 bytes only.");
    cids.add(image.cid);
    if (typeof image.data_base64 !== "string" || image.data_base64.length > MAX_INLINE_BASE64_CHARS || (image.data_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data_base64))) throw new EmailError("refused", "Invalid or oversized base64 PNG.");
    const content = Buffer.from(image.data_base64, "base64");
    total += content.length;
    if (total > MAX_INLINE_BYTES || content.toString("base64") !== image.data_base64 || content.length < 45 || !content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || content.readUInt32BE(8) !== 13 || content.toString("ascii", 12, 16) !== "IHDR") throw new EmailError("refused", "Inline images must be PNG, at most 256 KiB combined.");
    let offset = 8;
    let hasData = false;
    let ended = false;
    while (offset + 12 <= content.length) {
      const length = content.readUInt32BE(offset);
      const kind = content.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > content.length) throw new EmailError("refused", "Truncated PNG chunk.");
      if (kind === "IDAT") hasData = true;
      offset += length + 12;
      if (kind === "IEND") { ended = length === 0; break; }
    }
    if (!ended || content.length - offset > 16 || content.subarray(offset).some((byte) => byte !== 0) || !hasData || !content.readUInt32BE(16) || !content.readUInt32BE(20)) throw new EmailError("refused", "Invalid PNG structure.");
    return { filename: `${image.cid}.png`, content, cid: image.cid, contentType: "image/png", contentDisposition: "inline" as const };
  });
}

export interface SendInput { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; inline_images?: InlineImage[]; inReplyTo?: string; references?: string }

/** Sends as the mailbox's own address and files a copy in its Sent folder when it has one. */
export async function sendMessage(account: EmailAccount, guard: EmailGuard, input: SendInput): Promise<{ messageId: string; accepted: string[]; rejected: string[]; filed: boolean }> {
  checkSendBudget(input);
  const attachments = inlineAttachments(input.inline_images);
  const server = account.smtp;
  if (!server) throw new EmailError("refused", `No outgoing server is set for ${account.address}.`);
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer");
  const composed = new MailComposer({
    from: account.address, to: input.to, ...(input.cc?.length ? { cc: input.cc } : {}), ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.subject, text: input.text, html: input.html, attachments, disableFileAccess: true, disableUrlAccess: true, ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.references ?? input.inReplyTo } : {}),
  }).compile();
  const envelope = composed.getEnvelope();
  const raw = await composed.build();
  let sent: { accepted?: unknown[]; rejected?: unknown[]; messageId?: string };
  let transport: Awaited<ReturnType<typeof smtpTransport>> | undefined;
  try {
    transport = await smtpTransport(account, server, guard);
    sent = await transport.sendMail({ envelope, raw });
  } catch (error) { throw sendingError(error, server); } finally { transport?.close(); }
  const text = (list: unknown[] | undefined) => (list ?? []).map((entry) => (typeof entry === "string" ? entry : (entry as Address).address ?? "")).filter(Boolean);
  let filed = false;
  try {
    filed = await imapSession(account, guard, async (client) => {
      const sentBox = (await client.list()).find((box) => box.specialUse === "\\Sent");
      if (!sentBox) return false;
      await client.append(sentBox.path, raw, ["\\Seen"]);
      return true;
    });
  } catch {}
  return { messageId: composed.messageId(), accepted: text(sent.accepted), rejected: text(sent.rejected), filed };
}

/** An address literal for the connection, keeping the name for the certificate. */
export function pinned(host: string, address: string): { host: string; servername?: string } {
  return isIP(host) ? { host } : { host: address, servername: host };
}
