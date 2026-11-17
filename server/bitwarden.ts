// Bitwarden and Vaultwarden vaults are end-to-end encrypted, so they are read through the official Bitwarden CLI (`bw`):
// it logs in with the account's personal API key and unlocks with the master password. Those three live in the sealed
// login store, never in config.json, a log or a command line: each reaches `bw` only through its environment. The CLI
// keeps its own encrypted copy in a folder of ours, apart from any `bw` the person uses themselves.
import { execFile } from "node:child_process";

import type { BitwardenStatus, LoginBots, LoginPlace, LoginSummary, OnePasswordItemRef } from "../shared/logins.ts";
import { loginSite, normalizeLoginHost } from "../shared/logins.ts";
import { parseTotpKey } from "./totp.ts";
import type { LinkedItem, LinkedValue, VaultProvider } from "./vault/providers.ts";

/** What connects to one Bitwarden or Vaultwarden account. */
export interface BitwardenAccount {
  /** The server's address: https://vault.bitwarden.com, https://vault.bitwarden.eu, or a Vaultwarden one. */
  server: string;
  clientId: string;
  clientSecret: string;
  password: string;
}

export const BITWARDEN_DEFAULT_SERVER = "https://vault.bitwarden.com";

/** One item as `bw` prints it, with only what is read here. Types: 1 login, 2 secure note, 3 card, 4 identity. */
export interface BitwardenItem {
  id: string;
  type: number;
  name: string;
  notes?: string | null;
  login?: { username?: string | null; password?: string | null; totp?: string | null; uris?: Array<{ uri?: string | null }> | null } | null;
  /** Custom fields. Types: 0 text, 1 hidden, 2 boolean, 3 linked. */
  fields?: Array<{ name?: string | null; value?: string | null; type: number }> | null;
}

export interface BitwardenClient {
  items(): Promise<BitwardenItem[]>;
  /** null for an item that is gone. */
  item(id: string): Promise<BitwardenItem | null>;
}

export interface BwResult { code: number; stdout: string; stderr: string }
/** Runs `bw` with these arguments and extra environment; rejects only when `bw` could not start. */
export type BwRun = (args: string[], env: Record<string, string>) => Promise<BwResult>;

const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_MAX = 64 * 1024 * 1024;

/** `bw` from PATH, or `bin`. The person's own environment is passed on without any `BW_` value of theirs. */
export function bwRunner(bin = "bw"): BwRun {
  return (args, env) => new Promise((resolve, reject) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BW_")));
    execFile(bin, args, { env: { ...base, BW_NOINTERACTION: "true", BW_NOCOLOR: "true", ...env }, timeout: RUN_TIMEOUT_MS, maxBuffer: OUTPUT_MAX, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code : undefined;
        if (code === "ENOENT" || code === "EACCES") { reject(new BitwardenCliMissingError()); return; }
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

/** `bw` is not on this computer: a fault of this installation, never of the person's key or password. */
export class BitwardenCliMissingError extends Error {
  constructor() {
    super("The Bitwarden command-line tool (bw) is not installed on this computer, so your key was not checked. Install it (npm install -g @bitwarden/cli, or see bitwarden.com/help/cli), then connect again.");
    this.name = "BitwardenCliMissingError";
  }
}

/** A failed `bw` command. Its output stays here for sorting the failure; the person only ever gets bitwardenProblem's words. */
class BwError extends Error {
  readonly output: string;
  constructor(output: string) {
    super("bw failed");
    this.name = "BwError";
    this.output = output;
  }
}

const LOCKED = /vault is locked|not logged in|session key is invalid|you are not logged in/iu;

/** The server address the person typed, as `bw config server` takes it, or null when it is not a plain http(s) address. */
export function bitwardenServer(raw: unknown): string | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return BITWARDEN_DEFAULT_SERVER;
  if (typeof raw !== "string") return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** A client over the `bw` CLI, logged in and unlocked, its session key held only in memory. */
export async function cliBitwardenClient(account: BitwardenAccount, options: { run: BwRun; appDir: string }): Promise<BitwardenClient> {
  const home = { BITWARDENCLI_APPDATA_DIR: options.appDir };
  let queue: Promise<unknown> = Promise.resolve();
  // One `bw` at a time: they share one data folder.
  const bw = (args: string[], env: Record<string, string> = {}): Promise<string> => {
    const run = queue.then(async () => {
      const result = await options.run(args, { ...home, ...env });
      if (result.code !== 0) throw new BwError(`${result.stdout}\n${result.stderr}`);
      return result.stdout;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const status = JSON.parse(await bw(["status"])) as { serverUrl?: string | null; status?: string };
  const server = bitwardenServer(account.server) ?? account.server;
  const sameServer = (status.serverUrl ?? BITWARDEN_DEFAULT_SERVER).replace(/\/+$/u, "") === server;
  // A changed key or server always logs in again, so the folder never holds another account's vault.
  if (status.status !== "unauthenticated") await bw(["logout"]);
  if (!sameServer) await bw(["config", "server", server]);
  await bw(["login", "--apikey"], { BW_CLIENTID: account.clientId, BW_CLIENTSECRET: account.clientSecret });

  let session: string | null = null;
  const unlock = async (): Promise<string> => {
    const key = (await bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { BW_PASSWORD: account.password })).trim();
    if (!key) throw new BwError("unlock gave no session key");
    session = key;
    return key;
  };
  /** A command in the unlocked vault; the CLI locking itself in between is met by unlocking once more. */
  const withSession = async (args: string[]): Promise<string> => {
    try {
      return await bw(args, { BW_SESSION: session ?? await unlock() });
    } catch (error) {
      if (!(error instanceof BwError) || !LOCKED.test(error.output)) throw error;
      return bw(args, { BW_SESSION: await unlock() });
    }
  };

  await unlock();
  return {
    items: async () => {
      await withSession(["sync"]);
      return JSON.parse(await withSession(["list", "items"])) as BitwardenItem[];
    },
    item: async (id) => {
      try {
        return JSON.parse(await withSession(["get", "item", id])) as BitwardenItem;
      } catch (error) {
        if (error instanceof BwError && /not found/iu.test(error.output)) return null;
        throw error;
      }
    },
  };
}

export const BITWARDEN_KEY_REFUSED = "Bitwarden did not accept the API key. Copy client_id and client_secret again from Bitwarden under Settings → Security → Keys → View API key, and connect again.";
export const BITWARDEN_PASSWORD_REFUSED = "That master password did not unlock the Bitwarden vault. Check it and connect again.";

/** Words for the person, never a key, a password or what `bw` printed. */
export function bitwardenProblem(error: unknown): string {
  if (error instanceof BitwardenCliMissingError) return error.message;
  const text = error instanceof BwError ? error.output : error instanceof Error ? error.message : String(error);
  if (/invalid master password|invalid password/iu.test(text)) return BITWARDEN_PASSWORD_REFUSED;
  if (/client_id|client_secret|invalid_client|api key|invalid_grant|unauthori[sz]ed|\b40[13]\b/iu.test(text)) return BITWARDEN_KEY_REFUSED;
  if (/two-step|new device|captcha/iu.test(text)) return "Bitwarden asked for an extra sign-in step. Use the account's personal API key (not the email and password), then connect again.";
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|timed? ?out|certificate|self.signed/iu.test(text)) return "Could not reach the Bitwarden server. Check the server address and the internet connection, then try again.";
  return "Bitwarden could not be read. Try again, or connect it again.";
}

const LOGIN = 1;
const NOTE = 2;
const TEXT = 0;
const HIDDEN = 1;
const ID_PREFIX = "bitwarden:";
const MAX_ITEMS = 500;
const FIELDS_MAX = 20;
const STALE_MS = 10 * 60_000;

/** An item's own custom fields by name; "" is its main value: a secure note's text, or else its first hidden field, or
 * else its first field. A login's username, password and one-time code are never among them. */
export function bitwardenSecretFields(item: BitwardenItem): Map<string, string> {
  const usable = (item.fields ?? []).flatMap((field) => {
    const name = field.name?.trim() ?? "";
    return field.value && name && (field.type === TEXT || field.type === HIDDEN) ? [{ name, value: field.value, hidden: field.type === HIDDEN }] : [];
  });
  const values = new Map<string, string>();
  const note = item.type === NOTE ? item.notes?.trim() : undefined;
  const main = note ? undefined : usable.find((field) => field.hidden) ?? usable[0];
  const mainValue = note || main?.value;
  if (mainValue) values.set("", mainValue);
  for (const field of usable) if (field !== main && !values.has(field.name) && values.size <= FIELDS_MAX) values.set(field.name, field.value);
  return values;
}

function bySite(hosts: Iterable<string>): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const host of hosts) {
    const site = loginSite(host);
    sites.set(site, [...(sites.get(site) ?? []), host]);
  }
  return sites;
}

/** One item's hosts on one site. */
interface Entry extends LoginPlace {
  id: string;
  itemId: string;
  username: string;
  hasTotp: boolean;
}

interface SecretEntry {
  id: string;
  itemId: string;
  name: string;
  fields: string[];
}

export class BitwardenLogins implements VaultProvider {
  readonly id = "bitwarden";
  readonly label = "Bitwarden";
  private readonly account: () => BitwardenAccount | null;
  private readonly connect: (account: BitwardenAccount) => Promise<BitwardenClient>;
  private readonly grants: () => LoginBots;
  private readonly itemGrants: () => Record<string, LoginBots>;
  private readonly now: () => number;
  private client: { account: BitwardenAccount; client: BitwardenClient } | null = null;
  private entries: Entry[] = [];
  private secrets: SecretEntry[] = [];
  private itemCount = 0;
  private refreshedAt: number | null = null;
  private error: string | undefined;
  private refreshing: Promise<BitwardenStatus> | null = null;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: {
    account: () => BitwardenAccount | null; connect: (account: BitwardenAccount) => Promise<BitwardenClient>;
    grants?: () => LoginBots; itemGrants?: () => Record<string, LoginBots>; now?: () => number;
  }) {
    this.account = options.account;
    this.connect = options.connect;
    this.grants = options.grants ?? (() => "all");
    this.itemGrants = options.itemGrants ?? (() => ({}));
    this.now = options.now ?? Date.now;
  }

  /** An item's own bots when it has them, else the account's. */
  private itemAccess(itemId: string): { bots: LoginBots; bitwarden: OnePasswordItemRef } {
    const own = this.itemGrants()[itemId];
    return { bots: own ?? this.grants(), bitwarden: { item: itemId, ownBots: own !== undefined } };
  }

  /** Whether this item is in the vault as a login or a secret, looking again before saying no. */
  async readsItem(itemId: string): Promise<boolean> {
    const reads = () => [...this.entries, ...this.secrets].some((entry) => entry.itemId === itemId);
    if (!this.account()) return false;
    await this.fresh();
    if (reads()) return true;
    await this.refresh();
    return Boolean(this.account()) && reads();
  }

  status(account = this.account()): BitwardenStatus {
    if (!account) return { connected: false };
    return { connected: true, server: bitwardenServer(account.server) ?? account.server, items: this.itemCount, bots: this.grants(), ...(this.error ? { error: this.error } : {}) };
  }

  private async clientFor(account: BitwardenAccount): Promise<BitwardenClient> {
    const same = this.client && (["server", "clientId", "clientSecret", "password"] as const).every((key) => this.client!.account[key] === account[key]);
    if (same) return this.client!.client;
    const client = await this.connect(account);
    this.client = { account, client };
    return client;
  }

  /** Reads the vault again; with `account`, checks that one first and throws the person's words when it fails. */
  refresh(account?: BitwardenAccount): Promise<BitwardenStatus> {
    if (!account && this.refreshing) return this.refreshing;
    const run = this.load(account).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    if (!account) this.refreshing = run;
    return run;
  }

  private async load(candidate?: BitwardenAccount): Promise<BitwardenStatus> {
    const account = candidate ?? this.account();
    if (!account) { this.clear(); return this.status(); }
    try {
      const listed = await (await this.clientFor(account)).items();
      const entries: Entry[] = [];
      const secrets: SecretEntry[] = [];
      let items = 0;
      // Every value in this answer is dropped here and read again when a bot uses it.
      for (const item of listed.filter((one) => one.type === LOGIN || one.type === NOTE).slice(0, MAX_ITEMS)) {
        const fields = bitwardenSecretFields(item);
        if (fields.has("")) secrets.push({ id: `${ID_PREFIX}${item.id}`, itemId: item.id, name: item.name.trim() || "Bitwarden item", fields: [...fields.keys()].filter(Boolean) });
        const login = item.type === LOGIN ? item.login : undefined;
        if (!login?.password) continue;
        const hosts = new Set((login.uris ?? []).flatMap((uri) => normalizeLoginHost(uri.uri) ?? []));
        if (!hosts.size) continue;
        items++;
        for (const [site, siteHosts] of bySite(hosts)) {
          entries.push({ id: `${ID_PREFIX}${item.id}:${site}`, itemId: item.id, site, hosts: siteHosts, exactHost: false,
            username: login.username ?? "", hasTotp: Boolean(login.totp && parseTotpKey(login.totp)) });
        }
      }
      if (candidate) this.lastUsed.clear();
      this.entries = entries.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
      this.secrets = secrets.sort((a, b) => a.name.localeCompare(b.name));
      this.itemCount = items;
      this.refreshedAt = this.now();
      this.error = undefined;
      return this.status(account);
    } catch (error) {
      this.client = null;
      if (candidate) throw new Error(bitwardenProblem(error));
      this.error = bitwardenProblem(error);
      return this.status();
    }
  }

  clear(): void {
    this.client = null;
    this.entries = [];
    this.secrets = [];
    this.itemCount = 0;
    this.refreshedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  async fresh(): Promise<void> {
    if (!this.account()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  private lastUsedOf(itemId: string): { lastUsedAt?: number } {
    const at = this.lastUsed.get(itemId);
    return at === undefined ? {} : { lastUsedAt: at };
  }

  items(): LinkedItem[] {
    if (!this.account()) return [];
    return [
      ...this.entries.map((entry): LinkedItem => ({
        kind: "login", id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp,
        source: "bitwarden", ...this.itemAccess(entry.itemId), createdAt: 0, ...this.lastUsedOf(entry.itemId),
      })),
      ...this.secrets.map((entry): LinkedItem => ({
        kind: "secret", id: entry.id, name: entry.name, fields: [...entry.fields], source: "linked", provider: this.id, ...this.itemAccess(entry.itemId),
        readOnly: true, ...this.lastUsedOf(entry.itemId),
      })),
    ];
  }

  list(): LoginSummary[] {
    return this.items().flatMap(({ kind, ...item }) => (kind === "login" ? [item as LoginSummary] : []));
  }

  private async itemOf(itemId: string): Promise<BitwardenItem | null> {
    const account = this.account();
    if (!account) return null;
    try {
      return await (await this.clientFor(account)).item(itemId);
    } catch (error) {
      this.client = null;
      throw new Error(bitwardenProblem(error));
    }
  }

  async read(id: string, field?: string): Promise<LinkedValue> {
    const login = this.entries.find((entry) => entry.id === id);
    if (login) {
      const item = await this.itemOf(login.itemId);
      if (!item?.login?.password) return {};
      return { password: item.login.password, totp: item.login.totp ? parseTotpKey(item.login.totp) : null };
    }
    const secret = this.secrets.find((entry) => entry.id === id);
    const item = secret && await this.itemOf(secret.itemId);
    if (!item) return {};
    const value = bitwardenSecretFields(item).get(field ?? "");
    return value ? { value } : {};
  }

  markUsed(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id) ?? this.secrets.find((candidate) => candidate.id === id);
    if (entry) this.lastUsed.set(entry.itemId, this.now());
  }
}
