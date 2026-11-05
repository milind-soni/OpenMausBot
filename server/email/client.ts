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
  /** `password`: the server refused the sign-in. `network`: no answer, or no valid TLS. `server`: it answered no. */
  readonly code: "password" | "network" | "server" | "refused" | "not-found" | "too-big";
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

/** Whether this server sends with this password; nothing is sent. */
export async function testSending(account: Pick<EmailAccount, "username" | "password">, server: EmailServer, guard: EmailGuard): Promise<void> {
  const transport = await smtpTransport(account, server, guard);
  try { await transport.verify(); } catch (error) { throw failure(error); } finally { transport.close(); }
}

async function smtpTransport(account: Pick<EmailAccount, "username" | "password">, server: EmailServer, guard: EmailGuard) {
  const { createTransport } = await import("nodemailer");
  const at = await guard(server);
  return createTransport({
    host: at.host, port: server.port, secure: server.secure, requireTLS: !server.secure,
    auth: { user: account.username, pass: account.password },
    tls: { ...TLS, ...(at.servername ? { servername: at.servername } : {}) },
    connectionTimeout: CONNECT_MS, greetingTimeout: CONNECT_MS, socketTimeout: COMMAND_MS,
  });
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

export interface SendInput { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; inReplyTo?: string; references?: string }

/** Sends as the mailbox's own address and files a copy in its Sent folder when it has one. */
export async function sendMessage(account: EmailAccount, guard: EmailGuard, input: SendInput): Promise<{ messageId: string; accepted: string[]; rejected: string[]; filed: boolean }> {
  if (!account.smtp) throw new EmailError("refused", `No server that sends was found for ${account.address}. Reconnect it under Connected apps and enter its outgoing server.`);
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer");
  const composed = new MailComposer({
    from: account.address, to: input.to, ...(input.cc?.length ? { cc: input.cc } : {}), ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.subject, text: input.text, ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.references ?? input.inReplyTo } : {}),
  }).compile();
  const envelope = composed.getEnvelope();
  const raw = await composed.build();
  const transport = await smtpTransport(account, account.smtp, guard);
  let sent: { accepted?: unknown[]; rejected?: unknown[]; messageId?: string };
  try { sent = await transport.sendMail({ envelope, raw }); } catch (error) { throw failure(error); } finally { transport.close(); }
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
