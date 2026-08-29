import { describe, expect, it } from "vitest";

import { AccountDirectory, InMemoryAccountDirectoryStore } from "./account-directory.ts";
import {
  bootstrapAccountDirectory,
  bootstrapAccountDirectoryFromInventory,
  explicitBindingsFromConnectedServices,
  type ConnectedServiceInventory,
} from "./account-directory-bootstrap.ts";

function inventory(overrides: ConnectedServiceInventory = {}): ConnectedServiceInventory {
  return {
    gmail: {
      connected: true,
      pending: false,
      status: "ACTIVE",
      accounts: [{ id: "ca_gmail_1", alias: "Northwind", status: "ACTIVE" }],
    },
    ...overrides,
  };
}

describe("account directory connected-app bootstrap", () => {
  it("imports arbitrary explicit aliases without a fixed identity roster", () => {
    const directory = new AccountDirectory({ ownerId: "install-1" });
    const result = bootstrapAccountDirectory(directory, inventory({
      notion: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_notion_1", alias: "Studio Ops", status: "ACTIVE" }],
      },
    }), { observedAt: "2026-08-28T10:00:00.000Z" });

    expect(result).toMatchObject({ status: "completed", accepted: 2, duplicates: 0 });
    expect(directory.resolve({ ownerId: "install-1", identity: "Studio Ops", provider: "notion" })).toMatchObject({
      status: "resolved",
      accountId: "ca_notion_1",
    });
  });

  it("keeps two explicitly aliased accounts for one provider distinct", () => {
    const directory = new AccountDirectory({ ownerId: "install-1" });
    const result = bootstrapAccountDirectory(directory, inventory({
      gmail: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [
          { id: "ca_gmail_1", alias: "Personal Mail", status: "ACTIVE" },
          { id: "ca_gmail_2", alias: "Work Mail", status: "ACTIVE" },
        ],
      },
    }));

    expect(result.accepted).toBe(2);
    expect(directory.resolve({ ownerId: "install-1", identity: "Personal Mail", provider: "gmail" })).toMatchObject({ status: "resolved", accountId: "ca_gmail_1" });
    expect(directory.resolve({ ownerId: "install-1", identity: "Work Mail", provider: "gmail" })).toMatchObject({ status: "resolved", accountId: "ca_gmail_2" });
  });

  it("fails closed on an ambiguous alias instead of guessing an account", () => {
    const directory = new AccountDirectory({ ownerId: "install-1" });
    bootstrapAccountDirectory(directory, inventory({
      gmail: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [
          { id: "ca_gmail_1", alias: "Same Alias", status: "ACTIVE" },
          { id: "ca_gmail_2", alias: "Same Alias", status: "ACTIVE" },
        ],
      },
    }));

    expect(directory.resolve({ ownerId: "install-1", identity: "Same Alias", provider: "gmail" })).toMatchObject({
      status: "ambiguous",
      candidates: [{ accountId: "ca_gmail_1" }, { accountId: "ca_gmail_2" }],
    });
  });

  it("skips unaliased, pending, and no-auth inventory without inferring identity", () => {
    const { bindings, skipped } = explicitBindingsFromConnectedServices(inventory({
      calendar: {
        connected: true,
        pending: true,
        status: "PENDING",
        accounts: [{ id: "ca_calendar_1", alias: "Calendar", status: "PENDING" }],
      },
      github: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        noAuth: true,
        accounts: [{ id: "ca_github_1", status: "ACTIVE" }],
      },
      slack: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_slack_1", status: "ACTIVE" }],
      },
    }));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.identity).toBe("Northwind");
    expect(skipped).toEqual(expect.arrayContaining([
      { provider: "calendar", accountId: "ca_calendar_1", reason: "not-active" },
      { provider: "github", reason: "no-auth-toolkit" },
      { provider: "slack", accountId: "ca_slack_1", reason: "unaliased-account" },
    ]));
  });

  it("is idempotent and stores only provider references, not credentials", () => {
    const store = new InMemoryAccountDirectoryStore();
    const directory = new AccountDirectory({ ownerId: "install-1", store });
    const source = inventory();
    expect(bootstrapAccountDirectory(directory, source).accepted).toBe(1);
    expect(bootstrapAccountDirectory(directory, source).duplicates).toBe(1);
    expect(JSON.stringify(store.load("install-1"))).not.toMatch(/token|secret|email|display/i);
    expect(store.load("install-1")[0]).toMatchObject({ provider: "gmail", accountId: "ca_gmail_1", source: "connected-app" });
  });

  it("returns a visible failed state when credentials or the inventory service are unavailable", async () => {
    const directory = new AccountDirectory({ ownerId: "install-1" });
    const result = await bootstrapAccountDirectoryFromInventory(directory, async () => {
      throw new Error("Connected apps are unavailable");
    }, { observedAt: "2026-08-28T10:00:00.000Z" });

    expect(result).toEqual({
      status: "failed",
      observedAt: "2026-08-28T10:00:00.000Z",
      accepted: 0,
      duplicates: 0,
      skipped: [],
      rejected: [],
      error: "Connected apps are unavailable",
    });
  });
});
