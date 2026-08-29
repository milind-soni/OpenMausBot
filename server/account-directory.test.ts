import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AccountDirectory,
  AccountDirectoryError,
  InMemoryAccountDirectoryStore,
  JsonFileAccountDirectoryStore,
  type AccountObservation,
} from "./account-directory.ts";

const ownerId = "installation-1";

function observation(overrides: Partial<AccountObservation> = {}): AccountObservation {
  return {
    ownerId,
    identity: "Personal",
    provider: "gmail",
    accountId: "ca_personal",
    source: "connected-app",
    sourceId: "composio-gmail",
    observedAt: "2026-08-27T12:00:00.000Z",
    evidenceRef: "connected-account:ca_personal",
    ...overrides,
  };
}

describe("AccountDirectory", () => {
  it("resolves a logical identity to the exact provider account ID", () => {
    const directory = new AccountDirectory({ ownerId });
    directory.register(observation());

    expect(directory.resolve({ ownerId, identity: "Personal", provider: "gmail" })).toEqual({
      status: "resolved",
      ownerId,
      identity: "Personal",
      provider: "gmail",
      accountId: "ca_personal",
      sources: [{ kind: "connected-app", sourceId: "composio-gmail" }],
      evidenceRefs: ["connected-account:ca_personal"],
    });
  });

  it("accepts user-defined identity labels and rehydrates through the durable store seam", () => {
    const store = new InMemoryAccountDirectoryStore();
    const firstProcess = new AccountDirectory({ ownerId, store });
    firstProcess.register(observation({ identity: "Northwind Finance", provider: "slack", accountId: "ca_northwind" }));

    const afterRestart = new AccountDirectory({ ownerId, store });
    expect(afterRestart.resolve({ ownerId, identity: "Northwind Finance", provider: "slack" })).toMatchObject({
      status: "resolved",
      accountId: "ca_northwind",
    });
  });

  it("persists mappings atomically and resolves them after close/reopen", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omb-account-directory-")), "accounts.json");
    const firstProcess = new AccountDirectory({ ownerId, store: new JsonFileAccountDirectoryStore(file) });
    firstProcess.register(observation({ identity: "Anvil", provider: "calendar", accountId: "ca_anvil_calendar" }));

    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain('"version": 1');
    expect(onDisk).toContain("ca_anvil_calendar");

    const afterRestart = new AccountDirectory({ ownerId, store: new JsonFileAccountDirectoryStore(file) });
    expect(afterRestart.resolve({ ownerId, identity: "Anvil", provider: "calendar" })).toMatchObject({
      status: "resolved",
      accountId: "ca_anvil_calendar",
    });
  });

  it("fails closed on corrupt JSON without returning its contents in the error", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omb-account-directory-")), "accounts.json");
    const secret = "should-not-appear-in-errors";
    writeFileSync(file, `{"version":1,"owners":{"${ownerId}":[${secret}`);

    let thrown: unknown;
    try {
      new AccountDirectory({ ownerId, store: new JsonFileAccountDirectoryStore(file) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountDirectoryError);
    expect(thrown).toMatchObject({ code: "storage_invalid" });
    expect(String(thrown)).not.toContain(secret);
  });

  it("fails closed on credential-bearing or invalid stored records without leaking values", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omb-account-directory-")), "accounts.json");
    const secret = "refresh-token-value";
    writeFileSync(file, JSON.stringify({
      version: 1,
      owners: {
        [ownerId]: [{
          ...observation(),
          accessToken: secret,
        }],
      },
    }));

    let thrown: unknown;
    try {
      new AccountDirectory({ ownerId, store: new JsonFileAccountDirectoryStore(file) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountDirectoryError);
    expect(thrown).toMatchObject({ code: "storage_invalid" });
    expect(String(thrown)).not.toContain(secret);
  });

  it("combines corroborating connected-app, browser, phone, and local observations", () => {
    const directory = new AccountDirectory({ ownerId });
    directory.register(observation({ source: "connected-app", sourceId: "composio" }));
    directory.register(observation({ source: "browser", sourceId: "chrome-profile-1" }));
    directory.register(observation({ source: "phone", sourceId: "pixel-1" }));
    directory.register(observation({ source: "local", sourceId: "mail-index" }));

    expect(directory.resolve({ ownerId, identity: "Personal", provider: "gmail" })).toMatchObject({
      status: "resolved",
      accountId: "ca_personal",
      sources: [
        { kind: "browser", sourceId: "chrome-profile-1" },
        { kind: "connected-app", sourceId: "composio" },
        { kind: "local", sourceId: "mail-index" },
        { kind: "phone", sourceId: "pixel-1" },
      ],
    });
  });

  it("deduplicates the same observation without weakening the resolution", () => {
    const directory = new AccountDirectory({ ownerId });
    expect(directory.register(observation()).status).toBe("accepted");
    expect(directory.register(observation()).status).toBe("duplicate");
    expect(directory.resolve({ ownerId, identity: "Personal", provider: "GMAIL" }).status).toBe("resolved");
  });

  it("fails closed when different exact account IDs make a mapping ambiguous", () => {
    const directory = new AccountDirectory({ ownerId });
    directory.register(observation());
    directory.register(observation({ accountId: "ca_personal_other", source: "browser", sourceId: "chrome-profile-2" }));

    expect(directory.resolve({ ownerId, identity: "Personal", provider: "gmail" })).toEqual({
      status: "ambiguous",
      ownerId,
      identity: "Personal",
      provider: "gmail",
      candidates: [
        {
          accountId: "ca_personal",
          sources: [{ kind: "connected-app", sourceId: "composio-gmail" }],
          evidenceRefs: ["connected-account:ca_personal"],
        },
        {
          accountId: "ca_personal_other",
          sources: [{ kind: "browser", sourceId: "chrome-profile-2" }],
          evidenceRefs: ["connected-account:ca_personal"],
        },
      ],
    });
  });

  it("rejects observations from another owner before they enter the directory", () => {
    const directory = new AccountDirectory({ ownerId });

    expect(() => directory.register(observation({ ownerId: "another-installation" }))).toThrowError(
      expect.objectContaining({ code: "ownership_mismatch" }),
    );
    expect(directory.snapshot()).toEqual([]);
  });

  it("does not disclose mappings to a caller for another owner", () => {
    const directory = new AccountDirectory({ ownerId });
    directory.register(observation());

    expect(directory.resolve({ ownerId: "another-installation", identity: "Personal", provider: "gmail" })).toEqual({
      status: "forbidden",
      reason: "owner_mismatch",
    });
  });

  it("rejects one provider account from being claimed by two logical identities", () => {
    const directory = new AccountDirectory({ ownerId });
    directory.register(observation());

    expect(() => directory.register(observation({ identity: "SEF", source: "local", sourceId: "sef-config" }))).toThrowError(
      expect.objectContaining({ code: "identity_conflict" }),
    );
    expect(directory.resolve({ ownerId, identity: "SEF", provider: "gmail" })).toEqual({
      status: "not_found",
      ownerId,
      identity: "SEF",
      provider: "gmail",
    });
  });

  it("reconciles explicit slots without guessing from inventory names", () => {
    const directory = new AccountDirectory({ ownerId });
    const result = directory.reconcile([
      { identity: "Personal", provider: "gmail", accountId: "ca_personal", source: "connected-app", sourceId: "gmail-1" },
      { identity: "SEF", provider: "gmail", accountId: "ca_sef", source: "connected-app", sourceId: "gmail-2" },
      { identity: "Personal", provider: "gmail", accountId: "ca_personal", source: "connected-app", sourceId: "gmail-1" },
      { identity: "Personal", provider: "gmail", accountId: "display-name-only", source: "browser", sourceId: "chrome" },
    ]);
    expect(result).toMatchObject({ accepted: 2, duplicates: 1, rejected: [{ reason: expect.stringMatching(/invalid/i) }] });
    expect(directory.findExactAccount({ ownerId, provider: "gmail", accountId: "ca_personal" })).toMatchObject({ identity: "Personal" });
    expect(directory.findExactAccount({ ownerId, provider: "gmail", accountId: "ca_unknown" })).toBeNull();
  });

  it("keeps provider account IDs opaque and does not accept aliases as IDs", () => {
    const directory = new AccountDirectory({ ownerId });
    expect(() => directory.register(observation({ accountId: "personal" }))).toThrowError(
      expect.objectContaining({ code: "invalid_observation" }),
    );
    expect(directory.resolve({ ownerId, identity: "Personal", provider: "gmail" })).toMatchObject({ status: "not_found" });
  });

  it("rejects credential-bearing observations and stores no credential-shaped fields", () => {
    const directory = new AccountDirectory({ ownerId });
    const credentialBearing = {
      ...observation(),
      accessToken: "secret-access-token",
    };

    expect(() => directory.register(credentialBearing)).toThrowError(
      expect.objectContaining({ code: "credentials_not_allowed" }),
    );
    expect(JSON.stringify(directory.snapshot())).not.toContain("secret-access-token");
  });

  it("supports exact-account verification for canonical action adapters", () => {
    const directory = new AccountDirectory({ ownerId });
    directory.register(observation({ identity: "Anvil", provider: "calendar", accountId: "ca_anvil_calendar" }));

    expect(directory.resolveExact({
      ownerId,
      identity: "Anvil",
      provider: "calendar",
      accountId: "ca_anvil_calendar",
    })).toEqual({
      status: "resolved",
      ownerId,
      identity: "Anvil",
      provider: "calendar",
      accountId: "ca_anvil_calendar",
      sources: [{ kind: "connected-app", sourceId: "composio-gmail" }],
      evidenceRefs: ["connected-account:ca_personal"],
    });

    expect(directory.resolveExact({
      ownerId,
      identity: "Anvil",
      provider: "calendar",
      accountId: "ca_wrong",
    })).toMatchObject({ status: "not_found" });
  });

  it("uses typed errors for malformed owner-scoped configuration", () => {
    expect(() => new AccountDirectory({ ownerId: " " })).toThrow(AccountDirectoryError);
  });
});
