import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedComputers } from "./shared-computers.ts";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { TurnResources } from "./turn-resources.ts";

const secret = "a".repeat(64);
const registration = () => ({ id: randomUUID(), name: "Desktop", environmentId: randomUUID(), folders: [], terminal: false, computer: false });
afterEach(() => vi.useRealTimers());
describe("shared computer authority and lifecycle", () => {
  it("requires both the owning paired session and the connector secret", async () => {
    const broker = new SharedComputers(id => id === "owner");
    const computer = registration(); broker.register(computer, "owner", secret);
    for (const [owner, key] of [["intruder", secret], ["owner", "wrong"], ["owner", "é".repeat(64)]]) {
      await expect(broker.poll(computer.id, owner, key)).rejects.toMatchObject({ status: 403 });
    }
    expect(() => broker.register(computer, "intruder", secret)).toThrow(/not authorized/);
    expect(JSON.stringify(broker.list())).not.toContain(secret);
    broker.close();
  });
  it("delivers a job once, refuses concurrent work, and never replays after disconnect", async () => {
    const broker = new SharedComputers(() => true);
    const computer = registration(); broker.register(computer, "owner", secret);
    const operation = { computer_id: computer.id, action: "list_files" as const };
    const result = broker.request(operation, () => true);
    await expect(broker.request(operation, () => true)).rejects.toThrow(/busy/);
    const job = await broker.poll(computer.id, "owner", secret);
    expect(job?.operation).toEqual(operation);
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(true);
    broker.complete(computer.id, "owner", secret, job!.id, { ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    expect(() => broker.complete(computer.id, "owner", secret, job!.id, {})).toThrow(/expired/);
    const pending = broker.request(operation, () => true);
    const rejection = expect(pending).rejects.toThrow(/in-flight/);
    await broker.poll(computer.id, "owner", secret);
    broker.disconnect(computer.id, "owner", secret); await rejection;
    expect(broker.list()).toEqual([]);
    await expect(broker.request(operation, () => true)).rejects.toThrow(/offline/);
    broker.close();
  });
  it("turn cancellation rejects queued and already delivered actions", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = registration(); broker.register(computer, "owner", secret);
    let active = true;
    const pending = broker.request({ computer_id: computer.id, action: "list_files" }, () => active);
    const rejection = expect(pending).rejects.toThrow(/turn ended/);
    const job = await broker.poll(computer.id, "owner", secret);
    active = false;
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(false);
    broker.complete(computer.id, "owner", secret, job!.id, {}); await rejection;
    active = true;
    const queued = broker.request({ computer_id: computer.id, action: "list_files" }, () => active);
    const stopped = expect(queued).rejects.toThrow(/turn ended/);
    active = false;
    const poll = broker.poll(computer.id, "owner", secret);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(poll).resolves.toBeNull(); await stopped;
    broker.close();
  });
  it("expires offline registrations and rejects revoked sessions", async () => {
    vi.useFakeTimers(); let valid = true;
    const broker = new SharedComputers(() => valid);
    const computer = registration(); broker.register(computer, "owner", secret);
    valid = false; expect(broker.list()).toEqual([]);
    await expect(broker.poll(computer.id, "owner", secret)).rejects.toThrow(/not authorized/);
    valid = true; await vi.advanceTimersByTimeAsync(40_001);
    expect(broker.list()).toEqual([]); broker.close();
  });
});

it("shared screen calls respect local turns, human takeover, lease expiry and release", async () => {
  vi.useFakeTimers();
  const resources = new TurnResources(); let held = false;
  const control = new SharedComputerControl(resources, () => held);
  const local = { threadId: "local", generation: "first" };
  resources.claim("computer:host", local);
  expect(() => control.acquire("remote")).toThrow(/in use locally/);
  resources.release(local); control.acquire("remote");
  expect(resources.claim("computer:host", local)).toBe(false);
  held = true; expect(() => control.acquire("remote")).toThrow(/held by a person/);
  held = false; control.acquire("remote");
  await vi.advanceTimersByTimeAsync(40_001);
  expect(resources.claim("computer:host", local)).toBe(true);
  resources.release(local); control.acquire("remote"); control.close();
  expect(resources.claim("computer:host", local)).toBe(true);
});
