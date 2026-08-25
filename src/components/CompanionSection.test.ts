import { describe, expect, it } from "vitest";

import type { CompanionAccountState } from "../types/ogb";
import {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
} from "./CompanionSection";

const account = (status: CompanionAccountState["status"], message?: string): CompanionAccountState => ({
  available: true,
  status,
  message,
});

describe("companion account action errors", () => {
  it("shows retry and sign-out failures while the account remains signed in", () => {
    expect(companionAccountActionError(account("ready"), "Sign out could not finish")).toBe(
      "Sign out could not finish",
    );
    expect(companionAccountActionError(account("error"), "Retry could not finish")).toBe(
      "Retry could not finish",
    );
  });

  it("uses account messages only as the signed-out fallback", () => {
    expect(companionAccountActionError(account("signed-out", "Enter a valid email"), null)).toBe(
      "Enter a valid email",
    );
    expect(companionAccountActionError(account("error", "Secure connection needs attention"), null)).toBeNull();
  });
});

describe("companion status refresh", () => {
  it("keeps account refreshes when the local Companion status fails", async () => {
    const remoteAccount = account("signed-out", "Email a code");
    const refreshed = await loadCompanionBridgeState(
      { state: () => Promise.reject(new Error("sidecar unavailable")) },
      { state: () => Promise.resolve(remoteAccount) },
    );

    expect(refreshed.companion).toBeNull();
    expect(refreshed.account).toBe(remoteAccount);
  });

  it("keeps local Companion refreshes when account status fails", async () => {
    const companion = {
      enabled: true,
      keepAwake: false,
      port: 8811,
      devices: [],
      pairing: null,
    };
    const refreshed = await loadCompanionBridgeState(
      { state: () => Promise.resolve(companion) },
      { state: () => Promise.reject(new Error("account unavailable")) },
    );

    expect(refreshed.companion).toBe(companion);
    expect(refreshed.account).toBeNull();
  });

  it("hydrates an untouched email field but preserves user edits", () => {
    const remoteAccount = { ...account("signed-out"), email: "old@example.com" };

    expect(shouldHydrateCompanionEmail(false, remoteAccount)).toBe(true);
    expect(shouldHydrateCompanionEmail(true, remoteAccount)).toBe(false);
  });
});

describe("companion pairing availability", () => {
  const localCompanion = (enabled: boolean) => ({ enabled, endpoints: [] });
  const hostedCompanion = {
    enabled: true,
    endpoints: [
      { kind: "hosted" as const, url: "https://device.companion.example", priority: 0 },
    ],
  };

  it("waits while a signed-in account is provisioning its hosted route", () => {
    expect(companionPairingMode(account("connecting"), localCompanion(true))).toBe(
      "hosted-connecting",
    );
    expect(companionPairingMode(account("connecting"), localCompanion(false))).toBe(
      "hosted-connecting",
    );
  });

  it("starts a ready account when Companion is off, then waits for its hosted route", () => {
    expect(companionPairingMode(account("ready"), localCompanion(false))).toBe(
      "hosted-startable",
    );
    expect(companionPairingMode(account("ready"), localCompanion(true))).toBe(
      "hosted-connecting",
    );
  });

  it("allows pairing as soon as the hosted route is published", () => {
    expect(companionPairingMode(account("ready"), hostedCompanion)).toBe("hosted-ready");
    // The companion endpoint is the source of truth even if the separately
    // polled account state is one render behind.
    expect(companionPairingMode(account("connecting"), hostedCompanion)).toBe("hosted-ready");
  });

  it("preserves local-only pairing when hosted access is not configured or failed", () => {
    expect(companionPairingMode(account("signed-out"), localCompanion(true))).toBe("local-only");
    expect(
      companionPairingMode({ available: false, status: "signed-out" }, localCompanion(true)),
    ).toBe("local-only");
    expect(companionPairingMode(account("error"), localCompanion(true))).toBe("local-only");
  });
});
