// One-time codes read from a person's own mailbox and typed by the server, for fill_login.
// Security: this is plain code, no model reads the mail. A message counts only when it arrived after the code was asked
// for and its sender's registrable domain is the page's site, and a code is taken only when exactly one candidate stands.
// Everything else is a fall back. What leaves this module is the code, for the secure fill path, or a reason from a fixed
// list: never a sender, a subject or a word of a body, so mail cannot speak to the bot through it.
import { loginSite } from "../shared/logins.ts";

export interface MailSummary {
  id: string;
  /** When the mailbox received it, not the date the sender wrote. 0 when the answer named none. */
  at: number;
  from: string;
  subject: string;
}

/** One connected mailbox. `body` is asked only of messages whose sender already matched; null means it could not be read. */
export interface CodeMailbox {
  list(sinceMs: number): Promise<MailSummary[]>;
  body(id: string): Promise<string | null>;
}

export type CodeMiss = "wrong-sender" | "ambiguous" | "used" | "not-found" | "unreadable";

export type CodeWait = { kind: "code"; code: string } | { kind: "miss"; why: CodeMiss };

export interface CodeWaitOptions {
  /** The page's site: only mail from this registrable domain counts. */
  site: string;
  /** When the code was asked for. */
  askedAt: number;
  /** How many separate boxes the code goes into, when more than one. */
  boxes?: number;
  isUsed(code: string): boolean;
  /** False once the turn is over, so no code is typed for a turn that has ended. */
  active?(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

/** Mailboxes and senders' clocks disagree by this much at most in practice. */
export const CLOCK_SKEW_MS = 30_000;
export const CODE_WAIT_MS = 60_000;
export const CODE_POLL_MS = 5_000;
const BODIES_PER_MAILBOX = 10;
const FAILED_ROUNDS = 2;
const MAX_SCANNED = 20_000;
const MAX_CANDIDATES = 20;
const NEAR_BEFORE = 80;
const NEAR_AFTER = 40;

const HTML_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const DROPPED_BLOCKS = /<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/giu;
const LINKS = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;
const ADDRESSES = /\S+@\S+/gu;
const DATES = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/gu;
const COPYRIGHT = /(?:©|\(c\)|copyright)\s*\d{4}/giu;
const PHONES = /\+\d[\d ().-]{6,}\d|\(\d{3}\)\s*\d{3}[-. ]?\d{4}/gu;
const CANDIDATE = /(?<![\p{L}\p{N}-])(\d{3}[- ]\d{3}|\d{4}[- ]\d{4}|[A-Z0-9]{4}-[A-Z0-9]{4}|\d{4,10}|[A-Z0-9]{4,10})(?![\p{L}\p{N}-])/gu;
const NOT_A_CODE_WORD = /(?:zip|postal|post|promo|coupon|discount|voucher|country|area|referral|invite|gift|error|reference|tracking|bar|qr|source)[- ]?code\b/giu;
const CODE_WORD = /(?<![\p{L}\p{N}])(?:code|otp|passcode|pin|verification|verify|c[oó]digo|verifica[cç][aã]o|verificaci[oó]n|verifizierungscode|bestätigungscode|sicherheitscode|anmeldecode|код)(?![\p{L}\p{N}])/iu;
const CODE_MAIL_SUBJECT = /(?<![\p{L}\p{N}])(?:code|otp|passcode|verify|verification|sign[- ]?in|log[- ]?in|login|c[oó]digo|verifica[cç][aã]o)(?![\p{L}\p{N}])/iu;

/** The readable text of a message body, without its markup. */
export function bodyText(raw: string): string {
  if (!/<[a-z!/][^>]*>/iu.test(raw)) return raw;
  return raw.replace(DROPPED_BLOCKS, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|td|table|h[1-6]|li)>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/giu, (whole, name: string) => {
      if (name[0] !== "#") return HTML_ENTITIES[name.toLowerCase()] ?? whole;
      const point = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    });
}

export type Extracted = { kind: "code"; code: string } | { kind: "none" } | { kind: "ambiguous" };

/** The one code in a message, named as one: a run of digits, or capitals with digits, next to a word for a code. */
export function extractCode(subject: string, body: string, boxes?: number): Extracted {
  const fixedLength = boxes !== undefined && boxes > 1 ? boxes : undefined;
  const text = `${subject}\n${bodyText(body)}`.slice(0, MAX_SCANNED)
    .replace(LINKS, " ").replace(ADDRESSES, " ").replace(DATES, " ").replace(COPYRIGHT, " ").replace(PHONES, " ");
  const found = new Set<string>();
  let seen = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const code = match[1]!.replace(/[- ]/gu, "");
    if (!/^\d+$/u.test(code) && !(/\d/u.test(code) && /[A-Z]/u.test(code))) continue;
    if (/^(?:19|20)\d{2}$/u.test(code) && fixedLength !== 4) continue;
    if (fixedLength !== undefined && code.length !== fixedLength) continue;
    const around = text.slice(Math.max(0, match.index - NEAR_BEFORE), match.index + match[0].length + NEAR_AFTER).replace(NOT_A_CODE_WORD, " ");
    if (!CODE_WORD.test(around)) continue;
    found.add(code);
    if (++seen > MAX_CANDIDATES) return { kind: "ambiguous" };
  }
  if (found.size > 1) return { kind: "ambiguous" };
  const [code] = found;
  return code === undefined ? { kind: "none" } : { kind: "code", code };
}

/** The domain of a From value, only when it plainly names one address. A display name that holds an address, a second
 * address, or text after the address reads as no sender at all. */
export function senderDomain(from: string): string | null {
  const value = from.replace(/"(?:[^"\\]|\\.)*"/gu, " ").trim();
  const angled = [...value.matchAll(/<([^<>\s]*)>/gu)];
  let address = value;
  if (angled.length === 1) {
    const [match] = angled;
    if (value.slice(0, match!.index).includes("@") || value.slice(match!.index + match![0].length).trim()) return null;
    address = match![1]!;
  }
  if (/[\s,;<>]/u.test(address)) return null;
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return null;
  const domain = address.slice(at + 1).toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(domain) ? domain : null;
}

/** Whether a From value is an address of `site`, by registrable domain. */
export function sentBySite(from: string, site: string): boolean {
  const domain = senderDomain(from);
  return domain !== null && loginSite(domain) === site;
}

type Round = { code?: string; ambiguous?: boolean; wrongSender?: boolean; used?: boolean; unreadable?: boolean; failed?: boolean };

/** One look through one mailbox, reading each matching message's body at most once for the whole wait. */
async function look(box: CodeMailbox, options: CodeWaitOptions, read: Map<string, Extracted>): Promise<Round & { codes: Set<string> }> {
  const round: Round & { codes: Set<string> } = { codes: new Set() };
  if (options.active?.() === false) return round;
  let listed: MailSummary[];
  try { listed = await box.list(options.askedAt - CLOCK_SKEW_MS); } catch { round.failed = true; return round; }
  if (options.active?.() === false) return round;
  const recent = listed.filter((mail) => mail.at >= options.askedAt - CLOCK_SKEW_MS);
  round.wrongSender = recent.some((mail) => !sentBySite(mail.from, options.site) && CODE_MAIL_SUBJECT.test(mail.subject));
  const theirs = recent.filter((mail) => sentBySite(mail.from, options.site)).slice(0, BODIES_PER_MAILBOX);
  for (const mail of theirs) {
    if (options.active?.() === false) return round;
    let result = read.get(mail.id);
    if (!result) {
      let text: string | null = null;
      try { text = await box.body(mail.id); } catch { text = null; }
      if (options.active?.() === false) return round;
      if (text === null) { round.unreadable = true; continue; }
      result = extractCode(mail.subject, text, options.boxes);
      read.set(mail.id, result);
    }
    if (result.kind === "ambiguous") round.ambiguous = true;
    if (result.kind === "code") {
      if (options.isUsed(result.code)) round.used = true;
      else round.codes.add(result.code);
    }
  }
  return round;
}

/** Waits for one new code from the site. Two different new codes, or a message whose code can't be told apart, end the
 * wait at once; anything else keeps looking until the time is up, and then says what was seen. */
export async function waitForEmailCode(mailboxes: readonly CodeMailbox[], options: CodeWaitOptions): Promise<CodeWait> {
  const waitMs = options.waitMs ?? CODE_WAIT_MS;
  const pollMs = options.pollMs ?? CODE_POLL_MS;
  const deadline = options.now() + waitMs;
  const read = mailboxes.map(() => new Map<string, Extracted>());
  let wrongSender = false, used = false, unreadable = false, failedRounds = 0;
  for (;;) {
    if (options.active?.() === false) break;
    const rounds = await Promise.all(mailboxes.map((box, index) => look(box, options, read[index]!)));
    if (options.active?.() === false) break;
    const codes = new Set(rounds.flatMap((round) => [...round.codes]));
    if (rounds.some((round) => round.ambiguous) || codes.size > 1) return { kind: "miss", why: "ambiguous" };
    if (codes.size === 1) return { kind: "code", code: [...codes][0]! };
    wrongSender ||= rounds.some((round) => round.wrongSender);
    used ||= rounds.some((round) => round.used);
    unreadable ||= rounds.some((round) => round.unreadable);
    failedRounds = rounds.every((round) => round.failed) ? failedRounds + 1 : 0;
    if (failedRounds >= FAILED_ROUNDS || options.now() >= deadline) break;
    await options.sleep(pollMs);
  }
  if (failedRounds >= FAILED_ROUNDS || unreadable) return { kind: "miss", why: "unreadable" };
  if (used) return { kind: "miss", why: "used" };
  return { kind: "miss", why: wrongSender ? "wrong-sender" : "not-found" };
}
