// Email sign-in codes sent through the server's own mail server (OMB_SIGNIN_SMTP_URL) instead of the OpenMausBot account
// service. A code is 8 digits, works once for ten minutes and for five tries, and only its hash is kept, in memory.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const SIGNIN_CODE_TTL_MS = 10 * 60_000;
export const SIGNIN_CODE_RESEND_MS = 30_000;
export const SIGNIN_CODE_TRIES = 5;
const MAX_PENDING = 1_000;

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export type CodeCheck = "ok" | "format" | "wrong" | "tooMany";

export interface SignInMail {
  /** "tooSoon": a code went to this address moments ago; it still works. */
  send(email: string): Promise<"sent" | "tooSoon">;
  check(email: string, code: string): CodeCheck;
}

export class SignInMailError extends Error {}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** `smtps://user:password@host:465` (TLS from the start) or `smtp://user:password@host:587` (STARTTLS, required unless
 * the mail server is on this machine). The user name and password are URL-encoded. */
export function smtpOptions(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SignInMailError("OMB_SIGNIN_SMTP_URL is not a URL such as smtps://user:password@smtp.example.com:465");
  }
  if (parsed.protocol !== "smtps:" && parsed.protocol !== "smtp:") throw new SignInMailError("OMB_SIGNIN_SMTP_URL must start with smtps:// or smtp://");
  const secure = parsed.protocol === "smtps:";
  const user = decodeURIComponent(parsed.username);
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(parsed.port) || (secure ? 465 : 587), secure,
    requireTLS: !secure && !LOOPBACK.test(parsed.hostname),
    ...(user ? { auth: { user, pass: decodeURIComponent(parsed.password) } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  };
}

const digest = (code: string) => createHash("sha256").update(code).digest();

export function createSignInMail(options: { url: string; from?: string; now?: () => number; transport?: MailTransport }): SignInMail {
  const now = options.now ?? Date.now;
  const pending = new Map<string, { hash: Buffer; sentAt: number; tries: number }>();
  let transport: Promise<MailTransport> | undefined = options.transport ? Promise.resolve(options.transport) : undefined;
  const from = (): string => {
    const named = options.from?.trim() || smtpOptions(options.url).auth?.user || "";
    if (!named.includes("@")) throw new SignInMailError("set OMB_SIGNIN_SMTP_FROM to the address sign-in codes come from");
    return named;
  };
  const prune = () => {
    for (const [email, entry] of pending) if (now() - entry.sentAt >= SIGNIN_CODE_TTL_MS) pending.delete(email);
  };
  return {
    async send(email) {
      prune();
      const open = pending.get(email);
      if (open && now() - open.sentAt < SIGNIN_CODE_RESEND_MS) return "tooSoon";
      if (!open && pending.size >= MAX_PENDING) return "tooSoon";
      const sender = from();
      transport ??= import("nodemailer").then(({ createTransport }) => createTransport(smtpOptions(options.url)));
      const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
      pending.set(email, { hash: digest(code), sentAt: now(), tries: 0 });
      try {
        await (await transport).sendMail({
          from: sender, to: email, subject: "Your OpenMausBot sign-in code",
          text: `Your code to sign in to OpenMausBot is\n\n    ${code.slice(0, 4)} ${code.slice(4)}\n\nIt works once, for the next ten minutes.\n`
            + "If you did not ask to sign in, ignore this email: nobody gets in without the code.\n",
        });
      } catch (error) {
        pending.delete(email);
        throw error;
      }
      return "sent";
    },
    check(email, raw) {
      const code = raw.replace(/[\s-]/g, "");
      if (!/^\d{8}$/.test(code)) return "format";
      prune();
      const entry = pending.get(email);
      if (!entry) return "wrong";
      entry.tries += 1;
      if (timingSafeEqual(entry.hash, digest(code))) {
        pending.delete(email);
        return "ok";
      }
      if (entry.tries < SIGNIN_CODE_TRIES) return "wrong";
      pending.delete(email);
      return "tooMany";
    },
  };
}
