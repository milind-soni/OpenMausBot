import { describe, expect, it } from "vitest";

import {
  botsMissingConnectedApps,
  botsWithLimitedServiceTools,
  hasUsableConnectedApps,
  connectorSetupNotice,
  disconnectAccountConfirmation,
} from "./PluginsPanel";
import { mergeCompleteConnectorStatus, mergeCurrentConnectorStatus, onlyLatestConnectorResponses } from "@/lib/connector-status-merge";
import {
  accountToReconnect,
  connectedInventoryCopy,
  connectorActionLabel,
  hasActiveConnection,
  requiresAccountAlias,
  type ConnectorStatus,
} from "@/lib/connector-status";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import type { Bot, InstanceInfo } from "@/state/store";

// Narrow fixtures: the helper reads four fields, so the casts keep the test about the rule.
const engine = (instanceId: string, composioMcp: boolean) =>
  ({ instanceId, capabilities: { composioMcp } }) as unknown as InstanceInfo;
const bot = (id: string, fields: Partial<Bot> = {}) =>
  ({ id, name: id, modelSelection: { instanceId: "claude" }, ...fields }) as unknown as Bot;

describe("bots whose connected-app tools are limited by grants", () => {
  const instances = [engine("claude", true), engine("grok", false)];

  it("leaves legacy bots and all-tools grants out", () => {
    const bots = [
      bot("legacy"),
      bot("star", { connectorTools: { gmail: { tools: "*" } } }),
    ];
    expect(botsWithLimitedServiceTools(bots, instances, "gmail")).toEqual([]);
  });

  it("names partial lists and services an explicit record leaves out", () => {
    const bots = [
      bot("partial", { connectorTools: { gmail: { tools: ["GMAIL_SEND_EMAIL"] } } }),
      bot("absent", { connectorTools: { gmail: { tools: "*" } } }),
    ];
    expect(botsWithLimitedServiceTools(bots, instances, "gmail").map((b) => b.id)).toEqual(["partial"]);
    expect(botsWithLimitedServiceTools(bots, instances, "slack").map((b) => b.id)).toEqual(["partial", "absent"]);
  });

  it("counts a grant shape this build cannot read as limited", () => {
    const future = bot("future", {
      connectorTools: { gmail: { tools: { prefix: "GMAIL_" } } } as unknown as Bot["connectorTools"],
    });
    expect(botsWithLimitedServiceTools([future], instances, "gmail")).toEqual([future]);
  });

  it("never points at bots whose editor is a dead end from here", () => {
    const grant = { connectorTools: { gmail: { tools: ["GMAIL_SEND_EMAIL"] } } } as Partial<Bot>;
    const bots = [
      bot("hidden", { hidden: true, ...grant }),
      bot("off", { composio: false, ...grant }),
      bot("grok", { ...grant, modelSelection: { instanceId: "grok" } as Bot["modelSelection"] }),
    ];
    expect(botsWithLimitedServiceTools(bots, instances, "gmail")).toEqual([]);
  });
});

describe("connected apps a bot cannot see", () => {
  const instances = [engine("claude", true), engine("grok", false)];

  it("only offers grants after catalog and inventory confirm a usable account", () => {
    const active = { calendar: { connected: true, pending: false, status: "ACTIVE" } };
    expect(hasUsableConnectedApps(true, "ready", false, active)).toBe(true);
    expect(hasUsableConnectedApps(false, "ready", false, active)).toBe(false);
    expect(hasUsableConnectedApps(true, "loading", false, active)).toBe(false);
    expect(hasUsableConnectedApps(true, "error", false, active)).toBe(false);
    expect(hasUsableConnectedApps(true, "ready", true, active)).toBe(false);
    expect(hasUsableConnectedApps(true, "ready", false, { calendar: { connected: false, pending: false, status: "EXPIRED" } })).toBe(false);
  });

  it("names the bots whose own grant is off, and only those", () => {
    const bots = [
      bot("allowed"),
      bot("off", { composio: false }),
      bot("also-off", { composio: false }),
    ];
    expect(botsMissingConnectedApps(bots, instances).map((b) => b.id)).toEqual(["off", "also-off"]);
  });

  it("treats an absent grant as allowed, the way every turn does", () => {
    expect(botsMissingConnectedApps([bot("fresh"), bot("explicit", { composio: true })], instances)).toEqual([]);
  });

  it("leaves out a bot whose engine could never mount the tools", () => {
    const bots = [bot("grok-bot", { composio: false, modelSelection: { instanceId: "grok" } as Bot["modelSelection"] })];
    expect(botsMissingConnectedApps(bots, instances)).toEqual([]);
    expect(botsMissingConnectedApps([bot("orphan", { composio: false, modelSelection: { instanceId: "gone" } as Bot["modelSelection"] })], instances)).toEqual([]);
  });

  it("leaves out hidden bots, which the person cannot act on from here", () => {
    expect(botsMissingConnectedApps([bot("ghost", { composio: false, hidden: true })], instances)).toEqual([]);
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

  it("counts only an ACTIVE account as connected and offers to sign the newest dead one in again", () => {
    const expired = { id: "ca_old", alias: "work", status: "EXPIRED" };
    const failed = { id: "ca_failed", status: "FAILED" };
    const gmail = (accounts: ConnectorStatus["accounts"], connected = true): ConnectorStatus => ({ connected, accounts });
    expect(hasActiveConnection(gmail([expired]))).toBe(false);
    expect(accountToReconnect(gmail([expired, failed]))).toBe(expired);
    expect(hasActiveConnection(gmail([expired, { id: "ca_new", status: "ACTIVE" }]))).toBe(true);
    expect(accountToReconnect(gmail([expired, { id: "ca_new", status: "ACTIVE" }]))).toBeUndefined();
    expect(accountToReconnect(gmail([{ id: "ca_pending", status: "INITIATED" }]))).toBeUndefined();
    expect(hasActiveConnection(gmail([]))).toBe(true);
    expect(hasActiveConnection(gmail([], false))).toBe(false);
    expect(connectorActionLabel("ready", {
      busy: false, included: false, canContinue: false, reconnect: true, hasAccounts: true, failed: true,
    })).toBe("Reconnect");
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
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map(), false);
    expect(merged.gmail.connected).toBe(true);
  });

  it("still clears an app the server authoritatively no longer lists", () => {
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map(), true);
    expect(merged.gmail.connected).toBe(false);
    expect(merged.gmail.status).toBe("not_connected");
  });

  it("treats a missing authority flag as authoritative, preserving today's behaviour", () => {
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map());
    expect(merged.gmail.connected).toBe(false);
  });
});

describe("connected apps setup notice", () => {
  const base = { configured: false, stale: false, remoteClient: false };

  it("tells a fresh install what to do instead of reporting an outage", () => {
    expect(connectorSetupNotice({ ...base, setup: "needs-setup" })).toEqual({
      key: "connectors.setupNeeded",
      tone: "info",
    });
    expect(connectorSetupNotice({ ...base, setup: "needs-setup", remoteClient: true })).toEqual({
      key: "connectors.setupNeededRemote",
      tone: "info",
    });
  });

  it("still warns when the managed service really is unavailable", () => {
    expect(connectorSetupNotice({ ...base, setup: "service-unavailable" })).toEqual({
      key: "connectors.notConfigured",
      tone: "warning",
    });
  });

  it("keeps the warning for an older host that does not say why", () => {
    expect(connectorSetupNotice({ ...base, setup: undefined })).toEqual({
      key: "connectors.notConfigured",
      tone: "warning",
    });
  });

  it("says nothing when apps work or the stale banner already explains", () => {
    expect(connectorSetupNotice({ ...base, configured: true, setup: "ready" })).toBeNull();
    expect(connectorSetupNotice({ ...base, stale: true, setup: "needs-setup" })).toBeNull();
  });
});
