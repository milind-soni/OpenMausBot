import { describe, expect, it } from "vitest";

import { idleTunnelReason, tunnelActivity } from "../src/tunnel-activity";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const POLICY = { neverConnectedMs: 7 * DAY_MS, offlineMs: 21 * DAY_MS };
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

function reason(raw: Parameters<typeof tunnelActivity>[0]) {
  return idleTunnelReason(tunnelActivity(raw), NOW, POLICY);
}

describe("idle tunnel classification", () => {
  it("reclaims a tunnel that never ran once it is a week old", () => {
    expect(reason({ status: "inactive", created_at: ago(8) })).toBe("never_connected");
    expect(reason({
      status: "inactive",
      created_at: ago(30),
      conns_active_at: null,
      conns_inactive_at: null,
      connections: [],
    })).toBe("never_connected");
    expect(reason({ status: "inactive", created_at: ago(6) })).toBeNull();
    expect(reason({ status: "inactive" })).toBeNull();
  });

  it("reclaims a tunnel only after it has been down for the configured period", () => {
    expect(reason({ status: "down", created_at: ago(90), conns_inactive_at: ago(22) })).toBe("offline");
    expect(reason({
      status: "down",
      created_at: ago(90),
      conns_active_at: ago(40),
      conns_inactive_at: ago(22),
    })).toBe("offline");
    expect(reason({ status: "down", created_at: ago(90), conns_inactive_at: ago(20) })).toBeNull();
    expect(reason({ status: "down", created_at: ago(90) })).toBeNull();
  });

  it("never reclaims a connected tunnel, whatever its timestamps say", () => {
    for (const status of ["healthy", "degraded"]) {
      expect(reason({ status, created_at: ago(90), conns_active_at: ago(60) })).toBeNull();
      expect(reason({ status, created_at: ago(90), conns_inactive_at: ago(60) })).toBeNull();
    }
    // A live connection beats a stale "down" or "inactive" label.
    expect(reason({
      status: "down",
      created_at: ago(90),
      conns_inactive_at: ago(30),
      connections: [{ colo_name: "DFW" }],
    })).toBeNull();
    expect(reason({ status: "inactive", created_at: ago(90), connections: [{}] })).toBeNull();
    // Reconnected after it last went down.
    expect(reason({
      status: "down",
      created_at: ago(90),
      conns_active_at: ago(1),
      conns_inactive_at: ago(30),
    })).toBeNull();
    // "Never ran" contradicted by an activation time.
    expect(reason({ status: "inactive", created_at: ago(90), conns_active_at: ago(30) })).toBeNull();
  });

  it("treats unknown, missing, or malformed provider state as active", () => {
    expect(idleTunnelReason(undefined, NOW, POLICY)).toBeNull();
    expect(reason({ created_at: ago(90) })).toBeNull();
    expect(reason({ status: "paused", created_at: ago(90), conns_inactive_at: ago(90) })).toBeNull();
    expect(reason({ status: "down", created_at: ago(90), conns_inactive_at: "yesterday-ish" })).toBeNull();
    expect(reason({ status: "inactive", created_at: "not-a-date" })).toBeNull();
    // A timestamp in the future is never "long enough ago".
    expect(reason({ status: "inactive", created_at: new Date(NOW + DAY_MS).toISOString() })).toBeNull();
  });
});
