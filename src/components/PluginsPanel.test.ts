import { describe, expect, it } from "vitest";

import {
  connectedAppsMayDisconnect,
  connectedInventoryCopy,
  connectorActionLabel,
  disconnectAccountConfirmation,
  mergeCompleteConnectorStatus,
  mergeCurrentConnectorStatus,
  requiresAccountAlias,
  onlyLatestConnectorResponses,
  type ConnectorStatus,
} from "./PluginsPanel";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";

describe("connected-app remote permissions", () => {
  it("allows pairing and status remotely but keeps revocation on the host", () => {
    expect(connectedAppsMayDisconnect(false)).toBe(true);
    expect(connectedAppsMayDisconnect(true)).toBe(false);
  });
});

describe("connected-app status races", () => {
  it("offers status recovery for a pending authorization whose URL was lost on remount", () => {
    for (const hasAccounts of [false, true]) {
      expect(connectorActionLabel("ready", {
        busy: false, included: false, pending: true, canContinue: false,
        hasAccounts, failed: false,
      })).toBe("Check status");
      expect(connectorActionLabel("ready", {
        busy: false, included: false, pending: true, canContinue: true,
        hasAccounts, failed: false,
      })).toBe("Continue");
    }
  });
  it("does not render a dead Twitter connect action for managed installs", () => {
    expect(managedConnectorUnavailableReason("managed", "twitter")).toMatch(/self-hosted/i);
    expect(managedConnectorUnavailableReason("self-hosted", "twitter")).toBeNull();
  });
  it("does not let an older not_connected response erase a newer OAuth attempt", async () => {
    const generations = new Map([["gmail", 0]]);
    const initialRequestGenerations = new Map(generations);
    let deliverInitialResponse: (value: Record<string, ConnectorStatus>) => void = () => {};
    const delayedInitialResponse = new Promise<Record<string, ConnectorStatus>>((resolve) => {
      deliverInitialResponse = resolve;
    });

    generations.set("gmail", 1);
    const localOAuthState = {
      gmail: { connected: false, pending: true, status: "INITIATED" },
    };
    deliverInitialResponse({ gmail: { connected: false, pending: false, status: "not_connected" } });

    const merged = mergeCurrentConnectorStatus(
      localOAuthState,
      await delayedInitialResponse,
      generations,
      initialRequestGenerations,
    );

    expect(merged.gmail).toEqual({ connected: false, pending: true, status: "INITIATED" });
  });

  it("still applies a response from the current generation", () => {
    const generations = new Map([["gmail", 1]]);
    const merged = mergeCurrentConnectorStatus(
      { gmail: { connected: false, pending: true, status: "INITIATED" } },
      { gmail: { connected: true, pending: false, status: "ACTIVE" } },
      generations,
      new Map(generations),
    );

    expect(merged.gmail).toEqual({ connected: true, pending: false, status: "ACTIVE" });
  });

  it("drops an older status response when a newer request for the same app has started", () => {
    const latestRequests = new Map([["gmail", 2], ["slack", 1]]);
    const requestIds = new Map([["gmail", 1], ["slack", 1]]);
    expect(
      onlyLatestConnectorResponses(
        {
          gmail: { connected: false, status: "not_connected" },
          slack: { connected: true, status: "ACTIVE" },
        },
        latestRequests,
        requestIds,
      ),
    ).toEqual({ slack: { connected: true, status: "ACTIVE" } });
  });

  it("keeps a connected account beyond the first 40 marketplace cards", () => {
    const catalog = Array.from({ length: 45 }, (_, index) => `toolkit_${index + 1}`);
    const accountSlug = catalog[40];
    expect(catalog.slice(0, 40)).not.toContain(accountSlug);

    const merged = mergeCompleteConnectorStatus(
      {},
      {
        [accountSlug]: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
        },
      },
      new Map(),
      new Map(),
    );

    expect(merged[accountSlug]?.accounts).toEqual([
      { id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" },
    ]);
  });

  it("clears externally removed accounts without overwriting a newer OAuth attempt", () => {
    const generations = new Map([["gmail", 2]]);
    const removed = mergeCompleteConnectorStatus(
      { gmail: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } },
      {},
      generations,
      new Map(generations),
    );
    expect(removed.gmail).toEqual({
      connected: false,
      pending: false,
      status: "not_connected",
      accounts: [],
    });

    const preserved = mergeCompleteConnectorStatus(
      { gmail: { connected: false, pending: true, status: "INITIATED" } },
      {},
      new Map([["gmail", 3]]),
      generations,
    );
    expect(preserved.gmail).toEqual({ connected: false, pending: true, status: "INITIATED" });

    // The generation guard specifically: a connected entry WITH accounts is
    // exactly what the clearing branch targets, so only the advanced
    // generation can save it — a freshly-connected account must survive a
    // stale /connected response racing the Connect click.
    const racing = mergeCompleteConnectorStatus(
      { gmail: { connected: true, accounts: [{ id: "ca_new", status: "ACTIVE" }] } },
      {},
      new Map([["gmail", 3]]),
      generations,
    );
    expect(racing.gmail).toEqual({ connected: true, accounts: [{ id: "ca_new", status: "ACTIVE" }] });
  });

  it("names the exact account and limits disconnect confirmation to that account", () => {
    expect(disconnectAccountConfirmation("Gmail", { id: "ca_work", alias: "work" })).toBe(
      "Disconnect “work” (ca_work) from Gmail? Only this Gmail account will be revoked. Your other Gmail accounts will stay connected.",
    );
    expect(disconnectAccountConfirmation("GitHub", { id: "ca_personal" })).toContain(
      "Disconnect “ca_personal” from GitHub? Only this GitHub account will be revoked.",
    );
  });

  it("recognizes the existing-account alias guard and ignores unrelated errors", () => {
    expect(requiresAccountAlias("Add an account alias so the existing connection is not replaced")).toBe(true);
    expect(requiresAccountAlias("Authorization expired")).toBe(false);
  });

  it("never presents unloaded account state as disconnected", () => {
    expect(connectedInventoryCopy("loading").title).toBe("Checking connected apps…");
    expect(connectorActionLabel("loading", {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: false,
      failed: false,
    })).toBe("Checking…");
    expect(connectorActionLabel("ready", {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: true,
      failed: false,
    })).toBe("Add account");
    expect(connectorActionLabel("error", {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: false,
      failed: false,
    })).toBe("Unavailable");
  });
});

describe("an answer the server was not sure about", () => {
  const connectedGmail = {
    gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] },
  } satisfies Record<string, ConnectorStatus>;

  it("keeps a connected app when the response was not authoritative", () => {
    // the credential store was unreadable, so the server sent {} — that is
    // ignorance, and clearing on it is how a connected app turns into a
    // Connect button the user never asked for
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map(), false);
    expect(merged.gmail.connected).toBe(true);
  });

  it("still clears an app the server authoritatively no longer lists", () => {
    // disconnection has to remain possible: revoking from Composio's
    // dashboard must show up here on the next successful check
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map(), true);
    expect(merged.gmail.connected).toBe(false);
    expect(merged.gmail.status).toBe("not_connected");
  });

  it("treats a missing authority flag as authoritative, preserving today's behaviour", () => {
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map());
    expect(merged.gmail.connected).toBe(false);
  });
});
