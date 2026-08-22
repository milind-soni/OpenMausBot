import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AgentGraphDesktopGate, signAgentGraphDesktopAction } from "./agent-graph-desktop-gate.ts";

describe("desktop-only graph mutation authority", () => {
  it("binds a one-use proof to action, path, and normalized body", () => {
    const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
    const bootId = randomUUID();
    const gate = new AgentGraphDesktopGate(secret, bootId);
    const nonce = randomUUID();
    const issuedAt = Date.now();
    const body = { graphHash: `sha256:${"a".repeat(64)}` };
    const proof = signAgentGraphDesktopAction(secret, "approve", "/api/agent-graphs/graph-1/approve", body, nonce, issuedAt, bootId);
    const authority = { bootId, issuedAt, nonce, proof };
    expect(gate.consume("approve", "/api/agent-graphs/graph-1/approve", body, authority)).toBe(true);
    expect(gate.consume("approve", "/api/agent-graphs/graph-1/approve", body, authority)).toBe(false);
    expect(gate.consume("cancel", "/api/agent-graphs/graph-1/cancel", {}, { ...authority, nonce: randomUUID() })).toBe(false);
  });

  it("rejects another boot and expired or future proofs", () => {
    const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
    const bootId = randomUUID();
    const path = "/api/agent-graphs/preview";
    const body = { objective: "Bound approval replay" };
    for (const [authorityBoot, issuedAt] of [
      [randomUUID(), Date.now()],
      [bootId, Date.now() - 61_000],
      [bootId, Date.now() + 6_000],
    ] as const) {
      const nonce = randomUUID();
      const proof = signAgentGraphDesktopAction(secret, "preview", path, body, nonce, issuedAt, authorityBoot);
      expect(new AgentGraphDesktopGate(secret, bootId).consume("preview", path, body, {
        bootId: authorityBoot, issuedAt, nonce, proof,
      })).toBe(false);
    }
  });

  it("fails closed without a configured desktop secret", () => {
    expect(new AgentGraphDesktopGate("", randomUUID()).available()).toBe(false);
    expect(new AgentGraphDesktopGate("", randomUUID()).consume("preview", "/api/agent-graphs/preview", {}, {})).toBe(false);
  });
});
