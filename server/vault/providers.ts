// A password manager linked to the Vault adds its items to the same list, by name and site only. A value is read from
// the manager at the moment a bot uses it, never kept or logged, and each item says which bots may use it.
import { loginMatchesHost, loginUsableBy, type LoginPlace, type LoginSummary } from "../../shared/logins.ts";
import { vaultNameKey, type LinkedSecret } from "../../shared/vault.ts";
import type { FillCandidate } from "../login-fill.ts";
import type { TotpKey } from "../totp.ts";

export type LinkedItem = ({ kind: "login" } & LoginSummary) | ({ kind: "secret" } & LinkedSecret);

export interface LinkedValue {
  password?: string;
  totp?: TotpKey | null;
  value?: string;
}

export interface VaultProvider {
  readonly id: string;
  /** Shown to the person and the bot, such as 1Password. */
  readonly label: string;
  /** Reads the manager's list again once it is older than the provider allows. */
  fresh(): Promise<void>;
  /** Every item and the bots that may use it, never a value. */
  items(): LinkedItem[];
  /** A login's password and 2FA key, or a secret's main value (or its `field`), read from the manager now. */
  read(itemId: string, field?: string): Promise<LinkedValue>;
  markUsed(itemId: string): void;
}

function logins(provider: VaultProvider, bots: string | readonly string[]): LoginSummary[] {
  return provider.items().flatMap(({ kind, ...item }) => (kind === "login" && loginUsableBy(item, bots) ? [item as LoginSummary] : []));
}

export function linkedSites(provider: VaultProvider, bots: string | readonly string[]): Array<LoginPlace & { username: string }> {
  return logins(provider, bots).map((login) => ({ site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username }));
}

export function linkedCandidates(provider: VaultProvider, pageHost: string, bots: string | readonly string[]): FillCandidate[] {
  return logins(provider, bots).filter((login) => loginMatchesHost(login, pageHost)).map((login) => ({
    id: login.id, site: login.site, hosts: [...login.hosts], exactHost: login.exactHost, username: login.username, source: login.source,
    secrets: async () => {
      const { password, totp } = await provider.read(login.id);
      if (!password) throw new Error(`This login is no longer in ${provider.label}, or has no password there.`);
      return { password, totp: totp ?? null };
    },
  }));
}

export function linkedSecrets(provider: VaultProvider, botId?: string): LinkedSecret[] {
  return provider.items().flatMap(({ kind, ...item }) => (kind === "secret" && (botId === undefined || loginUsableBy(item, botId)) ? [item as LinkedSecret] : []));
}

/** What a bot asks for a linked secret by: its name for the main value, "<name> <field>" for each other field. */
export function linkedSecretNames(secret: LinkedSecret): Array<{ name: string; field?: string }> {
  return [{ name: secret.name }, ...secret.fields.map((field) => ({ name: `${secret.name} ${field}`, field }))];
}

export interface LinkedSecretUse {
  provider: VaultProvider;
  secret: LinkedSecret;
  field?: string;
}

export function findLinkedSecret(providers: readonly VaultProvider[], name: string, botId: string): LinkedSecretUse | null {
  const key = vaultNameKey(name);
  for (const provider of providers) {
    for (const secret of linkedSecrets(provider, botId)) {
      const found = linkedSecretNames(secret).find((one) => vaultNameKey(one.name) === key);
      if (found) return { provider, secret, ...(found.field ? { field: found.field } : {}) };
    }
  }
  return null;
}

export async function readLinkedSecret({ provider, secret, field }: LinkedSecretUse): Promise<string> {
  const { value } = await provider.read(secret.id, field);
  if (!value) throw new Error(`${secret.name} is no longer in ${provider.label}, or has no value there.`);
  provider.markUsed(secret.id);
  return value;
}
