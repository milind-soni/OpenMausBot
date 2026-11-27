import { describe, expect, it } from "vitest";

import {
  loadWebhookCredentials,
  removeWebhookCredential,
  saveWebhookCredential,
} from "./webhook-credentials.js";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const credential = {
  endpointUrl: "http://127.0.0.1:8800/hooks/wh_demo",
  secret: "whsec_demo",
  url: "http://127.0.0.1:8800/hooks/wh_demo/whsec_demo",
};

describe("webhook credential storage", () => {
  it("keeps a one-time private URL available after the panel remounts", () => {
    const store = memoryStore();
    saveWebhookCredential(store, "hook-1", credential);
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": credential });
  });

  it("ignores malformed entries and removes deleted webhooks", () => {
    const store = memoryStore();
    store.setItem("omb-webhook-credentials", JSON.stringify({ broken: { url: 3 }, "hook-1": credential }));
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": credential });
    removeWebhookCredential(store, "hook-1");
    expect(loadWebhookCredentials(store)).toEqual({});
  });
});
