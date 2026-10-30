// Whose key a decision or an extraction uses, shared by server/decider and server/extractor. The person's own key always
// wins; Cloud's included token goes only to its relay; the engine's OpenRouter key goes only to OpenRouter's own address.
import type { AppConfig } from "../config.ts";
import { deciderCredential, type ServiceCredential } from "../included-services.ts";
import { WORKERS_AI_ACCOUNT_ID } from "./config.ts";
import { OPENROUTER_DEFAULT_BASE_URL } from "./openrouter.ts";
import type { DeciderProvider } from "./types.ts";
import { WORKERS_AI_DEFAULT_BASE_URL } from "./workers-ai.ts";

export interface HelperAccount extends ServiceCredential {
  provider: DeciderProvider;
  /** Workers AI: the Cloudflare account the token belongs to. */
  accountId?: string;
  /** OpenRouter: the decision model's own key, or the engine's from Settings → API keys. */
  keySource?: "own" | "shared";
}

/** The engine's OpenRouter key, only while the decider's OpenRouter address is OpenRouter's own. */
export function sharedOpenRouterKey(cfg: AppConfig): string | undefined {
  const baseUrl = cfg.decider?.openrouterBaseUrl?.trim();
  if (baseUrl && baseUrl !== OPENROUTER_DEFAULT_BASE_URL) return undefined;
  return cfg.openrouter?.key?.trim() || undefined;
}

/** The OpenRouter key the decider uses: its own, else the one under Settings → API keys. */
export function deciderOpenRouterKey(cfg: AppConfig, draft?: string): { token: string; source: "own" | "shared" } | null {
  const own = draft?.trim() || cfg.decider?.openrouterKey?.trim();
  if (own) return { token: own, source: "own" };
  const shared = sharedOpenRouterKey(cfg);
  return shared ? { token: shared, source: "shared" } : null;
}

/** The person's own Workers AI token with its account ID: one without the other is nothing. */
export function workersAiAccount(cfg: AppConfig, draft: { token?: string; accountId?: string } = {}): HelperAccount | null {
  const token = draft.token?.trim() || cfg.decider?.workersAiToken?.trim();
  const accountId = draft.accountId?.trim() || cfg.decider?.workersAiAccountId?.trim();
  if (!token || !accountId || !WORKERS_AI_ACCOUNT_ID.test(accountId)) return null;
  return { provider: "workersai", token, accountId: accountId.toLowerCase(), api: cfg.decider?.workersAiBaseUrl?.trim() || WORKERS_AI_DEFAULT_BASE_URL, included: false };
}

export function jevAccount(cfg: AppConfig, draft?: string): HelperAccount | null {
  const own = draft?.trim() || cfg.decider?.key?.trim();
  if (!own) return null;
  const credential = deciderCredential(own, cfg.decider?.baseUrl);
  return credential ? { ...credential, provider: "jev" } : null;
}

/** Cloud's included relay, a Jev base URL whose `/v1/extract` also extracts. */
export function includedAccount(): HelperAccount | null {
  const credential = deciderCredential(undefined, undefined);
  return credential?.included ? { ...credential, provider: "jev" } : null;
}

export function openrouterAccount(cfg: AppConfig, draft?: string): HelperAccount | null {
  const key = deciderOpenRouterKey(cfg, draft);
  return key ? { provider: "openrouter", token: key.token, api: cfg.decider?.openrouterBaseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL, included: false, keySource: key.source } : null;
}

/** On and usable: the helper models' one switch. An included relay is on unless switched off; an own key once switched on. */
export function helpersOn(cfg: AppConfig, account: HelperAccount | null): boolean {
  if (!account || cfg.decider?.provider === "off") return false;
  return account.included ? cfg.decider?.enabled !== false : cfg.decider?.enabled === true;
}
