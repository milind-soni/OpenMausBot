// A stand-in for @1password/sdk with the SDK's own shapes (createClient → vaults.list, items.list, items.getAll
// with individualResponses): no network, no WebAssembly, only the token it was made with, every call recorded.
import type { OnePasswordSdk } from "../onepassword.ts";

export interface FakeItem {
  id: string;
  title: string;
  category?: string;
  urls: string[];
  username?: string;
  password?: string;
  /** The one-time-password field's value (an otpauth:// address or secret). */
  totp?: string;
  /** items.getAll answers this item with an error. */
  unreadable?: boolean;
}

export function fakeOnePasswordSdk(options: { token: string; vaults: Record<string, { title: string; items: FakeItem[] }>; fail?: () => Error | null }) {
  const calls: string[] = [];
  const field = (id: string, title: string, fieldType: string, value: string | undefined) => value === undefined ? [] : [{ id, title, fieldType, value }];
  const sdk: OnePasswordSdk = {
    createClient: async ({ auth, integrationName }) => {
      calls.push(`createClient ${integrationName}`);
      if (auth !== options.token) throw new Error("error authenticating: invalid service account token");
      const check = () => { const error = options.fail?.(); if (error) throw error; };
      return {
        vaults: { list: async () => { calls.push("vaults.list"); check(); return Object.entries(options.vaults).map(([id, vault]) => ({ id, title: vault.title })); } },
        items: {
          list: async (vaultId) => {
            calls.push(`items.list ${vaultId}`); check();
            return (options.vaults[vaultId]?.items ?? []).map((item) => ({ id: item.id, title: item.title, category: item.category ?? "Login", websites: item.urls.map((url) => ({ url })) }));
          },
          getAll: async (vaultId, itemIds) => {
            calls.push(`items.getAll ${vaultId} ${itemIds.join(",")}`); check();
            return { individualResponses: itemIds.map((id) => {
              const item = options.vaults[vaultId]?.items.find((candidate) => candidate.id === id);
              if (!item) return { error: { type: "itemNotFound" } };
              if (item.unreadable) return { error: { type: "internal" } };
              return { content: { id, fields: [
                ...field("username", "username", "Text", item.username),
                ...field("password", "password", "Concealed", item.password),
                ...field("otp-1", "one-time password", "Totp", item.totp),
              ] } };
            }) };
          },
        },
      };
    },
  };
  return { sdk, calls };
}
