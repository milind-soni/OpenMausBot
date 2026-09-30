import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provenRequestPerson, SharedComputers, sharedComputerScopeRefusal } from "./shared-computers.ts";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { TurnResources } from "./turn-resources.ts";

const secret = "a".repeat(64);
const other = "b".repeat(64);
const registration = (scopes: Partial<{ folders: { id: string; name: string; write: boolean }[]; terminal: boolean; computer: boolean }> = {}) =>
  ({ id: randomUUID(), name: "Desktop", environmentId: randomUUID(), folders: [], terminal: false, computer: false, ...scopes });
const alice = { session: "owner", person: "p_alice" };
const bob = { session: "intruder", person: "p_bob" };
afterEach(() => vi.useRealTimers());
/** The desktop's next long poll, run to its end: null means no job waited. */
const nothingQueued = async (broker: SharedComputers, id: string) => {
  vi.useFakeTimers();
  const poll = broker.poll(id, alice.session, secret);
  await vi.advanceTimersByTimeAsync(20_000);
  return poll;
};
describe("shared computer authority and lifecycle", () => {
  it("requires both the owning paired session and the connector secret", async () => {
    const broker = new SharedComputers(id => id === "owner");
    const computer = registration(); broker.register(computer, alice, secret);
    for (const [session, key] of [["intruder", secret], ["owner", "wrong"], ["owner", "é".repeat(64)]]) {
      await expect(broker.poll(computer.id, session, key)).rejects.toMatchObject({ status: 403 });
    }
    expect(JSON.stringify(broker.list(alice.person))).not.toContain(secret);
    broker.close();
  });
  it("delivers a job once, refuses concurrent work, and never replays after disconnect", async () => {
    const broker = new SharedComputers(() => true);
    const computer = registration(); broker.register(computer, alice, secret);
    const operation = { computer_id: computer.id, action: "computer_tools" as const };
    const lent = registration({ computer: true }); lent.id = computer.id; broker.register(lent, alice, secret);
    const result = broker.request(operation, alice.person, () => true);
    await expect(broker.request(operation, alice.person, () => true)).rejects.toThrow(/busy/);
    const job = await broker.poll(computer.id, "owner", secret);
    expect(job?.operation).toEqual(operation);
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(true);
    broker.complete(computer.id, "owner", secret, job!.id, { ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    expect(() => broker.complete(computer.id, "owner", secret, job!.id, {})).toThrow(/expired/);
    const pending = broker.request(operation, alice.person, () => true);
    const rejection = expect(pending).rejects.toThrow(/in-flight/);
    await broker.poll(computer.id, "owner", secret);
    broker.disconnect(computer.id, "owner", secret); await rejection;
    expect(broker.list(alice.person)).toEqual([]);
    await expect(broker.request(operation, alice.person, () => true)).rejects.toThrow(/offline/);
    broker.close();
  });
  it("turn cancellation rejects queued and already delivered actions", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = registration({ computer: true }); broker.register(computer, alice, secret);
    let active = true;
    const pending = broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => active);
    const rejection = expect(pending).rejects.toThrow(/turn ended/);
    const job = await broker.poll(computer.id, "owner", secret);
    active = false;
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(false);
    broker.complete(computer.id, "owner", secret, job!.id, {}); await rejection;
    active = true;
    const queued = broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => active);
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
    const computer = registration(); broker.register(computer, alice, secret);
    valid = false; expect(broker.list(alice.person)).toEqual([]);
    await expect(broker.poll(computer.id, "owner", secret)).rejects.toThrow(/not authorized/);
    valid = true; await vi.advanceTimersByTimeAsync(40_001);
    expect(broker.list(alice.person)).toEqual([]); broker.close();
  });
});

describe("owner partition (audit H1, H2)", () => {
  it("another person's bot turn cannot list or use a lent computer", async () => {
    const broker = new SharedComputers(() => true);
    const computer = registration({ terminal: true, computer: true, folders: [{ id: randomUUID(), name: "Docs", write: true }] });
    broker.register(computer, alice, secret);
    expect(broker.list(alice.person)).toHaveLength(1);
    expect(broker.list(bob.person)).toEqual([]);
    // A turn that acts for nobody provable (routine, webhook, room, peer) sees nothing.
    expect(broker.list(null)).toEqual([]);
    // Knowing the id is not enough: another person's computer answers like one that does not exist.
    await expect(broker.request({ computer_id: computer.id, action: "run_command", command: "id" }, bob.person, () => true)).rejects.toThrow(/offline/);
    await expect(broker.request({ computer_id: computer.id, action: "run_command", command: "id" }, null, () => true)).rejects.toMatchObject({ status: 403 });
    // Nothing was queued for the desktop.
    await expect(nothingQueued(broker, computer.id)).resolves.toBeNull();
    broker.close();
  });
  it("a second session cannot squat a lent computer's id, even after its owner goes offline", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = registration({ folders: [{ id: randomUUID(), name: "Docs", write: true }] });
    broker.register(computer, alice, secret);
    await vi.advanceTimersByTimeAsync(40_001); // Alice's laptop is asleep
    broker.register(computer, bob, other); // Bob registers a fake desktop under Alice's id
    // Alice's bots never reach Bob's fake desktop: their operations stay unqueued.
    await expect(broker.request({ computer_id: computer.id, action: "write_file", folder_id: computer.folders[0]!.id, path: "a.txt", content: "secret" }, alice.person, () => true)).rejects.toThrow(/offline/);
    expect(broker.list(alice.person)).toEqual([]);
    // Alice's desktop comes back with its own key and is not locked out.
    broker.register(computer, alice, secret);
    expect(broker.list(alice.person)).toHaveLength(1);
    await expect(broker.poll(computer.id, bob.session, secret)).rejects.toMatchObject({ status: 403 });
    broker.close();
  });
  it("a new grant from the same desktop replaces its earlier one; other desktops are untouched", async () => {
    const broker = new SharedComputers(() => true);
    const first = registration({ computer: true }); broker.register(first, alice, secret);
    const bobs = registration({ computer: true }); broker.register(bobs, bob, other);
    const pending = broker.request({ computer_id: first.id, action: "computer_tools" }, alice.person, () => true);
    const replaced = expect(pending).rejects.toThrow(/access changed/);
    const second = registration({ computer: true }); broker.register(second, alice, other);
    await replaced;
    expect(broker.list(alice.person).map(entry => entry.id)).toEqual([second.id]);
    expect(broker.list(bob.person).map(entry => entry.id)).toEqual([bobs.id]);
    await expect(broker.poll(first.id, alice.session, secret)).rejects.toMatchObject({ status: 403 });
    broker.close();
  });
  it("one session cannot fill the registry for everyone else", () => {
    const broker = new SharedComputers(() => true);
    for (let index = 0; index < 50; index++) broker.register(registration(), alice, secret);
    expect(() => broker.register(registration(), bob, other)).not.toThrow();
    expect(broker.list(bob.person)).toHaveLength(1);
    broker.close();
  });
});

describe("a bot turn's principal fails closed (audit H1)", () => {
  const people: Record<string, string | undefined> = { "from-alice": "p_alice", "from-routine": undefined };
  const personOf = (id: string) => people[id];
  it("names the person whose own message started this exact turn", () => {
    expect(provenRequestPerson({ messageId: "from-alice", generations: new Set(["g1", "g2"]) }, "g2", personOf)).toBe("p_alice");
  });
  it("names nobody for another generation, a stopped or unproven request, or a line no person sent", () => {
    expect(provenRequestPerson({ messageId: "from-alice", generations: new Set(["g1"]) }, "g-later", personOf)).toBeNull();
    expect(provenRequestPerson({ messageId: "from-alice", generations: new Set(["g1"]), stopped: true }, "g1", personOf)).toBeNull();
    expect(provenRequestPerson({ generations: new Set(["g1"]) }, "g1", personOf)).toBeNull();
    expect(provenRequestPerson({ messageId: "from-routine", generations: new Set(["g1"]) }, "g1", personOf)).toBeNull();
    expect(provenRequestPerson(undefined, "g1", personOf)).toBeNull();
  });
});

describe("status for the next step's placement", () => {
  it("reports one person's lent computers, online or asleep, with scopes and no secrets", async () => {
    vi.useFakeTimers();
    let live = true;
    const broker = new SharedComputers(session => session !== alice.session || live);
    const docs = { id: randomUUID(), name: "Docs", write: true };
    const mac = registration({ computer: true, folders: [docs] }); broker.register(mac, alice, secret);
    broker.register(registration({ terminal: true }), bob, other);
    expect(broker.status(alice.person)).toEqual([{ id: mac.id, name: "Desktop", online: true, busy: false, lastSeenAt: expect.any(Number), scopes: { folders: [docs], terminal: false, screen: true } }]);
    expect(broker.status(null)).toEqual([]);
    expect(JSON.stringify(broker.status(alice.person))).not.toContain(secret);
    await vi.advanceTimersByTimeAsync(40_001); // the Mac went to sleep
    expect(broker.status(alice.person)).toMatchObject([{ id: mac.id, online: false }]);
    expect(broker.list(alice.person)).toEqual([]);
    live = false; // the Mac's session was revoked on the Cloud
    expect(broker.status(alice.person)).toEqual([]);
    broker.close();
  });
});

describe("server-side scope check (audit M1)", () => {
  const readOnly = { id: randomUUID(), name: "Docs", write: false };
  const writable = { id: randomUUID(), name: "Drafts", write: true };
  const lent = registration({ folders: [readOnly, writable] });
  it("refuses shell, screen and writes a read-only grant never lent", () => {
    expect(sharedComputerScopeRefusal(lent, { action: "run_command" })).toMatch(/Terminal/);
    expect(sharedComputerScopeRefusal(lent, { action: "computer_call" })).toMatch(/screen/);
    expect(sharedComputerScopeRefusal(lent, { action: "computer_tools" })).toMatch(/screen/);
    expect(sharedComputerScopeRefusal(lent, { action: "write_file", folder_id: readOnly.id })).toMatch(/read-only/);
    expect(sharedComputerScopeRefusal(lent, { action: "read_file", folder_id: randomUUID() })).toMatch(/not been shared/);
    expect(sharedComputerScopeRefusal(lent, { action: "read_file", folder_id: readOnly.id })).toBeNull();
    expect(sharedComputerScopeRefusal(lent, { action: "write_file", folder_id: writable.id })).toBeNull();
  });
  it("never queues an out-of-scope operation for the desktop", async () => {
    const broker = new SharedComputers(() => true);
    broker.register(lent, alice, secret);
    await expect(broker.request({ computer_id: lent.id, action: "run_command", command: "id" }, alice.person, () => true)).rejects.toMatchObject({ status: 403 });
    await expect(broker.request({ computer_id: lent.id, action: "write_file", folder_id: readOnly.id, path: "x", content: "y" }, alice.person, () => true)).rejects.toThrow(/read-only/);
    await expect(nothingQueued(broker, lent.id)).resolves.toBeNull();
    broker.close();
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
