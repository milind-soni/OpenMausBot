import { describe, expect, it } from "vitest";

import {
  disconnectAccountConfirmation,
  mergeCompleteConnectorStatus,
  mergeCurrentConnectorStatus,
  type ConnectorStatus,
} from "./PluginsPanel";

describe("connected-app status races", () => {
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
});
