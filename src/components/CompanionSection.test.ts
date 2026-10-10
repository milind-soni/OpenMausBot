import { describe, expect, it } from "vitest";

import type { CompanionAccountState } from "../types/ogb";
import {
  companionStateRefreshIsCurrent,
  mutateCompanionBridgeState,
  phonePairingManualCodeMode,
  type CompanionState,
} from "./PhoneSetupFlow";
import {
  companionAccountActionError,
  companionPairingMode,
  deriveCompanionPanelStatus,
  deriveTailscalePairingStatus,
  loadCompanionBridgeState,
  pairingSurfaceCopy,
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
  it("omits the redundant status pill when device access is ready for its first pairing", () => {
    expect(deriveCompanionPanelStatus({
      enabled: true,
      devices: [],
    })).toBeNull();
  });

  it("does not show a healthy status when the enabled sidecar reports an error", () => {
    expect(deriveCompanionPanelStatus({
      enabled: true,
      devices: [],
      error: "sidecar stopped responding",
    })).toEqual({ label: "Remote access needs attention", good: false });
  });

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

  it("does not let a pre-mutation poll overwrite a newly opened pairing", async () => {
    const pairingToken = `omb_pair_${"a".repeat(43)}`;
    const staleState: CompanionState = {
      enabled: true,
      keepAwake: false,
      port: 8811,
      devices: [],
      pairing: null,
    };
    const pairedState: CompanionState = {
      ...staleState,
      pairing: { code: "004209", token: pairingToken, expiresAt: Date.now() + 60_000 },
    };
    let signalCompanionRead = () => {};
    const companionRead = new Promise<void>((resolve) => {
      signalCompanionRead = resolve;
    });
    let resolveAccount = (_value: CompanionAccountState) => {};
    const accountRead = new Promise<CompanionAccountState>((resolve) => {
      resolveAccount = resolve;
    });
    const epoch = { current: 0 };
    const refreshEpoch = epoch.current;
    let visibleState: CompanionState | null = null;
    const refresh = loadCompanionBridgeState(
      {
        state: () => {
          signalCompanionRead();
          return Promise.resolve(staleState);
        },
      },
      { state: () => accountRead },
    ).then((next) => {
      if (next.companion && companionStateRefreshIsCurrent(epoch, refreshEpoch)) {
        visibleState = next.companion;
      }
      return next;
    });

    await companionRead;
    visibleState = await mutateCompanionBridgeState(epoch, () => Promise.resolve(pairedState));
    resolveAccount(account("ready"));
    const refreshed = await refresh;

    expect(refreshed.companion).toBe(staleState);
    expect(visibleState).toBe(pairedState);
    expect(epoch.current).toBe(2);
  });

  it("hydrates an untouched email field but preserves user edits", () => {
    const remoteAccount = { ...account("signed-out"), email: "old@example.com" };

    expect(shouldHydrateCompanionEmail(false, remoteAccount)).toBe(true);
    expect(shouldHydrateCompanionEmail(true, remoteAccount)).toBe(false);
  });
});

describe("manual pairing code placement", () => {
  it("shows the code directly when no QR link can be built", () => {
    expect(phonePairingManualCodeMode(true, null)).toBe("direct");
  });

  it("keeps the code in troubleshooting details when a QR is available", () => {
    expect(phonePairingManualCodeMode(true, "openmausbot://pair?token=example")).toBe("details");
    expect(phonePairingManualCodeMode(false, null)).toBe("hidden");
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

describe("Tailscale pairing onboarding", () => {
  it("keeps HTTPS as the recommended default surface", () => {
    expect(pairingSurfaceCopy({ localFallback: false, tailscaleFallback: false })).toEqual({
      title: "Secure HTTPS pairing",
      subtitle: "Recommended — the simplest setup, and it keeps working when the paired device leaves this Wi-Fi.",
    });
    expect(pairingSurfaceCopy({ localFallback: false, tailscaleFallback: true }).title).toBe(
      "Tailscale pairing",
    );
  });

  it("explains every step between unchecked and ready", () => {
    expect(deriveTailscalePairingStatus({ enabled: false }, false)).toMatchObject({
      kind: "unchecked",
      detail: expect.stringContaining("turns on Remote access"),
    });
    expect(deriveTailscalePairingStatus({ enabled: true }, false).kind).toBe("unavailable");
    expect(deriveTailscalePairingStatus({
      enabled: true,
      tailscale: "100.99.1.2",
    }, false).kind).toBe("magicdns");
    expect(deriveTailscalePairingStatus({
      enabled: true,
      tailscale: "100.99.1.2",
      tailnetName: "mac.tail1234.ts.net",
    }, true)).toMatchObject({
      kind: "ready",
      title: "Ready on mac.tail1234.ts.net",
    });
  });

  it("surfaces sidecar failures instead of pretending Tailscale is merely absent", () => {
    expect(deriveTailscalePairingStatus({
      enabled: true,
      error: "the companion is not responding",
    }, false)).toEqual({
      kind: "error",
      title: "Remote access needs attention",
      detail: "the companion is not responding",
    });
  });
});
