// The person's mailboxes with their passwords, sealed under a key of their own (a 0600 file beside the store), so they
// rest encrypted on a desktop and on a Cloud home alike. No route, card, bot or log ever gets a password back; the box
// hides the data folder, so no bot's shell can open these files.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "../browser-sites.ts";

export const EMAIL_FILE = "email.json.enc";
export const EMAIL_KEY_FILE = "email-key";
export const MAX_EMAIL_ACCOUNTS = 10;

const serverSchema = z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535), secure: z.boolean() });
const accountSchema = z.object({
  address: z.string().min(3).max(320),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(4_096),
  imap: serverSchema,
  smtp: serverSchema.optional(),
  /** The outgoing server's own sign-in, when it isn't the incoming one's. */
  smtpUsername: z.string().min(1).max(320).optional(),
  smtpPassword: z.string().min(1).max(4_096).optional(),
  connectedAt: z.number(),
  problem: z.string().max(400).optional(),
  /** Why sending doesn't work, from the last check or send; sends wait for the person while it is set. */
  sendingProblem: z.string().max(400).optional(),
  /** While sending doesn't work: the outgoing server that reason is about. */
  smtpTried: serverSchema.optional(),
});
const fileSchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema).max(MAX_EMAIL_ACCOUNTS) });

export type EmailServer = z.infer<typeof serverSchema>;
/** One mailbox with its password. Server-only. */
export type EmailAccount = z.infer<typeof accountSchema>;
type StoreFile = z.infer<typeof fileSchema>;

const EMPTY: StoreFile = { version: 1, accounts: [] };

/** A mailbox as this store keeps it, from anywhere else (one moved from the person's own computer); null if not. */
export function parseEmailAccount(value: unknown): EmailAccount | null {
  const parsed = accountSchema.safeParse(value);
  return parsed.success ? withoutReadOnlyProblem(parsed.data) : null;
}

/** "Reading works. …" as the problem of a mailbox with no outgoing server is a sending problem, which isn't kept there. */
function withoutReadOnlyProblem(account: EmailAccount): EmailAccount {
  if (account.smtp || !account.problem?.startsWith("Reading works.")) return account;
  const { problem: _problem, ...rest } = account;
  return rest;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class EmailStore {
  private readonly file: string;
  private readonly keyFile: string;
  private cache: StoreFile | null = null;
  private unreadableWarned = false;

  constructor(dataDir: string) {
    this.file = join(dataDir, EMAIL_FILE);
    this.keyFile = join(dataDir, EMAIL_KEY_FILE);
  }

  private key(create: boolean): string | null {
    try {
      const existing = readFileSync(this.keyFile, "utf8").trim();
      if (/^[0-9a-f]{64}$/u.test(existing)) return existing;
    } catch {}
    if (!create) return null;
    const key = randomBytes(32).toString("hex");
    mkdirSync(join(this.keyFile, ".."), { recursive: true });
    writeFileAtomic(this.keyFile, `${key}\n`, { mode: 0o600 });
    return key;
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    let data = EMPTY;
    if (existsSync(this.file)) {
      const key = this.key(false);
      try {
        if (!key) throw new Error("missing key");
        const parsed = fileSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.file), key)));
        data = { ...parsed, accounts: parsed.accounts.map(withoutReadOnlyProblem) };
      } catch {
        // Never log an unreadable file's contents.
        if (!this.unreadableWarned) console.warn("Email: the saved mailboxes could not be opened; connect them again");
        this.unreadableWarned = true;
      }
    }
    this.cache = data;
    return data;
  }

  private write(accounts: EmailAccount[]): void {
    const parsed = fileSchema.parse({ version: 1, accounts });
    const key = this.key(true)!;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    this.cache = parsed;
  }

  list(): readonly EmailAccount[] {
    return this.read().accounts;
  }

  get(address: string): EmailAccount | null {
    return this.list().find((account) => same(account.address, address)) ?? null;
  }

  /** Adds a mailbox, or replaces the one at that address. */
  put(account: EmailAccount): void {
    this.write([...this.list().filter((other) => !same(other.address, account.address)), account]);
  }

  remove(address: string): boolean {
    const kept = this.list().filter((account) => !same(account.address, address));
    if (kept.length === this.list().length) return false;
    if (kept.length) this.write(kept);
    else { rmSync(this.file, { force: true }); this.cache = EMPTY; }
    return true;
  }

  /** Says the password stopped working, only while it is still the one that failed. */
  markProblem(address: string, password: string, problem: string | undefined): void {
    const current = this.get(address);
    if (!current || current.password !== password || current.problem === problem) return;
    const { problem: _problem, ...rest } = current;
    this.put({ ...rest, ...(problem ? { problem } : {}) });
  }

  /** Says sending stopped working, only while the outgoing server and its password are still the ones that failed. */
  markSendingProblem(failed: Pick<EmailAccount, "address" | "password" | "smtp" | "smtpPassword">, problem: string): void {
    const current = this.get(failed.address);
    if (!current || current.password !== failed.password || current.smtpPassword !== failed.smtpPassword || current.smtp?.host !== failed.smtp?.host || current.smtp?.port !== failed.smtp?.port || current.sendingProblem === problem) return;
    this.put({ ...current, sendingProblem: problem });
  }

  /** The passwords, for secret redaction. */
  secretValues(): string[] {
    return this.list().flatMap((account) => (account.smtpPassword ? [account.password, account.smtpPassword] : [account.password]));
  }
}
