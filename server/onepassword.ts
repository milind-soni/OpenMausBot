// The service account token lives in the sealed login store, never in config.json or a log.
// The official SDK (@1password/sdk, MIT) is a CommonJS wrapper over a 14 MB
// WebAssembly core it reads from beside itself, so it is never bundled: it is
// required on first use, and only when a token exists.
import type { LoginBots, LoginPlace, LoginSummary, OnePasswordStatus, OnePasswordVault } from "../shared/logins.ts";
import { loginMatchesHost, loginSite, loginUsableBy, normalizeLoginHost } from "../shared/logins.ts";
import type { FillCandidate } from "./login-fill.ts";
import { parseTotpKey } from "./totp.ts";

export interface OnePasswordItemFields {
  username: string;
  password: string;
  totp: string | null;
}

export interface OnePasswordClient {
  vaults(): Promise<Array<{ id: string; title: string }>>;
  loginItems(vaultId: string): Promise<Array<{ id: string; title: string; urls: string[] }>>;
  fields(vaultId: string, itemIds: string[]): Promise<Map<string, OnePasswordItemFields>>;
}


interface SdkField { id: string; title: string; fieldType: string; value: string }
interface SdkClient {
  vaults: { list(): Promise<Array<{ id: string; title: string }>> };
  items: {
    list(vaultId: string): Promise<Array<{ id: string; title: string; category: string; websites?: Array<{ url: string }> }>>;
    getAll(vaultId: string, itemIds: string[]): Promise<{ individualResponses: Array<{ content?: { id: string; fields: SdkField[] }; error?: unknown }> }>;
  };
}
export interface OnePasswordSdk {
  createClient(config: { auth: string; integrationName: string; integrationVersion: string }): Promise<SdkClient>;
}

export function loginFields(fields: readonly SdkField[]): OnePasswordItemFields {
  const byId = (id: string) => fields.find((field) => field.id === id && field.value);
  const username = byId("username")
    ?? fields.find((field) => (field.fieldType === "Text" || field.fieldType === "Email") && /user|e-?mail|login/iu.test(field.title) && field.value);
  const password = byId("password") ?? fields.find((field) => field.fieldType === "Concealed" && /pass/iu.test(field.title) && field.value);
  const totp = fields.find((field) => field.fieldType === "Totp" && field.value);
  return { username: username?.value ?? "", password: password?.value ?? "", totp: totp?.value ?? null };
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
    loginItems: async (vaultId) => (await client.items.list(vaultId))
      .filter((item) => item.category === "Login" && (item.websites?.length ?? 0) > 0)
      .map((item) => ({ id: item.id, title: item.title, urls: (item.websites ?? []).map((site) => site.url) })),
    fields: async (vaultId, itemIds) => {
      const found = new Map<string, OnePasswordItemFields>();
      if (!itemIds.length) return found;
      const { individualResponses } = await client.items.getAll(vaultId, itemIds);
      for (const response of individualResponses) if (response.content) found.set(response.content.id, loginFields(response.content.fields));
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

export class OnePasswordLogins {
  private readonly token: () => string | null;
  private readonly connect: (token: string) => Promise<OnePasswordClient>;
  private readonly grants: () => Record<string, LoginBots>;
  private readonly now: () => number;
  private client: { token: string; client: OnePasswordClient } | null = null;
  private entries: Entry[] = [];
  private vaults: Array<Omit<OnePasswordVault, "bots">> = [];
  private items = 0;
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
    return { connected: true, vaults, items: this.items, ...(this.error ? { error: this.error } : {}) };
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
    const run = this.read(token).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    if (!token) this.refreshing = run;
    return run;
  }

  private async read(candidate?: string): Promise<OnePasswordStatus> {
    const token = candidate ?? this.token();
    if (!token) { this.clear(); return this.status(); }
    try {
      const client = await this.clientFor(token);
      const vaults = await client.vaults();
      const entries: Entry[] = [];
      const counted: Array<Omit<OnePasswordVault, "bots">> = [];
      for (const vault of vaults) {
        let items = 0;
        const logins = (await client.loginItems(vault.id)).slice(0, MAX_ITEMS);
        for (let start = 0; start < logins.length; start += FIELDS_BATCH) {
          const batch = logins.slice(start, start + FIELDS_BATCH);
          // The password in this answer is dropped here and read again at fill.
          const fields = await client.fields(vault.id, batch.map((item) => item.id));
          for (const item of batch) {
            const found = fields.get(item.id);
            if (!found?.password) continue;
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
      this.vaults = counted.sort((a, b) => a.title.localeCompare(b.title));
      this.items = counted.reduce((sum, vault) => sum + vault.items, 0);
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
    this.vaults = [];
    this.items = 0;
    this.refreshedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  async fresh(): Promise<void> {
    if (!this.token()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  list(): LoginSummary[] {
    if (!this.token()) return [];
    return this.entries.map((entry) => ({
      id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp, source: "1password",
      bots: this.botsFor(entry.vaultId), createdAt: 0, ...(this.lastUsed.has(entry.itemId) ? { lastUsedAt: this.lastUsed.get(entry.itemId)! } : {}),
    }));
  }

  /** A vault narrowed to other bots is invisible to this one. */
  private usable(botId: string): Entry[] {
    return this.token() ? this.entries.filter((entry) => loginUsableBy({ bots: this.botsFor(entry.vaultId) }, botId)) : [];
  }

  sitesFor(botId: string): Array<LoginPlace & { username: string }> {
    return this.usable(botId).map((entry) => ({ site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username }));
  }

  candidates(pageHost: string, botId: string): FillCandidate[] {
    const token = this.token();
    if (!token) return [];
    return this.usable(botId).filter((entry) => loginMatchesHost(entry, pageHost)).map((entry) => ({
      id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, source: "1password" as const,
      secrets: async () => {
        let found: OnePasswordItemFields | undefined;
        try {
          const client = await this.clientFor(token);
          found = (await client.fields(entry.vaultId, [entry.itemId])).get(entry.itemId);
        } catch (error) {
          this.client = null;
          throw new Error(onePasswordProblem(error));
        }
        if (!found?.password) throw new Error("This login is no longer in 1Password, or has no password there.");
        return { password: found.password, totp: found.totp ? parseTotpKey(found.totp) : null };
      },
    }));
  }

  markUsed(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) this.lastUsed.set(entry.itemId, this.now());
  }
}
