// Bitwarden Secrets Manager in the Vault, through a machine account's access token. Its secrets join the Vault's list by
// name, and a secret whose note names a site is a login: the value is the password. Every value is read from Bitwarden
// at the moment a bot uses it and never kept. The machine account's own projects are the boundary, so its items are for
// every bot.
import type { BitwardenSecretsCredentials, BitwardenSecretsStatus, LoginPlace } from "../../shared/logins.ts";
import { loginSite, normalizeLoginHost } from "../../shared/logins.ts";
import type { LinkedSecret } from "../../shared/vault.ts";
import type { VaultProviderFailure } from "../onepassword.ts";
import { parseTotpKey } from "../totp.ts";
import type { LinkedItem, LinkedValue, VaultProvider } from "../vault/providers.ts";
import { parseAccessToken, SecretsApiError, SecretsManagerClient, type SecretsFetch, type SecretValue } from "./bitwarden-secrets-api.ts";

const ID_PREFIX = "bitwarden-secrets:";
const STALE_MS = 10 * 60_000;
/** Secrets past this many are still listed by name; only these have their notes read for logins. */
const NOTES_MAX = 1_000;
const HOSTS_MAX = 20;
/** A note line naming a login's site (`url:` or `site:`), its username or its 2FA key, as `<word>: <text>`. */
const NOTE_LINE = /^\s*(url|site|username|totp)\s*:\s*(\S.*?)\s*$/iu;

export const BITWARDEN_SECRETS_BAD_TOKEN = "Bitwarden did not accept the access token. Make a new one for the machine account in Secrets Manager → Machine accounts → Access tokens, then connect again.";
const MESSAGES: Record<Exclude<VaultProviderFailure, "refused">, string> = {
  "cant-connect": "Could not reach Bitwarden Secrets Manager. Check the server address and the internet connection, then try again.",
  "rate-limited": "Bitwarden is limiting requests right now. Try again in a few minutes.",
  unreadable: "Bitwarden Secrets Manager could not be read. Try again, or connect it again.",
  unavailable: "Bitwarden Secrets Manager could not be read. Try again, or connect it again.",
};

/** Words for the person and a fixed class for the Admin's report; never what Bitwarden answered. */
export class BitwardenSecretsProblem extends Error {
  readonly failure: VaultProviderFailure;
  constructor(failure: VaultProviderFailure) {
    super(failure === "refused" ? BITWARDEN_SECRETS_BAD_TOKEN : MESSAGES[failure]);
    this.name = "BitwardenSecretsProblem";
    this.failure = failure;
  }
}

function problemOf(error: unknown): BitwardenSecretsProblem {
  if (error instanceof BitwardenSecretsProblem) return error;
  if (!(error instanceof SecretsApiError)) return new BitwardenSecretsProblem("unavailable");
  return new BitwardenSecretsProblem(error.failure === "expired" ? "refused" : error.failure);
}

/** A Secrets Manager reference, `bws://<secret id or name>`. Null for anything else. */
export function parseBitwardenSecretsReference(reference: string): string | null {
  const match = /^bws:\/\/([^/?#]+)$/u.exec(reference.trim());
  return match ? match[1]!.trim() : null;
}

/** What a secret's note says of the login it is: its sign-in hosts, username and whether it has a 2FA key. */
export function loginFromNote(note: string): { hosts: string[]; username: string; totp: string | null } | null {
  const hosts = new Set<string>();
  let username = "";
  let totp: string | null = null;
  for (const line of note.split(/\r?\n/u)) {
    const [, word, text] = NOTE_LINE.exec(line) ?? [];
    if (!word || !text) continue;
    const kind = word.toLowerCase();
    if (kind === "username") username ||= text;
    else if (kind === "totp") totp ??= text;
    else {
      const host = normalizeLoginHost(text);
      if (host && hosts.size < HOSTS_MAX) hosts.add(host);
    }
  }
  return hosts.size ? { hosts: [...hosts], username, totp } : null;
}

interface Entry { secretId: string; name: string; login: boolean }
interface LoginEntry extends LoginPlace { id: string; secretId: string; username: string; hasTotp: boolean }

const hostOf = (serverUrl: string) => { try { return new URL(serverUrl).host; } catch { return serverUrl; } };
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameConnection = (a: BitwardenSecretsCredentials | null, b: BitwardenSecretsCredentials) => a?.serverUrl === b.serverUrl && a.accessToken === b.accessToken;
interface Catalog { logins: LoginEntry[]; entries: Map<string, Entry> }

export class BitwardenSecrets implements VaultProvider {
  readonly id = "bitwarden-secrets";
  readonly label = "Bitwarden Secrets Manager";
  private readonly credentials: () => BitwardenSecretsCredentials | null;
  private readonly fetch: SecretsFetch | undefined;
  private readonly now: () => number;
  private client: { key: string; client: SecretsManagerClient } | null = null;
  private logins: LoginEntry[] = [];
  private entries = new Map<string, Entry>();
  private refreshedAt: number | null = null;
  private error: BitwardenSecretsProblem | undefined;
  private refreshing: Promise<BitwardenSecretsStatus> | null = null;
  /** Bumped by a new connection and by clearing, so a list read before either is never kept. */
  private generation = 0;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: { credentials: () => BitwardenSecretsCredentials | null; fetch?: SecretsFetch; now?: () => number }) {
    this.credentials = options.credentials;
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
  }

  status(): BitwardenSecretsStatus {
    const credentials = this.credentials();
    if (!credentials) return { connected: false };
    return { connected: true, server: hostOf(credentials.serverUrl), items: this.logins.length + [...this.entries.values()].filter((entry) => !entry.login).length,
      ...(this.error ? { error: this.error.message } : {}) };
  }

  /** Why it is not working, as the Admin's report says it. */
  failure(): VaultProviderFailure | undefined {
    return this.credentials() ? this.error?.failure : undefined;
  }

  /** Reads the saved connection's list again. */
  refresh(): Promise<BitwardenSecretsStatus> {
    if (this.refreshing) return this.refreshing;
    const run = this.load().finally(() => { if (this.refreshing === run) this.refreshing = null; });
    this.refreshing = run;
    return run;
  }

  /** Checks a new connection by reading its list; it replaces the current one only once `save` has kept its token. */
  async connect(candidate: BitwardenSecretsCredentials, save: () => void): Promise<BitwardenSecretsStatus> {
    const generation = ++this.generation;
    this.refreshing = null;
    let catalog: Catalog;
    try { catalog = await this.catalog(candidate); }
    catch (error) { throw problemOf(error); }
    // A connection made or cleared meanwhile wins; a connect it overtook keeps nothing.
    if (generation !== this.generation) throw new BitwardenSecretsProblem("unavailable");
    save();
    // A refresh started while this connection was checked read the old one; the next refresh reads this one.
    this.refreshing = null;
    this.publish(catalog);
    return this.status();
  }

  async fresh(): Promise<void> {
    if (!this.credentials()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  clear(): void {
    this.generation++;
    this.refreshing = null;
    this.client = null;
    this.logins = [];
    this.entries = new Map();
    this.refreshedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  /** The client for these credentials, made again when they change; it holds the sign-in in memory only. */
  private clientFor(credentials: BitwardenSecretsCredentials): SecretsManagerClient {
    const token = parseAccessToken(credentials.accessToken);
    if (!token) throw new BitwardenSecretsProblem("refused");
    const key = `${credentials.serverUrl}\0${credentials.accessToken}`;
    if (this.client?.key !== key) this.client = { key, client: new SecretsManagerClient({ serverUrl: credentials.serverUrl, token, ...(this.fetch ? { fetch: this.fetch } : {}), now: this.now }) };
    return this.client.client;
  }

  /** Every listed secret by name; the first NOTES_MAX are read for their notes, which say which are logins. */
  private async catalog(credentials: BitwardenSecretsCredentials): Promise<Catalog> {
    const client = this.clientFor(credentials);
    const names = await client.list();
    // Every value in this answer is dropped here and read again when a bot uses it.
    const notes = new Map((await client.get(names.slice(0, NOTES_MAX).map((secret) => secret.id))).map((secret) => [secret.id, secret.note]));
    const logins: LoginEntry[] = [];
    const entries = new Map<string, Entry>();
    for (const secret of names) {
      const login = loginFromNote(notes.get(secret.id) ?? "");
      entries.set(secret.id, { secretId: secret.id, name: secret.name.trim() || "Untitled", login: Boolean(login) });
      if (!login) continue;
      const sites = new Map<string, string[]>();
      for (const host of login.hosts) sites.set(loginSite(host), [...(sites.get(loginSite(host)) ?? []), host]);
      for (const [site, hosts] of sites) {
        // The username is part of the id, so a login picked before its note named another account is never read as the new one.
        logins.push({ id: `${ID_PREFIX}${secret.id}:${site}:${encodeURIComponent(login.username)}`, secretId: secret.id, site, hosts, exactHost: false, username: login.username, hasTotp: Boolean(parseTotpKey(login.totp)) });
      }
    }
    return { logins: logins.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)), entries };
  }

  private publish(catalog: Catalog): void {
    this.logins = catalog.logins;
    this.entries = catalog.entries;
    this.refreshedAt = this.now();
    this.error = undefined;
  }

  private async load(): Promise<BitwardenSecretsStatus> {
    const credentials = this.credentials();
    if (!credentials) { this.clear(); return this.status(); }
    const generation = this.generation;
    // A list read for a connection that was replaced or cleared meanwhile is never kept.
    const current = () => generation === this.generation && sameConnection(this.credentials(), credentials);
    try {
      const catalog = await this.catalog(credentials);
      if (current()) this.publish(catalog);
    } catch (error) {
      if (current()) this.error = problemOf(error);
    }
    return this.status();
  }

  private async secret(secretId: string): Promise<SecretValue | null> {
    const credentials = this.credentials();
    if (!credentials) return null;
    let found: SecretValue | null;
    try { found = (await this.clientFor(credentials).get([secretId])).find((secret) => secret.id === secretId) ?? null; }
    catch (error) { throw problemOf(error); }
    // Security: a value that arrives after its connection was removed or replaced is dropped.
    return sameConnection(this.credentials(), credentials) ? found : null;
  }

  private secretOf(entry: Entry): LinkedSecret {
    const used = this.lastUsed.get(entry.secretId);
    return { id: `${ID_PREFIX}${entry.secretId}`, name: entry.name, fields: [], source: "linked", provider: this.id, bots: "all", readOnly: true,
      ...(used === undefined ? {} : { lastUsedAt: used }) };
  }

  items(): LinkedItem[] {
    if (!this.credentials()) return [];
    return [
      ...this.logins.map((entry): LinkedItem => {
        const used = this.lastUsed.get(entry.secretId);
        return { kind: "login", id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp,
          source: "bitwarden-secrets", bots: "all", createdAt: 0, ...(used === undefined ? {} : { lastUsedAt: used }) };
      }),
      ...[...this.entries.values()].filter((entry) => !entry.login).sort((a, b) => a.name.localeCompare(b.name)).map((entry): LinkedItem => ({ kind: "secret", ...this.secretOf(entry) })),
    ];
  }

  /** The secret a `bws://` reference names, by id or by name: null for one that names none, or two of the same name. */
  resolve(reference: string): { secret: LinkedSecret } | null {
    const ref = this.credentials() ? parseBitwardenSecretsReference(reference) : null;
    if (!ref) return null;
    const all = [...this.entries.values()];
    const byId = all.filter((entry) => entry.secretId === ref.toLowerCase());
    const found = byId.length ? byId : all.filter((entry) => sameText(entry.name, ref));
    return found.length === 1 ? { secret: this.secretOf(found[0]!) } : null;
  }

  async read(itemId: string): Promise<LinkedValue> {
    const login = this.logins.find((entry) => entry.id === itemId);
    if (login) {
      const secret = await this.secret(login.secretId);
      const note = secret ? loginFromNote(secret.note) : null;
      // Security: the note may name another site or account by now; the password goes only to the site and username it still names.
      if (!secret?.value || note?.username !== login.username || !note.hosts.some((host) => loginSite(host) === login.site)) return {};
      return { password: secret.value, totp: parseTotpKey(note.totp) };
    }
    const id = itemId.startsWith(ID_PREFIX) ? itemId.slice(ID_PREFIX.length) : "";
    if (!this.entries.has(id)) return {};
    const secret = await this.secret(id);
    return secret?.value ? { value: secret.value } : {};
  }

  markUsed(id: string): void {
    const secretId = this.logins.find((entry) => entry.id === id)?.secretId ?? (id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : "");
    if (this.entries.has(secretId)) this.lastUsed.set(secretId, this.now());
  }
}

/** Bitwarden Secrets Manager for this server, read again at start when it is connected. */
export function createBitwardenSecrets(options: { credentials: () => BitwardenSecretsCredentials | null }): BitwardenSecrets {
  const vault = new BitwardenSecrets({ credentials: options.credentials });
  if (options.credentials()) void vault.refresh();
  return vault;
}
