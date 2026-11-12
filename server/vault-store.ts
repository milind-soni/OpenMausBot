// The Vault: saved logins and saved secrets. Sealed under a key of its own (a 0600 file beside it), never the browser
// engine's, which every browser process gets in its environment. None of its files is ever backed up, exported or moved: a
// saved value stays on its computer, unless the person sends it to their own Cloud with Also use on My Cloud
// (login-handoff.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { HELD_SECRET_MASK } from "../shared/redact.ts";
import { LOGIN_FIELD_MAX, LOGIN_HOSTS_MAX, loginMatchesHost, loginSite, loginUsableBy, type LoginBots, type LoginPlace, type LoginSummary } from "../shared/logins.ts";
import { SECRET_VALUE_MAX_BYTES, VAULT_SECRET_NAME_MAX, vaultNameKey, type VaultSecret } from "../shared/vault.ts";
import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";
import type { TotpKey } from "./totp.ts";

export const LOGINS_FILE = "logins.json.enc";
export const LOGINS_KEY_FILE = "logins-key";
/** A Team Cloud member's own secrets, sealed under the same key. A file of their own, so the previous release, which
 * would read them as the team's, never opens it. */
export const MEMBER_SECRETS_FILE = "member-secrets.json.enc";

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

const diskSecretSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(VAULT_SECRET_NAME_MAX),
  value: z.string().min(1).max(SECRET_VALUE_MAX_BYTES),
  source: z.enum(["card", "settings"]),
  bots: botsSchema,
  refOnly: z.literal(true).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
});

// The previous release parses this file with a non-strict object, so it reads its logins and skips `secrets`.
const fileSchema = z.object({
  version: z.literal(1),
  logins: z.array(diskLoginSchema),
  secrets: z.array(diskSecretSchema).optional(),
  onePassword: z.object({ token: z.string().min(1), connectedAt: z.number() }).optional(),
  /** Vault id → the bots that may use its logins; a vault not named here is for every bot. Kept across reconnects. */
  onePasswordGrants: z.record(z.string(), botsSchema).optional(),
  /** 1Password item (`<vault id>:<item id>`) → the bots that may use it, ahead of its vault's choice. Kept across reconnects. */
  onePasswordItemGrants: z.record(z.string(), botsSchema).optional(),
  /** Security: MCP server name → the items whose `vault:<id>` that server may read. Written only when a bot's secretRef
   * is redeemed into the server (or a move carries the server), so a pointer planted in config.json reads nothing. */
  mcpKeys: z.record(z.string(), z.array(z.string().min(1))).optional(),
});

const memberSecretsSchema = z.object({
  version: z.literal(1),
  secrets: z.array(diskSecretSchema.extend({ person: z.string().regex(/^p_[\w-]{22}$/u) })),
});

type DiskLogin = z.infer<typeof diskLoginSchema>;
type DiskFile = z.infer<typeof fileSchema>;

/** One saved login with its secrets. Server-only: no route returns this. */
export type StoredLogin = Omit<DiskLogin, "host" | "site" | "hosts" | "exactHost"> & LoginPlace;
type StoreFile = Omit<DiskFile, "logins" | "secrets"> & { logins: StoredLogin[]; secrets?: StoredSecret[] };
/** One saved secret with its value. Server-only: no route returns this. `person`: a Team Cloud member's own, typed
 * into a card in their private chat; absent: the team's (every secret off a Team Cloud). */
export type StoredSecret = z.infer<typeof diskSecretSchema> & { person?: string };

/** Who reads the Vault: `person`'s own secrets, and the team's when `team`. */
export interface VaultReader {
  person: string | null;
  team: boolean;
}

/** A turn off a Team Cloud, or in a conversation that is no one person's own, and an admin's view with no person. */
export const TEAM_READER: VaultReader = { person: null, team: true };

/** Security: a member's own secret reaches only their own turns and their own Settings, never an admin's. */
export function secretReadable(secret: { person?: string }, reader: VaultReader): boolean {
  return secret.person ? secret.person === reader.person : reader.team;
}

export interface NewSecret {
  name: string;
  value: string;
  source: "card" | "settings";
  bots: LoginBots;
  refOnly?: boolean;
  person?: string;
}

export interface SecretPatch {
  name?: string;
  value?: string;
  bots?: LoginBots;
}

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

export function summarizeSecret({ value: _value, person: _person, ...secret }: StoredSecret): VaultSecret {
  return secret;
}

function sameBots(a: LoginBots, b: LoginBots): boolean {
  if (a === "all" || b === "all") return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** The same account: one username on one site, unless either is kept to hosts the other does not share. */
function sameAccount(login: StoredLogin, input: NewLogin): boolean {
  if (login.username.toLowerCase() !== input.username.toLowerCase() || login.site !== input.site) return false;
  return (!login.exactHost && !input.exactHost) || login.hosts.some((host) => input.hosts.includes(host));
}

export class VaultStore {
  private readonly file: string;
  private readonly memberFile: string;
  private readonly keyFile: string;
  private readonly now: () => number;
  private readonly secretChanged: (id: string) => void;
  private cache: StoreFile | null = null;
  private unreadableWarned = false;
  version = 0;

  /** `secretChanged`: a saved secret's value or who may use it changed, or it is gone. */
  constructor(options: { dataDir: string; now?: () => number; secretChanged?: (id: string) => void }) {
    this.file = join(options.dataDir, LOGINS_FILE);
    this.memberFile = join(options.dataDir, MEMBER_SECRETS_FILE);
    this.keyFile = join(options.dataDir, LOGINS_KEY_FILE);
    this.now = options.now ?? Date.now;
    this.secretChanged = options.secretChanged ?? (() => {});
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
    const members = this.readMembers();
    if (members.length) data = { ...data, secrets: [...data.secrets ?? [], ...members] };
    this.cache = data;
    this.version++;
    return data;
  }

  private readMembers(): StoredSecret[] {
    if (!existsSync(this.memberFile)) return [];
    try {
      const key = this.key(false);
      if (!key) throw new Error("missing key");
      return memberSecretsSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.memberFile), key))).secrets;
    } catch {
      if (!this.unreadableWarned) console.warn("saved logins: the members' secrets file could not be opened; it will be replaced on the next save");
      this.unreadableWarned = true;
      return [];
    }
  }

  private write(data: StoreFile): void {
    const members = (data.secrets ?? []).filter((secret) => secret.person);
    const team = data.secrets?.filter((secret) => !secret.person);
    const parsed = fileSchema.parse({ ...data, logins: data.logins.map(toDisk), ...(team ? { secrets: team } : {}) });
    const ownParsed = memberSecretsSchema.parse({ version: 1, secrets: members });
    const key = this.key(true)!;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    if (members.length || existsSync(this.memberFile)) writeFileAtomic(this.memberFile, encryptBrowserState(JSON.stringify(ownParsed), key), { mode: 0o600 });
    this.cache = { ...parsed, logins: parsed.logins.map(fromDisk), ...(ownParsed.secrets.length ? { secrets: [...parsed.secrets ?? [], ...ownParsed.secrets] } : {}) };
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

  usableFor(pageHost: string, botId: string | readonly string[]): StoredLogin[] {
    return this.read().logins.filter((login) => loginMatchesHost(login, pageHost) && loginUsableBy(login, botId));
  }

  /** Where each login a bot may use fills, and its username, for the bot's prompt. */
  sitesFor(botId: string | readonly string[]): Array<LoginPlace & { username: string }> {
    return this.read().logins.filter((login) => loginUsableBy(login, botId))
      .map((login) => ({ site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
  }

  markUsed(id: string): void {
    const data = this.read();
    const at = this.now();
    if (data.logins.some((login) => login.id === id)) {
      this.write({ ...data, logins: data.logins.map((login) => login.id === id ? { ...login, lastUsedAt: at } : login) });
    } else if (data.secrets?.some((secret) => secret.id === id)) {
      this.write({ ...data, secrets: data.secrets.map((secret) => secret.id === id ? { ...secret, lastUsedAt: at } : secret) });
    }
  }

  /** One saved secret with its value, for handing to a bot. */
  secret(id: string): StoredSecret | null {
    return this.read().secrets?.find((secret) => secret.id === id) ?? null;
  }

  listSecrets(reader: VaultReader): VaultSecret[] {
    return (this.read().secrets ?? []).filter((secret) => secretReadable(secret, reader)).map(summarizeSecret).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The secret `botId` may use by this name, as a ref or a file, in a turn `reader` names: one kept to some bots before
   * one for every bot, then the newest. */
  usableSecret(name: string, botId: string, delivery: "ref" | "file", reader: VaultReader): StoredSecret | null {
    const key = vaultNameKey(name);
    const matches = (this.read().secrets ?? []).filter((secret) => vaultNameKey(secret.name) === key && loginUsableBy(secret, botId) &&
      secretReadable(secret, reader) && (delivery === "ref" || !secret.refOnly));
    return matches.sort((a, b) => Number(b.bots !== "all") - Number(a.bots !== "all") || b.updatedAt - a.updatedAt)[0] ?? null;
  }

  secretNamesFor(botId: string, reader: VaultReader): Array<{ name: string; refOnly?: true }> {
    return (this.read().secrets ?? []).filter((secret) => loginUsableBy(secret, botId) && secretReadable(secret, reader))
      .map(({ name, refOnly }) => ({ name, ...(refOnly ? { refOnly } : {}) }));
  }

  /** The same name saved again for the same bots and the same person replaces its value; otherwise it is a new secret. */
  saveSecret(input: NewSecret): VaultSecret {
    const data = this.read();
    const secrets = data.secrets ?? [];
    const at = this.now();
    const same = secrets.find((secret) => vaultNameKey(secret.name) === vaultNameKey(input.name) && sameBots(secret.bots, input.bots) && secret.person === input.person);
    if (same) {
      const { refOnly: _refOnly, ...rest } = same;
      const updated: StoredSecret = { ...rest, value: input.value, updatedAt: at, ...(input.refOnly ? { refOnly: true } : {}) };
      this.write({ ...data, secrets: secrets.map((secret) => secret.id === same.id ? updated : secret) });
      this.secretChanged(same.id);
      return summarizeSecret(updated);
    }
    const secret: StoredSecret = {
      id: randomUUID(), name: input.name, value: input.value, source: input.source, bots: input.bots, ...(input.refOnly ? { refOnly: true } : {}), createdAt: at, updatedAt: at,
      ...(input.person ? { person: input.person } : {}),
    };
    this.write({ ...data, secrets: [...secrets, secret] });
    return summarizeSecret(secret);
  }

  /** A secret arriving from this person's other computer, under the id it has there: an MCP server's `vault:<id>` moves
   * with it. Sent again, it replaces the one it came from; never a member's own (null). */
  receiveSecret(input: Omit<NewSecret, "person"> & { id: string }): VaultSecret | null {
    const data = this.read();
    const secrets = data.secrets ?? [];
    const at = this.now();
    const current = secrets.find((secret) => secret.id === input.id);
    if (current?.person) return null;
    const received: StoredSecret = {
      id: input.id, name: input.name, value: input.value, source: input.source, bots: input.bots, ...(input.refOnly ? { refOnly: true } : {}),
      createdAt: current?.createdAt ?? at, updatedAt: at, ...(current?.lastUsedAt === undefined ? {} : { lastUsedAt: current.lastUsedAt }),
    };
    this.write({ ...data, secrets: current ? secrets.map((secret) => secret.id === input.id ? received : secret) : [...secrets, received] });
    this.secretChanged(input.id);
    return summarizeSecret(received);
  }

  updateSecret(id: string, patch: SecretPatch): VaultSecret | null {
    const data = this.read();
    const current = data.secrets?.find((secret) => secret.id === id);
    if (!data.secrets || !current) return null;
    const next: StoredSecret = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.value === undefined ? {} : { value: patch.value }),
      ...(patch.bots === undefined ? {} : { bots: patch.bots }),
      updatedAt: this.now(),
    };
    this.write({ ...data, secrets: data.secrets.map((secret) => secret.id === id ? next : secret) });
    this.secretChanged(id);
    return summarizeSecret(next);
  }

  removeSecret(id: string): boolean {
    const data = this.read();
    if (!data.secrets?.some((secret) => secret.id === id)) return false;
    this.write({ ...data, secrets: data.secrets.filter((secret) => secret.id !== id) });
    this.secretChanged(id);
    return true;
  }

  /** A member who left the team: every secret of their own goes. */
  forgetPerson(person: string): number {
    const data = this.read();
    const gone = (data.secrets ?? []).filter((secret) => secret.person === person).map((secret) => secret.id);
    if (!gone.length) return 0;
    this.write({ ...data, secrets: data.secrets!.filter((secret) => secret.person !== person) });
    for (const id of gone) this.secretChanged(id);
    return gone.length;
  }

  /** A deleted bot leaves every secret kept to it; a secret kept only to it goes with it. */
  forgetBot(botId: string): void {
    const data = this.read();
    if (!data.secrets) return;
    const touched: string[] = [];
    const at = this.now();
    const secrets = data.secrets.flatMap((secret) => {
      if (secret.bots === "all" || !secret.bots.includes(botId)) return [secret];
      touched.push(secret.id);
      const bots = secret.bots.filter((id) => id !== botId);
      return bots.length ? [{ ...secret, bots, updatedAt: at }] : [];
    });
    if (!touched.length) return;
    this.write({ ...data, secrets });
    for (const id of touched) this.secretChanged(id);
  }

  /** The items this MCP server may read a `vault:<id>` key from. */
  mcpServerKeys(server: string): string[] {
    return this.read().mcpKeys?.[server] ?? [];
  }

  /** The MCP servers given this item's key. */
  serversUsingKey(id: string): string[] {
    return Object.entries(this.read().mcpKeys ?? {}).filter(([, ids]) => ids.includes(id)).map(([server]) => server);
  }

  /** `server` may read these items' `vault:<id>` keys from now on; what it could read before is kept. */
  grantMcpKeys(server: string, ids: readonly string[]): void {
    if (!ids.length) return;
    const data = this.read();
    const { [server]: current = [], ...others } = data.mcpKeys ?? {};
    this.write({ ...data, mcpKeys: { ...others, [server]: [...new Set([...current, ...ids])] } });
  }

  forgetMcpServer(server: string): void {
    const data = this.read();
    if (!data.mcpKeys?.[server]) return;
    const { [server]: _gone, ...others } = data.mcpKeys;
    const { mcpKeys: _keys, ...rest } = data;
    this.write(Object.keys(others).length ? { ...rest, mcpKeys: others } : rest);
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

  onePasswordItemGrants(): Record<string, LoginBots> {
    return this.read().onePasswordItemGrants ?? {};
  }

  /** null hands the item back to its vault's choice. */
  setOnePasswordItemGrant(key: string, bots: LoginBots | null): void {
    const data = this.read();
    const { [key]: _previous, ...others } = data.onePasswordItemGrants ?? {};
    const grants = bots === null ? others : { ...others, [key]: bots };
    const { onePasswordItemGrants: _grants, ...rest } = data;
    this.write(Object.keys(grants).length ? { ...rest, onePasswordItemGrants: grants } : rest);
  }

  secretValues(): string[] {
    const data = this.read();
    return [
      ...data.logins.flatMap((login) => [login.password, ...(login.totp ? [login.totp.secret] : [])]),
      ...(data.onePassword ? [data.onePassword.token] : []),
      ...(data.secrets ?? []).map((secret) => secret.value),
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
    // A submitted form (application/x-www-form-urlencoded) also percent-encodes ! ' ( ) ~, which encodeURIComponent keeps.
    forms.add(new URLSearchParams([["", value]]).toString().slice(1));
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
