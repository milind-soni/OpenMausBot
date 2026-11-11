import { describe, expect, test } from "vitest";
import { openVaultItem } from "./mcp-vault";
import { encryptSecret } from "./vaultCrypto";

const passphrase = "correct horse battery";
const item = async (kind: string, secret: string) => ({ id: "c1", name: "Deploy", kind, service: kind === "service" ? "convex" : null, env: kind === "service" ? ["CONVEX_DEPLOY_KEY"] : [], sealed: await encryptSecret(secret, passphrase) });

describe("vault_get", () => {
  test("stays locked without the passphrase or with a wrong one, and never returns the sealed value", async () => {
    const sealed = await item("api_key", "sk-live-1");
    await expect(openVaultItem(sealed)).rejects.toMatchObject({ data: expect.stringContaining("The Vault is locked") });
    await expect(openVaultItem(sealed, "wrong passphrase")).rejects.toMatchObject({ data: "Wrong Vault passphrase. The Vault stays locked." });
  });

  test("returns the value with the summary, without the envelope", async () => {
    const opened = await openVaultItem(await item("api_key", "sk-live-1"), passphrase);
    expect(opened).toEqual({ id: "c1", name: "Deploy", kind: "api_key", service: null, env: [], value: "sk-live-1" });
  });

  test("service sign-ins come back as environment variables", async () => {
    const opened = await openVaultItem(await item("service", JSON.stringify({ CONVEX_DEPLOY_KEY: "prod:abc" })), passphrase);
    expect(opened).toMatchObject({ kind: "service", env: ["CONVEX_DEPLOY_KEY"], values: { CONVEX_DEPLOY_KEY: "prod:abc" } });
    expect(opened).not.toHaveProperty("sealed");
  });
});
