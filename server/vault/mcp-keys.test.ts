import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultStore } from "../vault-store.ts";
import { createMcpKeys, holdsVaultPointer, vaultPointer } from "./mcp-keys.ts";

const KEY = "sk_test_fake-mcp-key-1";
const LINKED = "linked-" + "a".repeat(32);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(linked: Parameters<typeof createMcpKeys>[0]["linked"] = { fresh: async () => {}, byId: () => null }) {
  const dir = mkdtempSync(join(tmpdir(), "omb-mcp-keys-"));
  dirs.push(dir);
  const store = new VaultStore({ dataDir: dir });
  const keys = createMcpKeys({ store, linked });
  const secret = store.saveSecret({ name: "Stripe secret key", value: KEY, source: "card", bots: ["ledger"], refOnly: true });
  const pointer = vaultPointer(secret.id);
  store.grantMcpKeys("stripe", [secret.id]);
  return { store, keys, secret, pointer };
}

const stdio = (env: Record<string, string>) => ({ command: "npx", args: ["stripe-mcp"], env });
const remote = (headers: Record<string, string>) => ({ type: "http" as const, url: "https://stripe.example/mcp", headers });

describe("a Vault key behind a vault: pointer in an MCP server", () => {
  it("leaves plain values alone, even one that only looks like a pointer", () => {
    const { keys } = setup();
    for (const env of [{ TOKEN: "plain-value" }, { TOKEN: "vault:prod-token" }, { TOKEN: "myvault:" + "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12) }]) {
      const server = stdio(env);
      expect(keys.resolve("stripe", server)).toEqual({ ok: true, server });
    }
  });

  it("reads the value where the server is started, for a bot the item lets use it", () => {
    const { keys, pointer } = setup();
    const server = stdio({ STRIPE_KEY: pointer, OTHER: "kept" });
    expect(keys.resolve("stripe", server, "ledger")).toEqual({ ok: true, server: { ...server, env: { STRIPE_KEY: KEY, OTHER: "kept" } } });
    expect(server.env.STRIPE_KEY).toBe(pointer);
  });

  it("swaps a pointer inside a header, like Bearer vault:…, and an OAuth client secret", () => {
    const { keys, pointer } = setup();
    expect(keys.resolve("stripe", remote({ Authorization: `Bearer ${pointer}` }), "ledger")).toMatchObject({ ok: true, server: { headers: { Authorization: `Bearer ${KEY}` } } });
    expect(keys.oauthClient("stripe", { clientId: "app", clientSecret: pointer })).toEqual({ clientId: "app", clientSecret: KEY });
    expect(keys.oauthClient("other", { clientId: "app", clientSecret: pointer })).toEqual({ clientId: "app" });
  });

  it("reads nothing for a server the pointer was never given to, whatever the text says", () => {
    const { keys, pointer } = setup();
    expect(keys.resolve("evil", remote({ Authorization: pointer }), "ledger")).toMatchObject({ ok: false, reason: "removed" });
  });

  it("is kept from a bot the item does not let use it, and open to the person's own Test", () => {
    const { keys, pointer } = setup();
    const server = stdio({ STRIPE_KEY: pointer });
    expect(keys.resolve("stripe", server, "scout")).toMatchObject({ ok: false, reason: "kept" });
    expect(keys.resolve("stripe", server)).toEqual({ ok: true, server: { ...server, env: { STRIPE_KEY: KEY } } });
  });

  it("turns the key off, and says so, when the item is gone from the Vault", () => {
    const { store, keys, secret, pointer } = setup();
    expect(keys.usedBy(secret.id)).toEqual(["stripe"]);
    store.removeSecret(secret.id);
    expect(keys.resolve("stripe", stdio({ STRIPE_KEY: pointer }), "ledger")).toMatchObject({ ok: false, reason: "removed" });
  });

  it("refuses a header value with a line break, as a saved header would be", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-mcp-keys-"));
    dirs.push(dir);
    const store = new VaultStore({ dataDir: dir });
    const keys = createMcpKeys({ store, linked: { fresh: async () => {}, byId: () => null } });
    const secret = store.saveSecret({ name: "multi", value: "line one\nline two", source: "settings", bots: "all" });
    store.grantMcpKeys("srv", [secret.id]);
    expect(keys.resolve("srv", remote({ "x-key": vaultPointer(secret.id) }))).toMatchObject({ ok: false });
    expect(keys.resolve("srv", stdio({ KEY: vaultPointer(secret.id) }))).toMatchObject({ ok: true, server: { env: { KEY: "line one\nline two" } } });
  });

  it("reads a linked secret only once warmed, and keeps honouring who may use it", async () => {
    const read = vi.fn(async () => "linked-value-fake");
    let bots: "all" | string[] = "all";
    const { store, keys } = setup({ fresh: async () => {}, byId: (id) => (id === LINKED ? { bots, read } : null) });
    store.grantMcpKeys("notion", [LINKED]);
    const server = stdio({ NOTION: vaultPointer(LINKED) });
    expect(keys.resolve("notion", server, "ledger")).toMatchObject({ ok: false, reason: "unread" });
    expect(read).not.toHaveBeenCalled();
    await keys.warm("notion", server);
    expect(keys.resolve("notion", server, "ledger")).toEqual({ ok: true, server: { ...server, env: { NOTION: "linked-value-fake" } } });
    bots = ["scout"];
    expect(keys.resolve("notion", server, "ledger")).toMatchObject({ ok: false, reason: "kept" });
    await keys.warm("notion", server);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not read a linked secret for a server it was not given to", async () => {
    const read = vi.fn(async () => "linked-value-fake");
    const { keys } = setup({ fresh: async () => {}, byId: () => ({ bots: "all", read }) });
    await keys.warm("evil", stdio({ NOTION: vaultPointer(LINKED) }));
    expect(read).not.toHaveBeenCalled();
  });

  it("finds a pointer wherever a bot might have typed one", () => {
    expect(holdsVaultPointer({ env: { KEY: `Bearer ${vaultPointer(LINKED)}` } })).toBe(true);
    expect(holdsVaultPointer({ headers: { a: { secretRef: "secret-ref:ab" } } })).toBe(false);
    expect(holdsVaultPointer("vault:not-an-id")).toBe(false);
  });
});
