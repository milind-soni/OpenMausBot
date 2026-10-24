import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "./contracts.ts";
import type { OfficeControl, OfficeControlLease } from "./office-control.ts";
import { withOfficeExecution } from "./office-execution.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

function fixture(options: { earlyComplete?: boolean } = {}) {
  const listeners = new Set<RuntimeEventListener>();
  const inputs: SendTurnInput[] = [];
  const interrupt = vi.fn(async () => {});
  const helper = vi.fn(async () => "unrequested");
  let nextTurn = 0;
  const emit = (type: "turn.started" | "turn.completed", turnId: string, ok = true) => {
    const event = { eventId: `event-${type}-${turnId}`, provider: "codex", threadId: "thread", turnId,
      createdAt: new Date().toISOString(), type, ...(type === "turn.completed" ? { ok, stopReason: null, cost: null } : {}) } as RuntimeEvent;
    for (const listener of listeners) listener(event);
  };
  const instance: ProviderInstance = {
    instanceId: "codex", driverKind: "codex", displayName: "Codex", enabled: true,
    models: { default: "model", options: [{ id: "model", label: "Model" }] },
    snapshot: async () => ({ state: "available" }), generateText: helper, generateMemoryText: helper, reviewPermission: helper,
    dispose: vi.fn(async () => {}),
    adapter: {
      provider: "codex", capabilities: { sessionModelSwitch: "unsupported", engineAdmission: true, queueing: true },
      sendTurn: vi.fn(async (input) => {
        inputs.push(input);
        const turnId = `turn-${++nextTurn}`;
        input.executionContext?.assert("process");
        emit("turn.started", turnId);
        input.executionContext?.assert("prompt");
        if (options.earlyComplete && nextTurn === 1) emit("turn.completed", turnId);
        return { turnId };
      }),
      interruptTurn: interrupt, stopAll: vi.fn(async () => {}), respondToRequest: async () => "unavailable",
      steer: vi.fn(async () => "steered" as const), hasSession: () => true,
      onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      cacheKeepWarm: { ping: vi.fn(async () => ({ ok: false as const, reason: "unused" })), hold: () => true },
    },
  };
  return { instance, inputs, interrupt, helper, emit };
}

function grant(options: { rootDeadline?: number; expiresAt?: number } = {}): OfficeControlLease {
  return {
    attemptId: "attempt", signal: new AbortController().signal, rootDeadline: options.rootDeadline ?? Date.now() + 60_000,
    expiresAt: options.expiresAt ?? Date.now() + 60_000, kind: "work", assert: vi.fn(), finish: vi.fn(),
  };
}

function service(lease = grant()): OfficeControl {
  return { prepare: vi.fn(async () => lease), invalidate: vi.fn(), close: vi.fn() } as unknown as OfficeControl;
}

const input = (): SendTurnInput => ({ botId: "bot", threadId: "thread", cwd: "/authorized", text: "work" });
afterEach(() => vi.useRealTimers());

describe("mandatory office provider boundary", () => {
  it("fails closed when configured control is unavailable or denies the attempt", async () => {
    const f = fixture();
    const wrapped = withOfficeExecution(f.instance, () => undefined);
    await expect(wrapped.adapter.sendTurn(input())).rejects.toThrow(/control.*unavailable/i);
    expect(f.inputs).toHaveLength(0);
    await wrapped.dispose();
    const rejected = fixture();
    const control = service();
    vi.mocked(control.prepare).mockRejectedValue(new Error("controller denied"));
    await expect(withOfficeExecution(rejected.instance, () => control).adapter.sendTurn(input())).rejects.toThrow("controller denied");
    expect(rejected.inputs).toHaveLength(0);
  });

  it("invalidates a pending gate synchronously and refuses a late grant after Stop", async () => {
    const f = fixture(), lease = grant(), control = service(lease);
    let resolve!: (lease: OfficeControlLease) => void;
    vi.mocked(control.prepare).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const wrapped = withOfficeExecution(f.instance, () => control);
    const pending = wrapped.adapter.sendTurn(input());
    const stopped = wrapped.adapter.interruptTurn("thread");
    expect(vi.mocked(control.prepare).mock.calls[0][0].signal.aborted).toBe(true);
    resolve(lease);
    await expect(pending).rejects.toThrow(/stopped|cancelled/i);
    await stopped;
    expect(f.inputs).toHaveLength(0);
    expect(lease.finish).toHaveBeenCalledWith("cancelled");
  });

  it("keeps an early completion retired and fences an old Stop from its replacement", async () => {
    const f = fixture({ earlyComplete: true }), lease = grant();
    const wrapped = withOfficeExecution(f.instance, () => service(lease));
    const first = await wrapped.adapter.sendTurn(input());
    expect(lease.finish).toHaveBeenCalledWith("completed");
    const second = await wrapped.adapter.sendTurn(input());
    await wrapped.adapter.interruptTurn("thread", first.turnId);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(second.turnId).not.toBe(first.turnId);
    await wrapped.dispose();
  });

  it("ignores an old completion while a replacement is waiting for its directive", async () => {
    const f = fixture(), control = service();
    const wrapped = withOfficeExecution(f.instance, () => control);
    const first = await wrapped.adapter.sendTurn(input());
    f.emit("turn.completed", first.turnId);
    let resolve!: (lease: OfficeControlLease) => void;
    vi.mocked(control.prepare).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = wrapped.adapter.sendTurn(input());
    f.emit("turn.completed", first.turnId);
    resolve(grant());
    const second = await pending;
    expect(second.turnId).not.toBe(first.turnId);
    expect(f.inputs).toHaveLength(2);
    await wrapped.dispose();
  });

  it("stops the exact native turn at the lease deadline and refuses expired steering", async () => {
    vi.useFakeTimers();
    const f = fixture(), lease = grant({ rootDeadline: Date.now() + 100, expiresAt: Date.now() + 100 });
    const wrapped = withOfficeExecution(f.instance, () => service(lease));
    const started = await wrapped.adapter.sendTurn(input());
    await expect(wrapped.adapter.steer!("thread", "continue")).resolves.toBe("steered");
    expect(lease.assert).toHaveBeenCalledWith("steer");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.interrupt).toHaveBeenCalledWith("thread", started.turnId);
    await expect(wrapped.adapter.steer!("thread", "late")).resolves.toBe("refused");
    expect(lease.finish).toHaveBeenCalledWith("cancelled");
  });

  it("disables every model helper without reaching its underlying provider", async () => {
    const f = fixture(), underlyingPing = f.instance.adapter.cacheKeepWarm!.ping;
    const wrapped = withOfficeExecution(f.instance, () => service());
    expect(wrapped.generateText).toBeUndefined();
    expect(wrapped.generateMemoryText).toBeUndefined();
    expect(wrapped.reviewPermission).toBeUndefined();
    await expect(wrapped.adapter.cacheKeepWarm!.ping("thread")).resolves.toMatchObject({ ok: false });
    expect(f.helper).not.toHaveBeenCalled();
    expect(underlyingPing).not.toHaveBeenCalled();
  });

  it("is mandatory after decoration and invalidates retained adapters on registry reload", async () => {
    const fake = makeFakeDriver({ kind: "codex" }), control = service();
    const created: ProviderInstance[] = [];
    fake.driver.create = async () => { const f = fixture(); created.push(f.instance); return f.instance; };
    const registry = new ProviderRegistry([fake.driver], { officeExecution: () => control });
    await registry.load({ codex: { driver: "codex" } }, (instance) => ({ ...instance, generateText: async () => "bypass" }));
    const old = registry.get("codex")!.adapter;
    expect(registry.get("codex")!.generateText).toBeUndefined();
    await registry.load({ codex: { driver: "codex" } });
    await expect(old.sendTurn(input())).rejects.toThrow(/removed|disposed/i);
    expect(created).toHaveLength(2);
  });

  it("rejects unrequested drivers and malformed execution leases before native invocation", async () => {
    const f = fixture();
    Object.assign(f.instance, { driverKind: "unknown" });
    await expect(withOfficeExecution(f.instance, () => service()).adapter.sendTurn(input())).rejects.toThrow(/driver/i);
    const bad = fixture(), lease = grant({ rootDeadline: Number.NaN });
    await expect(withOfficeExecution(bad.instance, () => service(lease)).adapter.sendTurn(input())).rejects.toThrow(/lease|deadline/i);
    expect(bad.inputs).toHaveLength(0);
  });

  it("refuses a second process start under the same consumed attempt", async () => {
    const f = fixture(), lease = grant();
    const wrapped = withOfficeExecution(f.instance, () => service(lease));
    await wrapped.adapter.sendTurn(input());
    expect(() => f.inputs[0].executionContext!.assert("process")).toThrow(/one native process/);
    expect(vi.mocked(lease.assert).mock.calls.filter(([stage]) => stage === "process")).toHaveLength(1);
    await wrapped.dispose();
  });

  it("binds the exact assembled model, effort, variant, approval and tool selection to preparation", async () => {
    const f = fixture(), control = service();
    const wrapped = withOfficeExecution(f.instance, () => control);
    await wrapped.adapter.sendTurn({ ...input(), model: "gpt-fixture", effort: "high", variant: "fixture-variant",
      approvalMode: "ask", toolScope: { allow: ["native:*"] } });
    expect(control.prepare).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-fixture", effort: "high", variant: "fixture-variant", approvalMode: "ask", toolScope: { allow: ["native:*"] },
    }));
    expect(f.inputs[0]).toMatchObject({ model: "gpt-fixture", effort: "high", variant: "fixture-variant", approvalMode: "ask" });
    await wrapped.dispose();
  });

  it("keeps launch parameters bound when a caller mutates its input during the directive wait", async () => {
    const f = fixture(), control = service();
    let resolve!: (lease: OfficeControlLease) => void;
    vi.mocked(control.prepare).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const wrapped = withOfficeExecution(f.instance, () => control);
    const supplied = { ...input(), model: "approved-model", approvalMode: "ask" as const, toolScope: { allow: ["native:*"] } };
    const pending = wrapped.adapter.sendTurn(supplied);
    supplied.model = "replacement-model";
    supplied.toolScope.allow[0] = "mcp:unexpected:*";
    resolve(grant());
    await pending;
    expect(f.inputs[0]).toMatchObject({ model: "approved-model", approvalMode: "ask", toolScope: { allow: ["native:*"] } });
    expect(control.prepare).toHaveBeenCalledWith(expect.objectContaining({ model: "approved-model", toolScope: { allow: ["native:*"] } }));
    await wrapped.dispose();
  });

  it("preserves uncertain native ownership and blocks replacement after a failed local stop", async () => {
    const f = fixture(), lease = grant();
    const wrapped = withOfficeExecution(f.instance, () => service(lease));
    const started = await wrapped.adapter.sendTurn(input());
    f.interrupt.mockRejectedValueOnce(new Error("native stop unconfirmed"));
    await expect(wrapped.adapter.interruptTurn("thread", started.turnId)).rejects.toThrow(/unconfirmed/);
    expect(lease.finish).toHaveBeenCalledWith("uncertain");
    await expect(wrapped.adapter.sendTurn(input())).rejects.toThrow(/already active/);
    f.emit("turn.completed", started.turnId, false);
    expect(lease.finish).toHaveBeenLastCalledWith("cancelled");
    await expect(wrapped.adapter.sendTurn(input())).resolves.toMatchObject({ turnId: "turn-2" });
    await wrapped.dispose();
  });

  it("retains a quarantined registry entry when reload cannot confirm its native stop", async () => {
    const fake = makeFakeDriver({ kind: "codex" }), f = fixture();
    const create = vi.fn(async () => f.instance);
    fake.driver.create = create;
    const registry = new ProviderRegistry([fake.driver], { officeExecution: () => service() });
    await registry.load({ codex: { driver: "codex" } });
    const old = registry.get("codex")!;
    const started = await old.adapter.sendTurn(input());
    f.interrupt.mockRejectedValueOnce(new Error("native stop unconfirmed"));
    await expect(registry.load({ codex: { driver: "codex" } })).rejects.toThrow(/unconfirmed/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(registry.get("codex")).toBe(old);
    await expect(old.adapter.sendTurn(input())).rejects.toThrow(/removed|disposed/);
    f.emit("turn.completed", started.turnId, false);
    await registry.dispose("codex");
  });

  it("rejects configured non-OAuth provider routes before driver creation", async () => {
    const fake = makeFakeDriver({ kind: "codex" });
    const create = vi.spyOn(fake.driver, "create");
    const registry = new ProviderRegistry([fake.driver], { officeExecution: () => service() });
    await registry.load({ managed: { driver: "codex", config: { managed: { models: ["model"] } } },
      plan: { driver: "codex", config: { authMode: "chatgpt-plan" } } });
    expect(registry.get("managed")).toBeNull();
    expect(registry.get("plan")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("never creates an unsupported office driver on load or reload", async () => {
    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const create = vi.spyOn(fake.driver, "create");
    const registry = new ProviderRegistry([fake.driver], { officeExecution: () => service() });
    await registry.load({ unsupported: { driver: "claudeAgent" } });
    await registry.load({ unsupported: { driver: "claudeAgent" } });
    expect(registry.get("unsupported")).toBeNull();
    expect(registry.entries()[0].shadow?.reason).toMatch(/only.*Codex OAuth/);
    expect(create).not.toHaveBeenCalled();
  });
});
