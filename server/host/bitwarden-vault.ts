// Bitwarden in the Vault, through its own command line tool (bitwarden-cli.ts). Its logins and secrets join the Vault's
// list by name and site only; every value is read from Bitwarden at the moment a bot uses it and never kept. The
// session key lives in this process's memory alone. Bitwarden has no per-collection bots here: the account's own
// collections are the boundary, so its items are for every bot.
import { join } from "node:path";

import type { BitwardenCredentials, BitwardenStatus, LoginPlace } from "../../shared/logins.ts";
import { loginSite, normalizeLoginHost } from "../../shared/logins.ts";
import type { LinkedSecret } from "../../shared/vault.ts";
import type { VaultProviderFailure } from "../onepassword.ts";
import { parseTotpKey, totpCode } from "../totp.ts";
import type { LinkedItem, LinkedValue, VaultProvider } from "../vault/providers.ts";
import { bitwardenRunner, forgetBitwardenAppData, installBitwardenCli, type BwResult, type BwRun } from "./bitwarden-cli.ts";

const ID_PREFIX = "bitwarden:";
const STALE_MS = 10 * 60_000;
/** `bw sync` asks Bitwarden's server for the whole vault, so it runs at most this often. */
const SYNC_EVERY_MS = 60_000;
const MAX_ITEMS = 1_000;
const FIELDS_MAX = 20;
const LOGIN = 1;
const SECURE_NOTE = 2;
/** What a reference may name besides a custom field: Bitwarden's own fields of an item. */
const BUILT_IN = ["password", "username", "totp", "notes"] as const;
type BuiltIn = typeof BUILT_IN[number];
const DEFAULT_SERVER = "https://vault.bitwarden.com";

interface BwField { name?: string | null; value?: string | null; type?: number }
interface BwItem {
  id: string; name?: string | null; type: number; notes?: string | null; fields?: BwField[] | null;
  login?: { uris?: Array<{ uri?: string | null }> | null; username?: string | null; password?: string | null; totp?: string | null } | null;
}

/** One item, without a single value: what its name and a reference may read. */
interface ItemEntry {
  itemId: string;
  name: string;
  type: number;
  /** Custom fields by name, never one named like a built-in field (a reference reads the built-in). */
  custom: string[];
  /** The custom field the item's name alone reads. */
  main?: string;
  has: Record<BuiltIn, boolean>;
}

interface LoginEntry extends LoginPlace { id: string; itemId: string; username: string; hasTotp: boolean }

export const BITWARDEN_WRONG_PASSWORD = "Bitwarden did not accept the master password. Check it and connect again.";
export const BITWARDEN_BAD_KEY = "Bitwarden did not accept the API key. Copy client_id and client_secret again in Bitwarden's Account settings → Security → Keys → View API key, then connect again.";
const TIMEOUT = "Bitwarden did not answer in time. Try again in a moment.";
const LIMITED = "Bitwarden is limiting requests right now. Try again in a few minutes.";
const LOCKED = "Bitwarden stayed locked. Connect it again with the master password.";
const UNREADABLE = "Bitwarden could not be read. Try again, or connect it again.";
const unreachable = (host: string) => `Could not reach the Bitwarden server at ${host}. Check the address and the internet connection, then try again.`;

/** Words for the person and a fixed class for the Admin's report; never what the tool printed. */
export class BitwardenProblem extends Error {
  readonly failure: VaultProviderFailure;
  /** The session ended or the account was signed out: unlocking again may fix it. */
  readonly relock: boolean;
  /** The item is not in the vault the account sees. */
  readonly gone: boolean;
  constructor(message: string, failure: VaultProviderFailure, options: { relock?: boolean; gone?: boolean } = {}) {
    super(message);
    this.name = "BitwardenProblem";
    this.failure = failure;
    this.relock = options.relock ?? false;
    this.gone = options.gone ?? false;
  }
}

export function bitwardenProblem(result: Pick<BwResult, "code" | "stdout" | "stderr" | "timedOut">, host: string): BitwardenProblem {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut) return new BitwardenProblem(TIMEOUT, "cant-connect");
  if (result.code === 127) return new BitwardenProblem("Bitwarden's command line tool is missing on this computer. Connect again to set it up.", "unavailable");
  if (/invalid master password/iu.test(text)) return new BitwardenProblem(BITWARDEN_WRONG_PASSWORD, "refused");
  if (/client_id or client_secret|invalid_client|invalid client/iu.test(text)) return new BitwardenProblem(BITWARDEN_BAD_KEY, "refused");
  if (/vault is locked|not logged in|unauthenticated/iu.test(text)) return new BitwardenProblem(LOCKED, "unreadable", { relock: true });
  if (/^\s*not found\.?\s*$/imu.test(text)) return new BitwardenProblem("That item is no longer in Bitwarden.", "unreadable", { gone: true });
  if (/too many requests|rate limit|\b429\b/iu.test(text)) return new BitwardenProblem(LIMITED, "rate-limited");
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|network|certificate|UNABLE_TO_VERIFY/iu.test(text)) {
    return new BitwardenProblem(unreachable(host), "cant-connect");
  }
  return new BitwardenProblem(UNREADABLE, "unreadable");
}

/** A Bitwarden reference, `bw://<item id or name>[/<field>]`: the field is password, username, totp, notes or a custom
 * field's name. Null for anything else. */
export function parseBitwardenReference(reference: string): { item: string; field?: string } | null {
  const match = /^bw:\/\/([^/?#]+)(?:\/([^/?#]+))?$/u.exec(reference.trim());
  if (!match) return null;
  return { item: match[1]!.trim(), ...(match[2] ? { field: match[2].trim() } : {}) };
}

/** An https address with no path, query or credentials; null for anything else. */
export function bitwardenServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const hostOf = (serverUrl: string) => { try { return new URL(serverUrl).host; } catch { return serverUrl; } };
const credentialKey = (credentials: BitwardenCredentials) => `${credentials.serverUrl}\0${credentials.clientId}`;

function bySite(hosts: Iterable<string>): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const host of hosts) {
    const site = loginSite(host);
    sites.set(site, [...(sites.get(site) ?? []), host]);
  }
  return sites;
}

function entryOf(item: BwItem): ItemEntry {
  const usable = (item.fields ?? []).filter((field) => field.name?.trim() && field.value && (field.type ?? 0) <= 2);
  const custom: string[] = [];
  for (const field of usable) {
    const name = field.name!.trim();
    if (!BUILT_IN.some((one) => sameText(one, name)) && !custom.some((one) => sameText(one, name)) && custom.length < FIELDS_MAX) custom.push(name);
  }
  const hidden = usable.find((field) => field.type === 1 && custom.includes(field.name!.trim()));
  const notes = Boolean(item.notes?.trim());
  const main = item.type === SECURE_NOTE && notes ? undefined : (hidden?.name?.trim() ?? custom[0]);
  return {
    itemId: item.id, name: item.name?.trim() || "Untitled", type: item.type, custom, ...(main ? { main } : {}),
    has: { password: Boolean(item.login?.password), username: Boolean(item.login?.username), totp: Boolean(item.login?.totp), notes },
  };
}

/** Whether the item's name alone reads something: a Secure Note's text, or a custom field. */
const listedAsSecret = (entry: ItemEntry) => (entry.type === SECURE_NOTE && entry.has.notes) || entry.main !== undefined;

function valueOf(item: BwItem, entry: ItemEntry, field: string | undefined, now: number): string | undefined {
  if (!field) return item.type === SECURE_NOTE && item.notes?.trim() ? item.notes : customValue(item, entry.main);
  const builtIn = BUILT_IN.find((one) => sameText(one, field));
  if (builtIn === "password") return item.login?.password ?? undefined;
  if (builtIn === "username") return item.login?.username ?? undefined;
  if (builtIn === "notes") return item.notes ?? undefined;
  if (builtIn === "totp") {
    const key = parseTotpKey(item.login?.totp);
    return key ? totpCode(key, now) : undefined;
  }
  return customValue(item, field);
}

function customValue(item: BwItem, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return (item.fields ?? []).find((field) => field.name && sameText(field.name, name) && field.value)?.value ?? undefined;
}

export class BitwardenLogins implements VaultProvider {
  readonly id = "bitwarden";
  readonly label = "Bitwarden";
  private readonly credentials: () => BitwardenCredentials | null;
  private readonly run: BwRun;
  private readonly now: () => number;
  private readonly forgetAppData: () => void;
  private session: { key: string; credentials: string } | null = null;
  /** The client_id the tool is signed in with; null once signed out, or when this process has not signed it in yet. */
  private signedInAs: string | null = null;
  private unlocking: Promise<string> | null = null;
  private account: string | undefined;
  private logins: LoginEntry[] = [];
  private entries = new Map<string, ItemEntry>();
  private refreshedAt: number | null = null;
  private syncedAt: number | null = null;
  private error: BitwardenProblem | undefined;
  private refreshing: Promise<BitwardenStatus> | null = null;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: { credentials: () => BitwardenCredentials | null; run: BwRun; now?: () => number; forgetAppData?: () => void }) {
    this.credentials = options.credentials;
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.forgetAppData = options.forgetAppData ?? (() => {});
  }

  status(): BitwardenStatus {
    const credentials = this.credentials();
    if (!credentials) return { connected: false };
    return {
      connected: true, server: hostOf(credentials.serverUrl), ...(this.account ? { account: this.account } : {}),
      items: this.logins.length + [...this.entries.values()].filter(listedAsSecret).length, ...(this.error ? { error: this.error.message } : {}),
    };
  }

  /** Why it is not working, as the Admin's report says it. */
  failure(): VaultProviderFailure | undefined {
    return this.credentials() ? this.error?.failure : undefined;
  }

  refresh(candidate?: BitwardenCredentials): Promise<BitwardenStatus> {
    if (!candidate && this.refreshing) return this.refreshing;
    const run = this.load(candidate).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    if (!candidate) this.refreshing = run;
    return run;
  }

  async fresh(): Promise<void> {
    if (!this.credentials()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  /** Signs the tool out and forgets its settings folder: the account's cached vault goes with it. */
  async disconnect(): Promise<void> {
    if (this.signedInAs !== null || this.session) await this.run(["logout"]).catch(() => null);
    this.clear();
    this.signedInAs = null;
    this.forgetAppData();
  }

  clear(): void {
    this.session = null;
    this.account = undefined;
    this.logins = [];
    this.entries = new Map();
    this.refreshedAt = null;
    this.syncedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  private async load(candidate?: BitwardenCredentials): Promise<BitwardenStatus> {
    const credentials = candidate ?? this.credentials();
    if (!credentials) { this.clear(); return this.status(); }
    try {
      if (candidate) { this.session = null; await this.unlock(candidate, true); }
      await this.sync(credentials, true);
      // Every value in this answer is dropped here and read again when a bot uses it.
      const listed = JSON.parse(await this.call(credentials, ["list", "items"])) as unknown;
      const items = (Array.isArray(listed) ? listed as BwItem[] : []).filter((item) => typeof item?.id === "string" && (item.type === LOGIN || item.type === SECURE_NOTE)).slice(0, MAX_ITEMS);
      const logins: LoginEntry[] = [];
      const entries = new Map<string, ItemEntry>();
      for (const item of items) {
        const entry = entryOf(item);
        entries.set(item.id, entry);
        if (item.type !== LOGIN || !item.login?.password) continue;
        const hosts = new Set((item.login.uris ?? []).flatMap((uri) => normalizeLoginHost(uri.uri) ?? []));
        for (const [site, siteHosts] of bySite(hosts)) {
          logins.push({ id: `${ID_PREFIX}${item.id}:${site}`, itemId: item.id, site, hosts: siteHosts, exactHost: false,
            username: item.login.username ?? "", hasTotp: Boolean(parseTotpKey(item.login.totp)) });
        }
      }
      this.logins = logins.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
      this.entries = entries;
      this.refreshedAt = this.now();
      this.error = undefined;
      return this.status();
    } catch (error) {
      const problem = error instanceof BitwardenProblem ? error : new BitwardenProblem(error instanceof Error ? error.message : UNREADABLE, "unavailable");
      if (candidate) throw problem;
      this.error = problem;
      return this.status();
    }
  }

  /** Signs in with the API key when the tool is signed out (or signed in elsewhere), then unlocks with the master password.
   * `again`: a new connection, so whatever account the tool holds is signed out first. */
  private unlock(credentials: BitwardenCredentials, again = false): Promise<string> {
    if (!again && this.unlocking) return this.unlocking;
    const running = this.unlockNow(credentials, again).finally(() => { if (this.unlocking === running) this.unlocking = null; });
    this.unlocking = running;
    return running;
  }

  private async unlockNow(credentials: BitwardenCredentials, again: boolean): Promise<string> {
    const host = hostOf(credentials.serverUrl);
    const check = (result: BwResult) => { if (result.code !== 0 || result.timedOut) throw bitwardenProblem(result, host); return result.stdout; };
    const before = this.statusOf(check(await this.run(["status"])));
    let signedOut = before.status === "unauthenticated";
    const server = bitwardenServerUrl(before.serverUrl ?? DEFAULT_SERVER);
    const elsewhere = server !== bitwardenServerUrl(credentials.serverUrl) || (this.signedInAs !== null && this.signedInAs !== credentials.clientId);
    if (!signedOut && (again || elsewhere)) {
      await this.run(["logout"]);
      this.signedInAs = null;
      signedOut = true;
    }
    if (signedOut) {
      check(await this.run(["config", "server", credentials.serverUrl]));
      check(await this.run(["login", "--apikey"], { BW_CLIENTID: credentials.clientId, BW_CLIENTSECRET: credentials.clientSecret }));
      this.signedInAs = credentials.clientId;
    }
    const key = check(await this.run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { BW_PASSWORD: credentials.password })).trim();
    if (!key) throw new BitwardenProblem(LOCKED, "unreadable");
    this.session = { key, credentials: credentialKey(credentials) };
    this.signedInAs = credentials.clientId;
    const after = await this.run(["status"], { BW_SESSION: key });
    if (after.code === 0) this.account = this.statusOf(after.stdout).userEmail ?? undefined;
    return key;
  }

  private statusOf(text: string): { status?: string; serverUrl?: string | null; userEmail?: string | null } {
    try { return JSON.parse(text) as { status?: string; serverUrl?: string | null; userEmail?: string | null }; }
    catch { return {}; }
  }

  /** One call with the session, unlocking again once if the session ended. */
  private async call(credentials: BitwardenCredentials, args: string[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const key = this.session?.credentials === credentialKey(credentials) ? this.session.key : await this.unlock(credentials);
      const result = await this.run(args, { BW_SESSION: key });
      if (result.code === 0 && !result.timedOut) return result.stdout;
      const problem = bitwardenProblem(result, hostOf(credentials.serverUrl));
      if (!problem.relock || attempt > 0) throw problem;
      this.session = null;
    }
  }

  private async sync(credentials: BitwardenCredentials, force = false): Promise<void> {
    if (!force && this.syncedAt !== null && this.now() - this.syncedAt < SYNC_EVERY_MS) return;
    await this.call(credentials, ["sync"]);
    this.syncedAt = this.now();
  }

  private async item(itemId: string): Promise<BwItem | null> {
    const credentials = this.credentials();
    if (!credentials) return null;
    await this.sync(credentials);
    try { return JSON.parse(await this.call(credentials, ["get", "item", itemId])) as BwItem; }
    catch (error) {
      if (error instanceof BitwardenProblem && !error.gone) throw error;
      return null;
    }
  }

  private secretOf(entry: ItemEntry): LinkedSecret {
    const used = this.lastUsed.get(entry.itemId);
    return { id: `${ID_PREFIX}${entry.itemId}`, name: entry.name, fields: entry.custom.filter((name) => name !== entry.main), source: "linked", provider: this.id,
      bots: "all", readOnly: true, ...(used === undefined ? {} : { lastUsedAt: used }) };
  }

  items(): LinkedItem[] {
    if (!this.credentials()) return [];
    return [
      ...this.logins.map((entry): LinkedItem => {
        const used = this.lastUsed.get(entry.itemId);
        return { kind: "login", id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp,
          source: "bitwarden", bots: "all", createdAt: 0, ...(used === undefined ? {} : { lastUsedAt: used }) };
      }),
      ...[...this.entries.values()].filter(listedAsSecret).sort((a, b) => a.name.localeCompare(b.name)).map((entry): LinkedItem => ({ kind: "secret", ...this.secretOf(entry) })),
    ];
  }

  /** The item a `bw://` reference names, by id or by name: null for one that names no item, more than one (two items of
   * the same name), or a field the item does not have. */
  resolve(reference: string): { secret: LinkedSecret; field: string } | null {
    const ref = this.credentials() ? parseBitwardenReference(reference) : null;
    if (!ref) return null;
    const all = [...this.entries.values()];
    const byId = all.filter((entry) => entry.itemId === ref.item);
    const found = byId.length ? byId : all.filter((entry) => sameText(entry.name, ref.item));
    if (found.length !== 1) return null;
    const entry = found[0]!;
    const asked = ref.field ?? (entry.type === LOGIN ? "password" : "notes");
    const builtIn = BUILT_IN.find((one) => sameText(one, asked));
    if (builtIn) return entry.has[builtIn] ? { secret: this.secretOf(entry), field: builtIn } : null;
    const custom = entry.custom.find((name) => sameText(name, asked));
    return custom ? { secret: this.secretOf(entry), field: custom } : null;
  }

  async read(itemId: string, field?: string): Promise<LinkedValue> {
    const login = this.logins.find((entry) => entry.id === itemId);
    if (login) {
      const item = await this.item(login.itemId);
      if (!item?.login?.password) return {};
      return { password: item.login.password, totp: parseTotpKey(item.login.totp) };
    }
    const id = itemId.startsWith(ID_PREFIX) ? itemId.slice(ID_PREFIX.length) : "";
    const entry = this.entries.get(id);
    if (!entry) return {};
    const item = await this.item(id);
    const value = item ? valueOf(item, entry, field, this.now()) : undefined;
    return value ? { value } : {};
  }

  markUsed(id: string): void {
    const itemId = this.logins.find((entry) => entry.id === id)?.itemId ?? (id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : "");
    if (this.entries.has(itemId)) this.lastUsed.set(itemId, this.now());
  }
}

export function isBitwardenLoginId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** Bitwarden for this server: the tool is fetched into `<data>/tools/bitwarden` the first time it is needed, and keeps
 * its own settings and the account's encrypted copy of the vault beside it, which no backup or move carries. */
export function createBitwardenVault(options: { dataDir: string; credentials: () => BitwardenCredentials | null }): BitwardenLogins {
  const appDataDir = join(options.dataDir, "tools", "bitwarden", "account");
  const vault = new BitwardenLogins({
    credentials: options.credentials,
    run: bitwardenRunner({ executable: () => installBitwardenCli({ dataDir: options.dataDir }), appDataDir }),
    forgetAppData: () => forgetBitwardenAppData(appDataDir),
  });
  if (options.credentials()) void vault.refresh();
  return vault;
}
