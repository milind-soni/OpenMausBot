import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { brokerClient, BrokerError, type AppTriggerBroker } from "./app-trigger-broker.ts";
import { AppTriggerManager } from "./app-triggers.ts";

// tsconfig.server.json targets ES2023: Promise.withResolvers is ES2024.
function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

describe("the app-event service's Retry-After", () => {
  it.each([
    ["90", 90],
    ["Sat, 21 Nov 2026 00:02:00 GMT", 120],
    ["Sat, 21 Nov 2026 00:00:00 GMT", undefined],
    ["Fri, 20 Nov 2026 23:59:00 GMT", undefined],
    ["invalid", undefined],
    ["-5", undefined],
  ])("reads %s from a broker error", async (header, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00Z"));
    const client = brokerClient(() => ({ url: "https://broker.example", token: "fixture" }), async () =>
      new Response(JSON.stringify({ error: "Please wait" }), { status: 429, headers: { "retry-after": header } }));
    await expect(client.poll({ after: 0, waitS: 0, poller: "fixture-poller" }))
      .rejects.toMatchObject({ status: 429, retryAfterS: expected });
  });

  it.each([
    [409, 90, 90_000], [429, 90, 90_000], [503, 90, 90_000],
    [429, undefined, 2_000], [401, 90, 2_000], [503, 0, 2_000],
  ])("uses the retry interval for HTTP %i with Retry-After %s", async (status, retryAfter, expected) => {
    const directory = mkdtempSync(join(tmpdir(), "omb-trigger-retry-"));
    const sleeping = withResolvers<number>();
    const poll = vi.fn<AppTriggerBroker["poll"]>().mockRejectedValue(new BrokerError("Please wait", status!, retryAfter));
    const broker: AppTriggerBroker = {
      triggerTypes: async () => ({}),
      triggerType: async () => ({ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", name: "Message", description: "", config: {}, payload: {} }),
      create: async () => ({ triggerId: "remote-trigger" }),
      setEnabled: async () => {},
      remove: async () => {},
      inventory: async () => ({ triggers: [{ triggerId: "remote-trigger", slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", toolkit: "slack", connectedAccountId: "account", enabled: true, remote: { state: "enabled" }, dropped: {} }], unbound: [], limits: { plan: "desktop", eventsPerDay: 100 }, usage: { eventsToday: 0 } }),
      poll,
      testEvent: async () => {},
    };
    const manager = new AppTriggerManager({
      file: join(directory, "triggers.json"), broker,
      service: () => ({ available: true }),
      connectedApps: async () => ({ slack: { connected: true, accounts: [{ id: "account", status: "ACTIVE" }] } }),
      botState: () => "ready",
      runs: { enqueue: () => ({ id: "run" }), merge: () => null, receipt: () => null, pending: () => 0, cancelQueued: () => {} },
      sleep: (ms, signal) => {
        sleeping.resolve(ms);
        return new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    try {
      await manager.create({ botId: "bot", name: "Watch messages", prompt: "Summarize new messages", app: "slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED" });
      manager.start();
      expect(await sleeping.promise).toBe(expected);
      expect(poll).toHaveBeenCalledOnce();
    } finally {
      await manager.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
