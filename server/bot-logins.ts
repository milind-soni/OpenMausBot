import { loginPageCheck, loginPlace, loginSite, type LoginPlace } from "../shared/logins.ts";
import type { FillCandidate } from "./login-fill.ts";
import { receiveLoginHandoff, type ConnectionHandoffAnswer, type ConnectionHandoffWhat, type LoginHandoffResult } from "./login-handoff.ts";
import type { LoginStore } from "./login-store.ts";
import type { OnePasswordLogins } from "./onepassword.ts";
import type { LoginRouteDeps } from "./routes/logins.ts";

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

/** Saved logins and 1Password items, as each bot may use them. */
export class BotLogins {
  readonly store: LoginStore;
  readonly onePassword: OnePasswordLogins;

  constructor(store: LoginStore, onePassword: OnePasswordLogins) {
    this.store = store;
    this.onePassword = onePassword;
  }

  /** The desktop main process's private ask for one login, for Send to My Cloud, or for a connection a move carries. */
  receiveHandoff(message: unknown, post: (reply: LoginHandoffResult) => boolean, connections?: (what: ConnectionHandoffWhat) => Promise<ConnectionHandoffAnswer>): boolean {
    return receiveLoginHandoff(message, this.store, post, () => this.onePassword.status().error, connections);
  }

  /** Where each login the bot may use fills, with its username. */
  sitesFor(botId: string): Array<LoginPlace & { username: string }> {
    return [...this.store.sitesFor(botId), ...this.onePassword.sitesFor(botId)];
  }

  /** Secrets are read only when one is filled. */
  async candidates(botId: string, pageHost: string): Promise<FillCandidate[]> {
    await this.onePassword.fresh();
    return [
      ...this.store.usableFor(pageHost, botId).map((login): FillCandidate => ({
        id: login.id, site: login.site, hosts: login.hosts, exactHost: login.exactHost, username: login.username, source: login.source,
        secrets: async () => ({ password: login.password, totp: login.totp ?? null }),
      })),
      ...this.onePassword.candidates(pageHost, botId),
    ];
  }

  markUsed(id: string): void {
    this.store.markUsed(id);
    this.onePassword.markUsed(id);
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
