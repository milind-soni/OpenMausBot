// Sealed under a key of its own (a 0600 file beside it), never the browser engine's, which every browser process gets in
// its environment. Neither file is ever backed up, exported or moved: a saved password stays on its computer, unless the
// person sends that one login to their own Cloud with Also use on My Cloud (login-handoff.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { HELD_SECRET_MASK } from "../shared/redact.ts";
import { LOGIN_FIELD_MAX, LOGIN_HOSTS_MAX, loginMatchesHost, loginSite, loginUsableBy, type LoginBots, type LoginPlace, type LoginSummary } from "../shared/logins.ts";
import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";
import type { TotpKey } from "./totp.ts";

export const LOGINS_FILE = "logins.json.enc";
export const LOGINS_KEY_FILE = "logins-key";

const totpSchema = z.object({
  secret: z.string().regex(/^[A-Z2-7]{16,}$/u),
  algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
  digits: z.number().int().min(6).max(8),
  period: z.number().int().min(10).max(300),
});

const botsSchema = z.union([z.literal("all"), z.array(z.string())]);

// The previous release reads `version: 1` records by `host` alone and replaces a file it cannot parse, so every record
// keeps `host` (its first sign-in host) and the version stays 1: going back a release never loses a saved login.
const diskLoginSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  site: z.string().min(1).optional(),
  hosts: z.array(z.string().min(1)).min(1).max(LOGIN_HOSTS_MAX).optional(),
  exactHost: z.boolean().optional(),
  username: z.string().max(LOGIN_FIELD_MAX),
  password: z.string().min(1).max(LOGIN_FIELD_MAX),
  totp: totpSchema.optional(),
  source: z.enum(["card", "settings"]),
  bots: botsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
});

const fileSchema = z.object({
  version: z.literal(1),
  logins: z.array(diskLoginSchema),
  onePassword: z.object({ token: z.string().min(1), connectedAt: z.number() }).optional(),
  /** Vault id → the bots that may use its logins; a vault not named here is for every bot. Kept across reconnects. */
  onePasswordGrants: z.record(z.string(), botsSchema).optional(),
});

type DiskLogin = z.infer<typeof diskLoginSchema>;
type DiskFile = z.infer<typeof fileSchema>;

/** One saved login with its secrets. Server-only: no route returns this. */
export type StoredLogin = Omit<DiskLogin, "host" | "site" | "hosts" | "exactHost"> & LoginPlace;
type StoreFile = Omit<DiskFile, "logins"> & { logins: StoredLogin[] };

export interface NewLogin extends LoginPlace {
  username: string;
  password: string;
  totp?: TotpKey | null;
  source: "card" | "settings";
  bots: LoginBots;
}

export interface LoginPatch {
  username?: string;
  password?: string;
  totp?: TotpKey | null;
  bots?: LoginBots;
  exactHost?: boolean;
}

const EMPTY: StoreFile = { version: 1, logins: [] };

/** A record written before logins had a site: its one host becomes its sign-in host, and its site the host's. */
function fromDisk({ host, site, hosts, exactHost, ...rest }: DiskLogin): StoredLogin {
  return { ...rest, site: site ?? loginSite(host), hosts: hosts ?? [host], exactHost: exactHost ?? false };
}

function toDisk(login: StoredLogin): DiskLogin {
  return { ...login, host: login.hosts[0]! };
}

export function summarizeLogin(login: StoredLogin): LoginSummary {
  return {
    id: login.id, site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username, hasTotp: Boolean(login.totp),
    source: login.source, bots: login.bots, createdAt: login.createdAt,
    ...(login.lastUsedAt === undefined ? {} : { lastUsedAt: login.lastUsedAt }),
  };
}

/** The same account: one username on one site, unless either is kept to hosts the other does not share. */
function sameAccount(login: StoredLogin, input: NewLogin): boolean {
  if (login.username.toLowerCase() !== input.username.toLowerCase() || login.site !== input.site) return false;
  return (!login.exactHost && !input.exactHost) || login.hosts.some((host) => input.hosts.includes(host));
}

export class LoginStore {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly now: () => number;
  private cache: StoreFile | null = null;
  private unreadableWarned = false;
  version = 0;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, LOGINS_FILE);
    this.keyFile = join(options.dataDir, LOGINS_KEY_FILE);
    this.now = options.now ?? Date.now;
  }

  private key(create: boolean): string | null {
    try {
      const existing = readFileSync(this.keyFile, "utf8").trim();
      if (/^[0-9a-f]{64}$/u.test(existing)) return existing;
    } catch {
    }
    if (!create) return null;
    const key = randomBytes(32).toString("hex");
    mkdirSync(join(this.keyFile, ".."), { recursive: true });
    writeFileAtomic(this.keyFile, `${key}\n`, { mode: 0o600 });
    return key;
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    let data: StoreFile = EMPTY;
    if (existsSync(this.file)) {
      const key = this.key(false);
      try {
        if (!key) throw new Error("missing key");
        const disk = fileSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.file), key)));
        data = { ...disk, logins: disk.logins.map(fromDisk) };
      } catch {
        // Never log an unreadable file's contents.
        if (!this.unreadableWarned) console.warn("saved logins: the saved logins file could not be opened; it will be replaced on the next save");
        this.unreadableWarned = true;
        data = EMPTY;
      }
    }
    this.cache = data;
    this.version++;
    return data;
  }

  private write(data: StoreFile): void {
    const parsed = fileSchema.parse({ ...data, logins: data.logins.map(toDisk) });
    const key = this.key(true)!;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    this.cache = { ...parsed, logins: parsed.logins.map(fromDisk) };
    this.version++;
  }

  list(): LoginSummary[] {
    return this.read().logins.map(summarizeLogin).sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
  }

  /** When each login last changed, for Send to My Cloud's comparison: never a secret. */
  changes(): Array<{ id: string; site: string; hosts: string[]; exactHost: boolean; username: string; updatedAt: number }> {
    return this.read().logins.map(({ id, site, hosts, exactHost, username, updatedAt }) => ({ id, site, hosts, exactHost, username, updatedAt }));
  }

  onePasswordConnectedAt(): number | null {
    return this.read().onePassword?.connectedAt ?? null;
  }

  get(id: string): StoredLogin | null {
    return this.read().logins.find((login) => login.id === id) ?? null;
  }

  /** The same account saved again replaces its password, adds its sign-in hosts and widens who may use it; being kept
   * to exact hosts is never undone here. */
  create(input: NewLogin): LoginSummary {
    const data = this.read();
    const at = this.now();
    const same = data.logins.find((login) => sameAccount(login, input));
    if (same) {
      const bots: LoginBots = same.bots === "all" || input.bots === "all" ? "all" : [...new Set([...same.bots, ...input.bots])];
      const updated: StoredLogin = { ...same, username: input.username, password: input.password, bots, updatedAt: at,
        hosts: [...new Set([...same.hosts, ...input.hosts])].slice(0, LOGIN_HOSTS_MAX), exactHost: same.exactHost || input.exactHost,
        ...(input.totp ? { totp: input.totp } : {}) };
      this.write({ ...data, logins: data.logins.map((login) => login.id === same.id ? updated : login) });
      return summarizeLogin(updated);
    }
    const login: StoredLogin = {
      id: randomUUID(), site: input.site, hosts: input.hosts.slice(0, LOGIN_HOSTS_MAX), exactHost: input.exactHost,
      username: input.username, password: input.password,
      ...(input.totp ? { totp: input.totp } : {}),
      source: input.source, bots: input.bots, createdAt: at, updatedAt: at,
    };
    this.write({ ...data, logins: [...data.logins, login] });
    return summarizeLogin(login);
  }

  update(id: string, patch: LoginPatch): LoginSummary | null {
    const data = this.read();
    const current = data.logins.find((login) => login.id === id);
    if (!current) return null;
    const next: StoredLogin = {
      ...current,
      ...(patch.username === undefined ? {} : { username: patch.username }),
      ...(patch.password === undefined ? {} : { password: patch.password }),
      ...(patch.bots === undefined ? {} : { bots: patch.bots }),
      ...(patch.exactHost === undefined ? {} : { exactHost: patch.exactHost }),
      updatedAt: this.now(),
    };
    if (patch.totp === null) delete next.totp;
    else if (patch.totp) next.totp = patch.totp;
    this.write({ ...data, logins: data.logins.map((login) => login.id === id ? next : login) });
    return summarizeLogin(next);
  }

  remove(id: string): boolean {
    const data = this.read();
    if (!data.logins.some((login) => login.id === id)) return false;
    this.write({ ...data, logins: data.logins.filter((login) => login.id !== id) });
    return true;
  }

  usableFor(pageHost: string, botId: string): StoredLogin[] {
    return this.read().logins.filter((login) => loginMatchesHost(login, pageHost) && loginUsableBy(login, botId));
  }

  /** Where each login a bot may use fills, and its username, for the bot's prompt. */
  sitesFor(botId: string): Array<LoginPlace & { username: string }> {
    return this.read().logins.filter((login) => loginUsableBy(login, botId))
      .map((login) => ({ site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
  }

  markUsed(id: string): void {
    const data = this.read();
    if (!data.logins.some((login) => login.id === id)) return;
    const at = this.now();
    this.write({ ...data, logins: data.logins.map((login) => login.id === id ? { ...login, lastUsedAt: at } : login) });
  }

  onePasswordToken(): string | null {
    return this.read().onePassword?.token ?? null;
  }

  setOnePasswordToken(token: string | null): void {
    const data = this.read();
    const { onePassword: _previous, ...rest } = data;
    this.write(token ? { ...rest, onePassword: { token, connectedAt: this.now() } } : rest);
  }

  onePasswordGrants(): Record<string, LoginBots> {
    return this.read().onePasswordGrants ?? {};
  }

  /** "all" opens a vault to every bot again. */
  setOnePasswordGrant(vaultId: string, bots: LoginBots): void {
    const data = this.read();
    const { [vaultId]: _previous, ...others } = data.onePasswordGrants ?? {};
    const grants = bots === "all" ? others : { ...others, [vaultId]: bots };
    const { onePasswordGrants: _grants, ...rest } = data;
    this.write(Object.keys(grants).length ? { ...rest, onePasswordGrants: grants } : rest);
  }

  secretValues(): string[] {
    const data = this.read();
    return [
      ...data.logins.flatMap((login) => [login.password, ...(login.totp ? [login.totp.secret] : [])]),
      ...(data.onePassword ? [data.onePassword.token] : []),
    ];
  }
}

// Saved secrets, passwords filled this run and recent one-time codes are masked wherever text crosses to a bot or a
// transcript. A screenshot cannot be scrubbed.

const MIN_SECRET = 4;
const CODE_MEMORY_MS = 5 * 60_000;
const FILLED_LIMIT = 500;

function htmlEscaped(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export function secretForms(value: string): string[] {
  const forms = new Set([value, JSON.stringify(value).slice(1, -1), htmlEscaped(value)]);
  try {
    forms.add(encodeURIComponent(value));
    forms.add(encodeURIComponent(value).replace(/%20/gu, "+"));
  } catch {}
  return [...forms].filter((form) => form.length >= MIN_SECRET);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export class HeldSecrets {
  private readonly filled = new Set<string>();
  private readonly codes = new Map<string, number>();
  private forms: string[] = [];
  private builtFor = -1;
  private filledVersion = 0;
  private builtFilled = -1;
  private readonly stored: { version: number; secretValues(): string[] };
  private readonly now: () => number;

  constructor(stored: { version: number; secretValues(): string[] }, now: () => number = Date.now) {
    this.stored = stored;
    this.now = now;
  }

  remember(value: string, kind: "password" | "code"): void {
    if (!value) return;
    if (kind === "code") {
      this.codes.set(value, this.now() + CODE_MEMORY_MS);
      return;
    }
    if (value.length < MIN_SECRET || this.filled.has(value)) return;
    if (this.filled.size >= FILLED_LIMIT) this.filled.delete(this.filled.values().next().value!);
    this.filled.add(value);
    this.filledVersion++;
  }

  private currentForms(): string[] {
    // Reading the store may load it, which bumps its version: read first.
    const values = this.stored.secretValues();
    if (this.builtFor !== this.stored.version || this.builtFilled !== this.filledVersion) {
      const all = new Set([...values, ...this.filled].flatMap(secretForms));
      // Longest first, so a password that contains another is masked whole.
      this.forms = [...all].sort((a, b) => b.length - a.length);
      this.builtFor = this.stored.version;
      this.builtFilled = this.filledVersion;
    }
    return this.forms;
  }

  scrub(text: string): string {
    if (!text) return text;
    let out = text;
    for (const form of this.currentForms()) if (out.includes(form)) out = out.split(form).join(HELD_SECRET_MASK);
    if (this.codes.size) {
      const now = this.now();
      for (const [code, until] of this.codes) {
        if (until <= now) { this.codes.delete(code); continue; }
        if (out.includes(code)) out = out.replace(new RegExp(`(?<!\\d)${escapeRegExp(code)}(?!\\d)`, "gu"), HELD_SECRET_MASK);
      }
    }
    return out;
  }
}
