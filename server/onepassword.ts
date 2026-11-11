// The service account token lives in the sealed login store, never in config.json or a log.
// The official SDK (@1password/sdk, MIT) is a CommonJS wrapper over a 14 MB
// WebAssembly core it reads from beside itself, so it is never bundled: it is
// required on first use, and only when a token exists.
import type { LoginBots, LoginPlace, LoginSummary, OnePasswordStatus, OnePasswordVault } from "../shared/logins.ts";
import { loginSite, normalizeLoginHost } from "../shared/logins.ts";
import { parseTotpKey } from "./totp.ts";
import type { LinkedItem, LinkedValue, VaultProvider } from "./vault/providers.ts";

export interface OnePasswordItemFields {
  username: string;
  password: string;
  totp: string | null;
}

interface SdkField { id: string; title: string; fieldType: string; value: string }
export interface OnePasswordItemContent { fields: SdkField[]; notes?: string }

export interface OnePasswordClient {
  vaults(): Promise<Array<{ id: string; title: string }>>;
  items(vaultId: string): Promise<Array<{ id: string; title: string; category: string; urls: string[] }>>;
  contents(vaultId: string, itemIds: string[]): Promise<Map<string, OnePasswordItemContent>>;
}

interface SdkClient {
  vaults: { list(): Promise<Array<{ id: string; title: string }>> };
  items: {
    list(vaultId: string): Promise<Array<{ id: string; title: string; category: string; websites?: Array<{ url: string }> }>>;
    getAll(vaultId: string, itemIds: string[]): Promise<{ individualResponses: Array<{ content?: { id: string; fields: SdkField[]; notes?: string }; error?: unknown }> }>;
  };
}
export interface OnePasswordSdk {
  createClient(config: { auth: string; integrationName: string; integrationVersion: string }): Promise<SdkClient>;
}

function loginFieldsOf(fields: readonly SdkField[]): { username?: SdkField; password?: SdkField; totp?: SdkField } {
  const byId = (id: string) => fields.find((field) => field.id === id && field.value);
  const username = byId("username")
    ?? fields.find((field) => (field.fieldType === "Text" || field.fieldType === "Email") && /user|e-?mail|login/iu.test(field.title) && field.value);
  const password = byId("password") ?? fields.find((field) => field.fieldType === "Concealed" && /pass/iu.test(field.title) && field.value);
  const totp = fields.find((field) => field.fieldType === "Totp" && field.value);
  return { username, password, totp };
}

export function loginFields(fields: readonly SdkField[]): OnePasswordItemFields {
  const { username, password, totp } = loginFieldsOf(fields);
  return { username: username?.value ?? "", password: password?.value ?? "", totp: totp?.value ?? null };
}

/** The 1Password categories (SDK ItemCategory) whose items are secrets rather than logins. */
const SECRET_CATEGORIES = new Set(["ApiCredentials", "Password", "SecureNote"]);
const MAIN_FIELD: Record<string, string> = { ApiCredentials: "credential", Password: "password" };
const FIELDS_MAX = 20;

/** A secret item's values by field title, with "" for its main one: an API Credential's credential, a Password's
 * password, a Secure Note's text, or else its first concealed field, or else its first field. */
export function secretFields(category: string, content: OnePasswordItemContent): Map<string, string> {
  const values = new Map<string, string>();
  const usable = content.fields.filter((field) => field.value && (field.fieldType === "Concealed" || field.fieldType === "Text"));
  const note = category === "SecureNote" ? content.notes : undefined;
  const main = note ? undefined
    : usable.find((field) => field.id === MAIN_FIELD[category]) ?? usable.find((field) => field.fieldType === "Concealed") ?? usable[0];
  const mainValue = note || main?.value;
  if (mainValue) values.set("", mainValue);
  for (const field of usable) {
    const title = field.title.trim();
    if (field !== main && title && !values.has(title) && values.size <= FIELDS_MAX) values.set(title, field.value);
  }
  return values;
}

/** A Login item's own extra fields, such as a client ID and secret, by title, never its username, password or one-time
 * code; "" is the first concealed one, or else the first, so the item's name alone reads it too. */
export function loginExtraFields(content: OnePasswordItemContent): Map<string, string> {
  const { username, password } = loginFieldsOf(content.fields);
  const extra = content.fields.filter((field) => field !== username && field !== password
    && field.value && field.title.trim() && (field.fieldType === "Concealed" || field.fieldType === "Text"));
  const values = new Map<string, string>();
  const main = extra.find((field) => field.fieldType === "Concealed") ?? extra[0];
  if (main) values.set("", main.value);
  for (const field of extra) if (!values.has(field.title.trim()) && values.size <= FIELDS_MAX) values.set(field.title.trim(), field.value);
  return values;
}

/** What a bot may read from an item as a secret: a Login's extra fields, or a secret item's fields. */
function secretValues(category: string, content: OnePasswordItemContent): Map<string, string> {
  return category === "Login" ? loginExtraFields(content) : secretFields(category, content);
}

/** The SDK did not load: a fault in this installation, never in the person's token, which was not even checked. */
export class OnePasswordUnavailableError extends Error {
  constructor() {
    super("1Password could not start on this server, so your token was not checked: this installation is missing its 1Password part. Update OpenMausBot, then connect again.");
    this.name = "OnePasswordUnavailableError";
  }
}

/** Why the SDK did not load goes to the server log for whoever reads it; the person gets the plain words. */
export function onePasswordUnavailable(error: unknown, log: (line: string) => void = (line) => console.warn(line)): OnePasswordUnavailableError {
  log(`1Password: the SDK did not load: ${(error instanceof Error ? error.message : String(error)).split("\n", 1)[0]}`);
  return new OnePasswordUnavailableError();
}

export async function sdkOnePasswordClient(sdk: OnePasswordSdk, token: string, version: string): Promise<OnePasswordClient> {
  const client = await sdk.createClient({ auth: token, integrationName: "OpenMausBot", integrationVersion: version });
  return {
    vaults: async () => (await client.vaults.list()).map((vault) => ({ id: vault.id, title: vault.title })),
    items: async (vaultId) => (await client.items.list(vaultId))
      .map((item) => ({ id: item.id, title: item.title, category: item.category, urls: (item.websites ?? []).map((site) => site.url) })),
    contents: async (vaultId, itemIds) => {
      const found = new Map<string, OnePasswordItemContent>();
      if (!itemIds.length) return found;
      const { individualResponses } = await client.items.getAll(vaultId, itemIds);
      for (const { content } of individualResponses) if (content) found.set(content.id, { fields: content.fields, ...(content.notes ? { notes: content.notes } : {}) });
      return found;
    },
  };
}


/** One item's website hosts on one site. */
interface Entry extends LoginPlace {
  id: string;
  vaultId: string;
  itemId: string;
  username: string;
  hasTotp: boolean;
}

interface SecretEntry {
  id: string;
  vaultId: string;
  itemId: string;
  category: string;
  name: string;
  fields: string[];
}

const isLogin = (item: { category: string; urls: string[] }) => item.category === "Login" && item.urls.length > 0;

const ID_PREFIX = "1password:";
const MAX_ITEMS = 500;
const FIELDS_BATCH = 50;
const STALE_MS = 10 * 60_000;

export function isOnePasswordLoginId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

function bySite(hosts: Iterable<string>): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const host of hosts) {
    const site = loginSite(host);
    sites.set(site, [...(sites.get(site) ?? []), host]);
  }
  return sites;
}

export const ONE_PASSWORD_MALFORMED = "That is not a whole 1Password service account token. Copy all of it (it starts with ops_ and is very long), or make a new one in 1Password under Developer → Service accounts.";
export const ONE_PASSWORD_REFUSED = "1Password did not accept the token: it may have been revoked, expired, or lost access to its vault. Make a new service account token in 1Password and paste it here.";

/** Words for the person, never the token. A fault of this installation is never blamed on the token. */
export function onePasswordProblem(error: unknown): string {
  if (error instanceof OnePasswordUnavailableError) return error.message;
  const name = error instanceof Error ? error.name : "";
  const text = error instanceof Error ? error.message : String(error);
  if (name === "RateLimitExceededError" || /rate limit/iu.test(text)) return "1Password is limiting requests right now. Try again in a few minutes.";
  if (/invalid format|deserializ/iu.test(text)) return ONE_PASSWORD_MALFORMED;
  if (name === "AuthExpiredError" || /invalid|unauthori[sz]ed|authenticat|service account token|forbidden|\b40[13]\b/iu.test(text)) return ONE_PASSWORD_REFUSED;
  if (/fetch|network|ENOTFOUND|ECONN|timed? ?out|dns/iu.test(text)) return "Could not reach 1Password. Check the internet connection and try again.";
  return "1Password could not be read. Try again, or connect it again with a new token.";
}

export class OnePasswordLogins implements VaultProvider {
  readonly id = "1password";
  readonly label = "1Password";
  private readonly token: () => string | null;
  private readonly connect: (token: string) => Promise<OnePasswordClient>;
  private readonly grants: () => Record<string, LoginBots>;
  private readonly now: () => number;
  private client: { token: string; client: OnePasswordClient } | null = null;
  private entries: Entry[] = [];
  private secrets: SecretEntry[] = [];
  private vaults: Array<Omit<OnePasswordVault, "bots">> = [];
  private itemCount = 0;
  private refreshedAt: number | null = null;
  private error: string | undefined;
  private refreshing: Promise<OnePasswordStatus> | null = null;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: { token: () => string | null; connect: (token: string) => Promise<OnePasswordClient>; grants?: () => Record<string, LoginBots>; now?: () => number }) {
    this.token = options.token;
    this.connect = options.connect;
    this.grants = options.grants ?? (() => ({}));
    this.now = options.now ?? Date.now;
  }

  private botsFor(vaultId: string): LoginBots {
    return this.grants()[vaultId] ?? "all";
  }

  private connected(): OnePasswordStatus {
    const vaults: OnePasswordVault[] = this.vaults.map((vault) => ({ ...vault, bots: this.botsFor(vault.id) }));
    return { connected: true, vaults, items: this.itemCount, ...(this.error ? { error: this.error } : {}) };
  }

  status(): OnePasswordStatus {
    return this.token() ? this.connected() : { connected: false };
  }

  hasVault(id: string): boolean {
    return Boolean(this.token()) && this.vaults.some((vault) => vault.id === id);
  }

  private async clientFor(token: string): Promise<OnePasswordClient> {
    if (this.client?.token === token) return this.client.client;
    const client = await this.connect(token);
    this.client = { token, client };
    return client;
  }

  refresh(token?: string): Promise<OnePasswordStatus> {
    if (!token && this.refreshing) return this.refreshing;
    const run = this.load(token).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    if (!token) this.refreshing = run;
    return run;
  }

  private async load(candidate?: string): Promise<OnePasswordStatus> {
    const token = candidate ?? this.token();
    if (!token) { this.clear(); return this.status(); }
    try {
      const client = await this.clientFor(token);
      const vaults = await client.vaults();
      const entries: Entry[] = [];
      const secrets: SecretEntry[] = [];
      const counted: Array<Omit<OnePasswordVault, "bots">> = [];
      for (const vault of vaults) {
        let items = 0;
        const wanted = (await client.items(vault.id)).filter((item) => item.category === "Login" || SECRET_CATEGORIES.has(item.category)).slice(0, MAX_ITEMS);
        for (let start = 0; start < wanted.length; start += FIELDS_BATCH) {
          const batch = wanted.slice(start, start + FIELDS_BATCH);
          // Every value in this answer is dropped here and read again when a bot uses it.
          const contents = await client.contents(vault.id, batch.map((item) => item.id));
          for (const item of batch) {
            const content = contents.get(item.id);
            if (!content) continue;
            const fields = secretValues(item.category, content);
            if (fields.has("")) secrets.push({ id: `${ID_PREFIX}${vault.id}:${item.id}`, vaultId: vault.id, itemId: item.id, category: item.category, name: item.title.trim() || item.category,
              fields: [...fields.keys()].filter(Boolean) });
            if (!isLogin(item)) continue;
            const found = loginFields(content.fields);
            if (!found.password) continue;
            items++;
            for (const [site, hosts] of bySite(new Set(item.urls.flatMap((url) => normalizeLoginHost(url) ?? [])))) {
              entries.push({ id: `${ID_PREFIX}${vault.id}:${item.id}:${site}`, vaultId: vault.id, itemId: item.id, site, hosts, exactHost: false,
                username: found.username, hasTotp: Boolean(found.totp && parseTotpKey(found.totp)) });
            }
          }
        }
        counted.push({ id: vault.id, title: vault.title, items });
      }
      this.entries = entries.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
      this.secrets = secrets.sort((a, b) => a.name.localeCompare(b.name));
      this.vaults = counted.sort((a, b) => a.title.localeCompare(b.title));
      this.itemCount = counted.reduce((sum, vault) => sum + vault.items, 0);
      this.refreshedAt = this.now();
      this.error = undefined;
      return this.connected();
    } catch (error) {
      this.client = null;
      if (candidate) throw new Error(onePasswordProblem(error));
      this.error = onePasswordProblem(error);
      return this.status();
    }
  }

  clear(): void {
    this.client = null;
    this.entries = [];
    this.secrets = [];
    this.vaults = [];
    this.itemCount = 0;
    this.refreshedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  async fresh(): Promise<void> {
    if (!this.token()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  private lastUsedOf(itemId: string): { lastUsedAt?: number } {
    const at = this.lastUsed.get(itemId);
    return at === undefined ? {} : { lastUsedAt: at };
  }

  items(): LinkedItem[] {
    if (!this.token()) return [];
    return [
      ...this.entries.map((entry): LinkedItem => ({
        kind: "login", id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp,
        source: "1password", bots: this.botsFor(entry.vaultId), createdAt: 0, ...this.lastUsedOf(entry.itemId),
      })),
      ...this.secrets.map((entry): LinkedItem => ({
        kind: "secret", id: entry.id, name: entry.name, fields: [...entry.fields], source: "linked", provider: this.id, bots: this.botsFor(entry.vaultId),
        readOnly: true, ...this.lastUsedOf(entry.itemId),
      })),
    ];
  }

  list(): LoginSummary[] {
    return this.items().flatMap(({ kind, ...item }) => (kind === "login" ? [item as LoginSummary] : []));
  }

  private async contentOf(vaultId: string, itemId: string): Promise<OnePasswordItemContent | undefined> {
    const token = this.token();
    if (!token) return undefined;
    try {
      const client = await this.clientFor(token);
      return (await client.contents(vaultId, [itemId])).get(itemId);
    } catch (error) {
      this.client = null;
      throw new Error(onePasswordProblem(error));
    }
  }

  async read(itemId: string, field?: string): Promise<LinkedValue> {
    const login = this.entries.find((entry) => entry.id === itemId);
    if (login) {
      const content = await this.contentOf(login.vaultId, login.itemId);
      if (!content) return {};
      const found = loginFields(content.fields);
      return { password: found.password, totp: found.totp ? parseTotpKey(found.totp) : null };
    }
    const secret = this.secrets.find((entry) => entry.id === itemId);
    const content = secret && await this.contentOf(secret.vaultId, secret.itemId);
    if (!secret || !content) return {};
    const value = secretValues(secret.category, content).get(field ?? "");
    return value ? { value } : {};
  }

  markUsed(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id) ?? this.secrets.find((candidate) => candidate.id === id);
    if (entry) this.lastUsed.set(entry.itemId, this.now());
  }
}
