// What a secure card offers under "Use a saved one": Vault items whose names could fit what the bot asked for, by name
// only. Picking one lets the asking bot use it from then on and answers the card, so nobody types it again.
import { loginMatchesHost, loginUsableBy, type LoginSummary } from "../../shared/logins.ts";
import { vaultNameKey, type VaultChoice } from "../../shared/vault.ts";
import type { VaultStore } from "../vault-store.ts";

/** Words that say what kind of thing it is, not whose: alone they would make every key fit every card. */
const KIND_WORDS = new Set(["a", "an", "the", "my", "of", "for", "to", "and", "api", "key", "keys", "token", "tokens", "secret", "secrets",
  "password", "passwords", "access", "value", "id", "auth", "app", "live", "test", "prod"]);

const CHOICES_MAX = 5;

function nameWords(name: string): Set<string> {
  return new Set(vaultNameKey(name).split(" ").filter((word) => word.length > 1 && !KIND_WORDS.has(word)));
}

/** How many telling words two names share: "Stripe secret key" and STRIPE_LIVE_KEY share one. */
export function nameFit(asked: string, name: string): number {
  const wanted = nameWords(asked);
  let shared = 0;
  for (const word of nameWords(name)) if (wanted.has(word)) shared++;
  return shared;
}

/** The few items that share a telling word with what was asked, closest first. */
export function fittingChoices<T extends { name: string }>(asked: string, items: readonly T[]): T[] {
  return items.map((item) => ({ item, fit: nameFit(asked, item.name) })).filter(({ fit }) => fit > 0)
    .sort((a, b) => b.fit - a.fit || a.item.name.localeCompare(b.item.name)).slice(0, CHOICES_MAX).map(({ item }) => item);
}

type Answer = { status: number; body: Record<string, unknown> };

export interface SignInVaultDeps {
  /** The sign-in card while it still waits in the bot's own browser, else null. */
  openCard(botId: string, threadId: string, messageId: string): { url: string } | null;
  logins: Pick<VaultStore, "list" | "update">;
  /** The bot and every bot that shares its browser: a sign-in there reaches all of them. */
  cardBots(botId: string): string[];
  settle(botId: string, threadId: string, messageId: string, outcome: "done", saved: { site: string }): Answer;
}

/** The sign-in card's "Use a saved login": saved logins for the card's site that the bot may not use yet. */
export function createSignInVaultChoices(deps: SignInVaultDeps) {
  const choices = (botId: string, threadId: string, messageId: string): LoginSummary[] => {
    const card = deps.openCard(botId, threadId, messageId);
    let host = "";
    try { host = card ? new URL(card.url).hostname.toLowerCase() : ""; } catch {}
    if (!host) return [];
    const bots = deps.cardBots(botId);
    return deps.logins.list().filter((login) => loginMatchesHost(login, host) && !loginUsableBy(login, bots)).slice(0, CHOICES_MAX);
  };
  return {
    list(botId: string, threadId: string, messageId: string): Answer {
      const found: VaultChoice[] = choices(botId, threadId, messageId).map((login) => ({ id: login.id, name: login.username || login.site }));
      return { status: 200, body: { choices: found } };
    },
    use(botId: string, threadId: string, messageId: string, loginId: unknown): Answer {
      const login = choices(botId, threadId, messageId).find((one) => one.id === loginId);
      if (!login) return { status: 404, body: { error: "That saved login is gone, or this sign-in request was already answered." } };
      if (login.bots !== "all") deps.logins.update(login.id, { bots: [...new Set([...login.bots, ...deps.cardBots(botId)])] });
      return deps.settle(botId, threadId, messageId, "done", { site: login.site });
    },
  };
}

export type SignInVaultChoices = ReturnType<typeof createSignInVaultChoices>;
