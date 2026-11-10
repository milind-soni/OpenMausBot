import { createHash } from "node:crypto";

import { browserMatesOf, loginPageCheck, loginPlace, loginSite, type LoginBots, type LoginPlace } from "../shared/logins.ts";
import type { LinkedSecret } from "../shared/vault.ts";
import type { FillCandidate } from "./login-fill.ts";
import { receiveLoginHandoff, type ConnectionHandoffAnswer, type ConnectionHandoffWhat, type LoginHandoffResult } from "./login-handoff.ts";
import type { VaultStore } from "./vault-store.ts";
import type { OnePasswordLogins } from "./onepassword.ts";
import type { LoginRouteDeps } from "./routes/logins.ts";
import { findLinkedSecret, linkedCandidates, linkedSecretNames, linkedSecrets, linkedSites, readLinkedSecret, type VaultProvider } from "./vault/providers.ts";

const linkedItemId = (secretId: string, field: string | undefined) => `linked-${createHash("sha256").update(`${secretId}\0${field ?? ""}`).digest("hex").slice(0, 32)}`;

/** What the bot's browser shows while the person answers a sign-in card. */
export interface ObservedPage {
  host: string;
  /** It has a password box, shown or not yet, or a username or email box: a sign-in page, or its first step. */
  signIn: boolean;
}

const OBSERVE_PAGE = `JSON.stringify({ href: location.href, signIn: Boolean(document.querySelector('input[type="password"], input[type="email"], input[autocomplete~="username"], input[autocomplete~="email"]')) })`;

/** Null when nothing a login could be filled on is open. */
export async function observeSignInPage(engine: (args: string[]) => Promise<Record<string, unknown> | null>): Promise<ObservedPage | null> {
  let value: unknown;
  try { value = (await engine(["eval", OBSERVE_PAGE]))?.result; } catch { return null; }
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const page = value as { href?: unknown; signIn?: unknown } | null;
  if (typeof page?.href !== "string") return null;
  const check = loginPageCheck(page.href);
  return check.ok ? { host: check.pageHost, signIn: page.signIn === true } : null;
}

/** A sign-in page on another site than the card's, which a login saved from the card fills only once the person, shown
 * that host on the card, confirms it: a page the bot chose must not receive a password saved for the site the card names. */
export function cardSignInElsewhere(cardHost: string, observed: ObservedPage | null): string | null {
  return observed?.signIn && loginSite(observed.host) !== loginSite(cardHost) ? observed.host : null;
}

/** Where a login saved from a sign-in card fills: the card's site, the sign-in page open on that site (else the card's
 * own host), and a sign-in page on another site when the person confirmed it. */
export function cardLoginPlace(cardHost: string, observed: ObservedPage | null, confirmedHost: unknown): LoginPlace {
  const onSite = observed?.signIn && loginSite(observed.host) === loginSite(cardHost) ? observed.host : cardHost;
  const elsewhere = cardSignInElsewhere(cardHost, observed);
  return loginPlace(cardHost, [onSite, ...(elsewhere && confirmedHost === elsewhere ? [elsewhere] : [])]);
}

/** Saved logins and secrets, and a linked password manager's, as each bot may use them. A login kept to some bots is
 * filled only where every bot sharing that browser may use it: a sign-in stays in the browser, so a bot sharing it
 * would be signed in as well. */
export class BotLogins {
  readonly store: VaultStore;
  readonly onePassword: OnePasswordLogins;
  readonly providers: readonly VaultProvider[];
  private readonly bots: () => ReadonlyArray<{ id: string; browserProfile?: string | null }>;
  private readonly hold: (value: string) => void;

  /** `hold` masks a value read from a linked manager wherever text crosses to a bot or a transcript. */
  constructor(store: VaultStore, onePassword: OnePasswordLogins, bots: () => ReadonlyArray<{ id: string; browserProfile?: string | null }> = () => [],
    hold: (value: string) => void = () => {}) {
    this.store = store;
    this.onePassword = onePassword;
    this.providers = [onePassword];
    this.bots = bots;
    this.hold = hold;
  }

  /** The bot and every other bot that signs in through its browser: who a login saved from its sign-in card is kept
   * to, since a sign-in there reaches all of them. */
  cardBots(botId: string): string[] {
    return [botId, ...browserMatesOf(this.bots(), botId)];
  }

  /** The desktop main process's private ask for one login, for Send to My Cloud, or for a connection a move carries. */
  receiveHandoff(message: unknown, post: (reply: LoginHandoffResult) => boolean, connections?: (what: ConnectionHandoffWhat) => Promise<ConnectionHandoffAnswer>): boolean {
    return receiveLoginHandoff(message, this.store, post, () => this.onePassword.status().error, connections);
  }

  /** Where each login the bot may use fills, with its username. */
  sitesFor(botId: string): Array<LoginPlace & { username: string }> {
    const bots = this.cardBots(botId);
    return [...this.store.sitesFor(bots), ...this.providers.flatMap((provider) => linkedSites(provider, bots))];
  }

  /** Reads each linked manager's list again if it is older than the manager allows. */
  async fresh(): Promise<void> {
    await Promise.all(this.providers.map((provider) => provider.fresh()));
  }

  /** Secrets are read only when one is filled. */
  async candidates(botId: string, pageHost: string): Promise<FillCandidate[]> {
    await this.fresh();
    const bots = this.cardBots(botId);
    return [
      ...this.store.usableFor(pageHost, bots).map((login): FillCandidate => ({
        id: login.id, site: login.site, hosts: login.hosts, exactHost: login.exactHost, username: login.username, source: login.source,
        secrets: async () => ({ password: login.password, totp: login.totp ?? null }),
      })),
      ...this.providers.flatMap((provider) => linkedCandidates(provider, pageHost, bots)),
    ];
  }

  markUsed(id: string): void {
    this.store.markUsed(id);
    for (const provider of this.providers) provider.markUsed(id);
  }

  linkedSecrets(): LinkedSecret[] {
    return this.providers.flatMap((provider) => linkedSecrets(provider));
  }

  /** The names of the secrets the bot may use, for its prompt: never a value. */
  secretNamesFor(botId: string): Array<{ name: string; refOnly?: true }> {
    const linked = this.providers.flatMap((provider) => linkedSecrets(provider, botId).flatMap((secret) => linkedSecretNames(secret).map(({ name }) => ({ name }))));
    return [...this.store.secretNamesFor(botId), ...linked];
  }

  /** A secret a linked manager holds for the bot by this name, read from it now; its id is safe as a file name. */
  async linkedSecret(name: string, botId: string): Promise<{ id: string; name: string; value: string } | null> {
    await this.fresh();
    const use = findLinkedSecret(this.providers, name, botId);
    if (!use) return null;
    const value = await readLinkedSecret(use);
    this.hold(value);
    return { id: linkedItemId(use.secret.id, use.field), name: use.field ? `${use.secret.name} ${use.field}` : use.secret.name, value };
  }

  /** The linked secret `linkedSecret` gave this id: who may use it, and its value read from the manager when asked. */
  linkedById(id: string): { bots: LoginBots; read(): Promise<string> } | null {
    for (const provider of this.providers) {
      for (const secret of linkedSecrets(provider)) {
        const name = linkedSecretNames(secret).find(({ field }) => linkedItemId(secret.id, field) === id);
        if (!name) continue;
        return { bots: secret.bots, read: async () => {
          const value = await readLinkedSecret({ provider, secret, ...(name.field ? { field: name.field } : {}) });
          this.hold(value);
          return value;
        } };
      }
    }
    return null;
  }

  /** The settings, plus whether a 1Password token is held: what a credential card's "configured" check reads. */
  credentialConfig<T extends object>(config: T): T & { onePassword: { connected: boolean } } {
    return { ...config, onePassword: { connected: Boolean(this.store.onePasswordToken()) } };
  }

  routes(botExists: (id: string) => boolean): LoginRouteDeps {
    return {
      list: () => this.store.list(),
      create: (input) => this.store.create(input),
      update: (id, patch) => this.store.update(id, patch),
      remove: (id) => this.store.remove(id),
      botExists,
      onePassword: {
        status: () => this.onePassword.status(),
        list: () => { void this.onePassword.fresh(); return this.onePassword.list(); },
        connect: async (token) => {
          const status = await this.onePassword.refresh(token);
          this.store.setOnePasswordToken(token);
          return status;
        },
        refresh: () => this.onePassword.refresh(),
        disconnect: () => {
          this.store.setOnePasswordToken(null);
          this.onePassword.clear();
          return this.onePassword.status();
        },
        grant: (vaultId, bots) => {
          if (!this.onePassword.hasVault(vaultId)) return null;
          this.store.setOnePasswordGrant(vaultId, bots);
          return this.onePassword.status();
        },
      },
    };
  }
}
