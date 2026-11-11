import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { failoverLine, LimitFailovers, limitBackupAllowed, type LimitFailover } from "./limit-failover.ts";

const claude = { instanceId: "claude", driverKind: "claudeAgent" };
const NOW = Date.parse("2026-10-19T10:00:00Z");
const HOUR = 3_600_000;

describe("limitBackupAllowed", () => {
  it("never rotates to another sign-in of the same subscription engine", () => {
    expect(limitBackupAllowed(claude, claude)).toBe(false);
    expect(limitBackupAllowed(claude, { instanceId: "claude-work", driverKind: "claudeAgent" }, {})).toBe(false);
    expect(limitBackupAllowed({ instanceId: "codex", driverKind: "codex" }, { instanceId: "codex-2", driverKind: "codex" })).toBe(false);
  });

  it("allows another engine, or the same engine on a pay-per-use key", () => {
    expect(limitBackupAllowed(claude, { instanceId: "codex", driverKind: "codex" })).toBe(true);
    expect(limitBackupAllowed(claude, { instanceId: "claude-api", driverKind: "claudeAgent" }, { environment: { ANTHROPIC_API_KEY: "sk-test" } })).toBe(true);
    expect(limitBackupAllowed(claude, { instanceId: "claude-api", driverKind: "claudeAgent" }, { access: "api" })).toBe(true);
    expect(limitBackupAllowed(claude, { instanceId: "claude-api", driverKind: "claudeAgent" }, { environment: { ANTHROPIC_API_KEY: " " } })).toBe(false);
  });
});

it("says in one plain line who took over and when the limit resets", () => {
  expect(failoverLine("Claude", "Codex", undefined)).toBe("Claude hit its limit, so Codex took over.");
  expect(failoverLine("Claude", "Codex", NOW + HOUR)).toMatch(/^Claude hit its limit \(resets .+\), so Codex took over\.$/);
});

describe("LimitFailovers", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const from = { instanceId: "claude", model: "claude-sonnet-5" };
  const to = { instanceId: "codex", model: "gpt-fake-default" };
  function fixture(options: { blocked?: number | null; current?: typeof from | null; allowed?: boolean; signedOut?: () => boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "omb-limit-failovers-"));
    dirs.push(dir);
    let now = NOW;
    const state = { blocked: options.blocked ?? null, current: options.current === undefined ? to : options.current };
    const notes: string[] = [];
    const switched: LimitFailover[] = [];
    const deps = {
      file: join(dir, "limit-failovers.json"), now: () => now,
      blockedUntil: () => state.blocked, threadModel: () => state.current, signedOut: options.signedOut,
      switchBack: (failover: LimitFailover) => { if (options.allowed === false) return false; switched.push(failover); state.current = failover.from; return true; },
      note: (_threadId: string, line: string) => notes.push(line), engineName: (engine: string) => engine === "claude" ? "Claude" : engine,
    };
    const failovers = new LimitFailovers(deps);
    return { failovers, deps, notes, switched, state, at: (next: number) => { now = next; } };
  }

  it("goes back to the original engine at the first turn after its reset, noting it once", () => {
    const f = fixture();
    f.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW + HOUR, at: NOW });
    expect(f.failovers.restore("scout", "t")).toBe(false);
    f.at(NOW + HOUR + 1);
    expect(f.failovers.restore("scout", "t")).toBe(true);
    expect(f.switched).toEqual([expect.objectContaining({ from, to })]);
    expect(f.notes).toEqual(["Claude's limit has reset, so this conversation is back on Claude."]);
    expect(f.failovers.restore("scout", "t")).toBe(false);
    expect(f.notes).toHaveLength(1);
  });

  it("stays on the backup while the engine is still known to refuse, or the switch is not allowed now", () => {
    const blocked = fixture({ blocked: NOW + 5 * HOUR });
    blocked.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW + HOUR, at: NOW });
    blocked.at(NOW + 2 * HOUR);
    expect(blocked.failovers.restore("scout", "t")).toBe(false);
    const refused = fixture({ allowed: false });
    refused.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW + HOUR, at: NOW });
    refused.at(NOW + 2 * HOUR);
    expect(refused.failovers.restore("scout", "t")).toBe(false);
    expect(refused.failovers.list()).toHaveLength(1);
  });

  it("with no known reset, waits an hour before trying the engine again", () => {
    const f = fixture();
    f.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: null, at: NOW });
    f.at(NOW + 30 * 60_000);
    expect(f.failovers.restore("scout", "t")).toBe(false);
    f.at(NOW + HOUR + 1);
    expect(f.failovers.restore("scout", "t")).toBe(true);
  });

  it("with a reset that had already passed when the limit refused, waits as for no known reset", () => {
    const f = fixture();
    f.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW - 60_000, at: NOW });
    expect(f.failovers.list()).toEqual([expect.objectContaining({ resetsAt: null })]);
    f.at(NOW + 10 * 60_000);
    expect(f.failovers.restore("scout", "t"), "not back at once on a time that told nothing").toBe(false);
    f.at(NOW + HOUR + 1);
    expect(f.failovers.restore("scout", "t")).toBe(true);
  });

  it("goes back to an AI that was signed out once it is signed in again, saying so", () => {
    let out = true;
    const f = fixture({ signedOut: () => out });
    f.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: null, at: NOW, why: "signed-out" });
    f.at(NOW + 3 * HOUR);
    expect(f.failovers.restore("scout", "t")).toBe(false);
    out = false;
    expect(f.failovers.restore("scout", "t")).toBe(true);
    expect(f.notes).toEqual(["Claude is signed in again, so this conversation is back on Claude."]);
    expect(new LimitFailovers(f.deps).list()).toEqual([]);
  });

  it("forgets a thread someone moved to another model, and remembers across a restart", () => {
    const moved = fixture({ current: { instanceId: "opencode", model: "x" } });
    moved.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW, at: NOW });
    moved.at(NOW + HOUR);
    expect(moved.failovers.restore("scout", "t")).toBe(false);
    expect(moved.failovers.list()).toEqual([]);
    const kept = fixture();
    kept.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW + HOUR, at: NOW });
    expect(new LimitFailovers(kept.deps).list()).toEqual([expect.objectContaining({ threadId: "t", from, to })]);
  });

  it("a second failover still goes back to the engine the conversation started on", () => {
    const f = fixture({ current: { instanceId: "grok", model: "grok-5" } });
    f.failovers.record({ botId: "scout", threadId: "t", from, to, resetsAt: NOW + HOUR, at: NOW });
    f.failovers.record({ botId: "scout", threadId: "t", from: to, to: { instanceId: "grok", model: "grok-5" }, resetsAt: NOW + 2 * HOUR, at: NOW });
    expect(f.failovers.list()).toEqual([expect.objectContaining({ from, to: { instanceId: "grok", model: "grok-5" } })]);
  });
});
