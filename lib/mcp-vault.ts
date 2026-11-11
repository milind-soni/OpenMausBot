import { ConvexError } from "convex/values";
import { decryptSecret, type EncryptedSecret } from "./vaultCrypto";

/** What convex/mcp.ts vaultItem returns for an item agents may use: its summary and the passphrase-sealed value. */
export type SealedVaultItem = { kind: string; service: string | null; env: string[]; sealed: EncryptedSecret } & Record<string, unknown>;

/**
 * Opens a Vault item for vault_get. The Vault is end-to-end encrypted with its passphrase, so the agent passes the
 * passphrase (the agent's "unlocked" Vault); it is used for this call only and never stored or logged. Service sign-ins
 * hold a JSON object of environment variables and come back as `env`; every other kind comes back as `value`.
 */
export async function openVaultItem(item: SealedVaultItem, passphrase?: string) {
  const { sealed, ...summary } = item;
  if (!passphrase) throw new ConvexError(`The Vault is locked. Pass the Vault passphrase to read "${String(summary.name)}".`);
  let plain: string;
  try { plain = await decryptSecret(sealed, passphrase); }
  catch { throw new ConvexError("Wrong Vault passphrase. The Vault stays locked."); }
  if (item.kind === "service") {
    let env: Record<string, string> | null = null;
    try {
      const parsed: unknown = JSON.parse(plain);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every(value => typeof value === "string")) env = parsed as Record<string, string>;
    } catch { /* Not a service object; returned as a plain value below. */ }
    if (env) return { ...summary, env: Object.keys(env), values: env };
  }
  return { ...summary, value: plain };
}
