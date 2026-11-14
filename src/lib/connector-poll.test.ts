import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatus } from "./connector-status";
import { CONNECTOR_POLL_MS, CONNECTOR_POLL_TRIES, connectorPollEnd, pollConnector } from "./connector-poll";

type Pending = { resolve: (state: ConnectorStatus | undefined) => void };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const account = (id: string, status: string) => ({ id, status });

describe("how a Connect ends", () => {
  it("names each end of a first Connect, and keeps polling until one", () => {
    expect(connectorPollEnd(undefined, { connected: false, pending: true, status: "INITIATED", accounts: [account("ca_new", "INITIATED")] }, 23)).toBeNull();
    expect(connectorPollEnd(undefined, { connected: true, pending: false, status: "ACTIVE", accounts: [account("ca_new", "ACTIVE")] }, 1)).toBe("connected");
    expect(connectorPollEnd(undefined, { connected: false, status: "FAILED", accounts: [account("ca_new", "FAILED")] }, 2)).toBe("failed");
    expect(connectorPollEnd(undefined, { connected: false, status: "expired", accounts: [account("ca_new", "expired")] }, 2)).toBe("expired");
    expect(connectorPollEnd(undefined, undefined, 24)).toBe("timed_out");
  });

  it("calls a retry beside an abandoned attempt connected once the new account works", () => {
    const before = { connected: false, pending: true, status: "INITIATED", accounts: [account("ca_old", "INITIATED")] };
    expect(connectorPollEnd(before, { connected: true, pending: true, status: "ACTIVE", accounts: [account("ca_old", "INITIATED"), account("ca_new", "ACTIVE")] }, 1)).toBe("connected");
  });

  it("waits for the added account when another account of the app already works", () => {
    const before = { connected: true, pending: false, status: "ACTIVE", accounts: [account("ca_work", "ACTIVE")] };
    expect(connectorPollEnd(before, before, 1)).toBeNull();
    expect(connectorPollEnd(before, { ...before, pending: true, accounts: [account("ca_work", "ACTIVE"), account("ca_home", "INITIATED")] }, 2)).toBeNull();
    expect(connectorPollEnd(before, { ...before, accounts: [account("ca_work", "ACTIVE"), account("ca_home", "ACTIVE")] }, 3)).toBe("connected");
    expect(connectorPollEnd(before, { ...before, accounts: [account("ca_work", "ACTIVE"), account("ca_home", "FAILED")] }, 3)).toBe("failed");
    expect(connectorPollEnd(before, before, CONNECTOR_POLL_TRIES)).toBe("timed_out");
  });

  it("does not blame a Reconnect on the expired account it replaces, and counts that account working again", () => {
    const before = { connected: false, status: "EXPIRED", accounts: [account("ca_dead", "EXPIRED")] };
    expect(connectorPollEnd(before, { connected: false, pending: true, status: "INITIATED", accounts: [account("ca_dead", "EXPIRED"), account("ca_new", "INITIATED")] }, 1)).toBeNull();
    expect(connectorPollEnd(before, { connected: true, status: "ACTIVE", accounts: [account("ca_dead", "ACTIVE")] }, 2)).toBe("connected");
  });

  it("without an account list, calls it connected only when the app turns connected", () => {
    expect(connectorPollEnd(undefined, { connected: true, pending: false, status: "ACTIVE" }, 1)).toBe("connected");
    expect(connectorPollEnd({ connected: false }, { connected: true, pending: true }, 1)).toBe("connected");
    expect(connectorPollEnd({ connected: true, status: "ACTIVE" }, { connected: true, status: "ACTIVE" }, 1)).toBeNull();
    expect(connectorPollEnd(undefined, { connected: false, status: "FAILED" }, 2)).toBeNull();
    expect(connectorPollEnd({ connected: true, status: "ACTIVE" }, { connected: true, status: "ACTIVE" }, CONNECTOR_POLL_TRIES)).toBe("timed_out");
  });
});

describe("polling one app after Connect", () => {
  it("ends once even when two slow reads both come back connected", async () => {
    const reads: Pending[] = [];
    const onEnd = vi.fn();
    pollConnector(undefined, () => new Promise((resolve) => reads.push({ resolve })), onEnd);
    await vi.advanceTimersByTimeAsync(2 * CONNECTOR_POLL_MS);
    expect(reads).toHaveLength(2);
    reads[0]!.resolve({ connected: true, pending: false, status: "ACTIVE" });
    reads[1]!.resolve({ connected: true, pending: false, status: "ACTIVE" });
    await vi.advanceTimersByTimeAsync(10 * CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([["connected"]]);
    expect(reads).toHaveLength(2);
  });

  it("gives up after two minutes of pending reads, and says so once", async () => {
    const read = vi.fn(async (): Promise<ConnectorStatus> => ({ connected: false, pending: true, status: "INITIATED" }));
    const onEnd = vi.fn();
    pollConnector(undefined, read, onEnd);
    await vi.advanceTimersByTimeAsync((CONNECTOR_POLL_TRIES - 1) * CONNECTOR_POLL_MS);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([["timed_out"]]);
    await vi.advanceTimersByTimeAsync(10 * CONNECTOR_POLL_MS);
    expect(read).toHaveBeenCalledTimes(CONNECTOR_POLL_TRIES);
    expect(CONNECTOR_POLL_TRIES * CONNECTOR_POLL_MS).toBe(120_000);
  });

  it.each([["FAILED", "failed"], ["EXPIRED", "expired"]])("reports a new %s account as %s", async (status, result) => {
    const onEnd = vi.fn();
    pollConnector(undefined, async () => ({ connected: false, status, accounts: [account("ca_new", status)] }), onEnd);
    await vi.advanceTimersByTimeAsync(3 * CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([[result]]);
  });

  it("judges every read against the app as it was when Connect began", async () => {
    const before = { connected: true, pending: false, status: "ACTIVE", accounts: [account("ca_work", "ACTIVE")] };
    let state: ConnectorStatus = before;
    const onEnd = vi.fn();
    pollConnector(before, async () => state, onEnd);
    await vi.advanceTimersByTimeAsync(3 * CONNECTOR_POLL_MS);
    expect(onEnd).not.toHaveBeenCalled();
    state = { ...before, accounts: [account("ca_work", "ACTIVE"), account("ca_home", "ACTIVE")] };
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([["connected"]]);
  });

  it("says nothing once stopped, even for a read already on its way (the panel closed, or Connect began again)", async () => {
    const reads: Pending[] = [];
    const onEnd = vi.fn();
    const stop = pollConnector(undefined, () => new Promise((resolve) => reads.push({ resolve })), onEnd);
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS);
    stop();
    reads[0]!.resolve({ connected: true, pending: false });
    await vi.advanceTimersByTimeAsync(10 * CONNECTOR_POLL_MS);
    expect(onEnd).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });
});
