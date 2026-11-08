/**
 * The Vault: saved logins (shared/logins.ts) and saved secrets, kept
 * encrypted on the computer OpenMausBot runs on. A bot uses a saved secret
 * through a one-use reference or a private file and never sees it. Clients
 * see a saved secret as a list row, never its value.
 */
import { CUSTOM_SECRET_LABEL_MAX } from "./credential-request.ts";
import type { LoginBots } from "./logins.ts";

/** One saved secret as Settings shows it. There is no value field, and no
 * route ever returns one: a saved value is only ever replaced. */
export interface VaultSecret {
  id: string;
  /** What the person or the asking bot called it, such as Stripe secret key. */
  name: string;
  /** A bot's secure card, or Settings. */
  source: "card" | "settings";
  bots: LoginBots;
  /** Given on a card for OpenMausBot's own tools only, so it is never written to a file a bot's commands read. */
  refOnly?: true;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export const VAULT_SECRET_NAME_MAX = CUSTOM_SECRET_LABEL_MAX;
export const SECRET_VALUE_MAX_BYTES = 4_096;

/** The form two secret names are compared in: "Stripe secret key" and "stripe-secret-key" are one name. */
export function vaultNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
