import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LentComputers, provenRequestPerson, SharedComputers, sharedComputerOperation, sharedComputerScopeRefusal } from "./shared-computers.ts";
import { hostScreenBusyText, SharedComputerControl } from "./shared-computer-control.ts";
import { TurnResources } from "./turn-resources.ts";

const secret = "a".repeat(64);
const other = "b".repeat(64);
const registration = (scopes: Partial<{ folders: { id: string; name: string; write: boolean }[]; terminal: boolean; computer: boolean; fileEdits: true }> = {}) =>
  ({ id: randomUUID(), name: "Desktop", environmentId: randomUUID(), folders: [], terminal: false, computer: false, ...scopes });
const alice = { session: "owner", person: "p_alice" };
const bob = { session: "intruder", person: "p_bob" };
afterEach(() => vi.useRealTimers());
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
  it("chromeLender names the newest computer that lends Chrome, and whether it is online", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-chrome-"));
    let live = true;
    const broker = new SharedComputers(() => live, new LentComputers(join(dir, "lent.json")));
    const a = { ...registration(), name: "A", platform: "darwin" as const, chrome: true };
    const b = { ...registration(), name: "B", platform: "darwin" as const, chrome: false };
    broker.register(a, alice, secret);
    broker.register(b, { session: "owner2", person: alice.person }, secret);
    expect(broker.chromeLender(alice.person)).toEqual({ name: "A", device: "Mac", online: true });
    expect(broker.chromeLender(bob.person)).toBeNull();
    live = false;
    expect(broker.chromeLender(alice.person)).toEqual({ name: "A", device: "Mac", online: false });
    live = true;
    broker.disconnect(a.id, alice.session, secret);
    expect(broker.chromeLender(alice.person)).toBeNull();
    broker.close();
    rmSync(dir, { recursive: true, force: true });
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
  it("waits for a command as long as the command may run, and a non-command action still 45 seconds", async () => {
    vi.useFakeTimers();
    const lent = () => {
      const broker = new SharedComputers(() => true);
      const computer = { ...registration({ terminal: true, computer: true }), commandTimeouts: true as const }; broker.register(computer, alice, secret);
      const run = async (operation: Omit<Parameters<SharedComputers["request"]>[0], "computer_id">) => {
        const result = broker.request({ computer_id: computer.id, ...operation }, alice.person, () => true);
        result.catch(() => {});
        const job = await broker.poll(computer.id, alice.session, secret);
        broker.liveJob(computer.id, alice.session, secret, job!.id);
        return { result, job: job!, complete: (value: unknown) => broker.complete(computer.id, alice.session, secret, job!.id, value), close: () => broker.close() };
      };
      return run;
    };
    const long = await lent()({ action: "run_command", command: "./weekly-scan", timeout_seconds: 200 });
    expect(long.job.operation).toMatchObject({ timeout_seconds: 200 });
    await vi.advanceTimersByTimeAsync(199_000);
    long.complete({ exitCode: 0 });
    await expect(long.result).resolves.toEqual({ exitCode: 0 });
    long.close();
    const defaulted = await lent()({ action: "run_command", command: "./scan" });
    await vi.advanceTimersByTimeAsync(134_000);
    defaulted.complete({ exitCode: 0 });
    await expect(defaulted.result).resolves.toEqual({ exitCode: 0 });
    defaulted.close();
    const tools = await lent()({ action: "computer_tools" });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(tools.result).rejects.toThrow(/timed out/);
    tools.close();
  });
  it("runs a command up to 900 seconds on a desktop that takes long commands, and refuses past 240 on one that does not", async () => {
    expect(sharedComputerOperation.safeParse({ computer_id: randomUUID(), action: "run_command", command: "./scan", timeout_seconds: 900 }).success).toBe(true);
    expect(sharedComputerOperation.safeParse({ computer_id: randomUUID(), action: "run_command", command: "./scan", timeout_seconds: 901 }).success).toBe(false);
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = { ...registration({ terminal: true }), commandTimeouts: true as const, longCommands: true as const }; broker.register(computer, alice, secret);
    const result = broker.request({ computer_id: computer.id, action: "run_command", command: "./evals", timeout_seconds: 900 }, alice.person, () => true);
    result.catch(() => {});
    const job = await broker.poll(computer.id, alice.session, secret);
    expect(job!.operation).toMatchObject({ timeout_seconds: 900 });
    broker.liveJob(computer.id, alice.session, secret, job!.id);
    await vi.advanceTimersByTimeAsync(899_000);
    broker.complete(computer.id, alice.session, secret, job!.id, { exitCode: 0 });
    await expect(result).resolves.toEqual({ exitCode: 0 });
    broker.close();
    const older = new SharedComputers(() => true);
    const capped = { ...registration({ terminal: true }), commandTimeouts: true as const }; older.register(capped, alice, secret);
    await expect(older.request({ computer_id: capped.id, action: "run_command", command: "./evals", timeout_seconds: 241 }, alice.person, () => true))
      .rejects.toThrow(/at most 240 seconds/);
    older.close();
  });
  it("never sends a timeout to a desktop that did not say it takes one, and waits for it as before", async () => {
    const broker = new SharedComputers(() => true);
    const computer = registration({ terminal: true }); broker.register(computer, alice, secret);
    vi.useFakeTimers();
    const command = broker.request({ computer_id: computer.id, action: "run_command", command: "./scan", timeout_seconds: 200 }, alice.person, () => true);
    const rejection = expect(command).rejects.toThrow(/timed out/);
    const job = await broker.poll(computer.id, alice.session, secret);
    expect(job?.operation).toEqual({ computer_id: computer.id, action: "run_command", command: "./scan" });
    broker.liveJob(computer.id, alice.session, secret, job!.id);
    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;
    broker.close();
  });
  it("never sends old_text or new_text to a desktop that did not say it takes passage edits", async () => {
    const folder = { id: randomUUID(), name: "Drafts", write: true };
    for (const [scopes, sent] of [[{}, false], [{ fileEdits: true as const }, true]] as const) {
      const broker = new SharedComputers(() => true);
      const computer = registration({ folders: [folder], ...scopes }); broker.register(computer, alice, secret);
      const write = broker.request({ computer_id: computer.id, action: "write_file", folder_id: folder.id, path: "a.md", content: "x", new_text: "y" }, alice.person, () => true);
      write.catch(() => {});
      const job = await broker.poll(computer.id, alice.session, secret);
      expect("new_text" in job!.operation).toBe(sent);
      broker.close();
    }
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

describe("a dropped channel recovers by itself", () => {
  const screen = () => { const broker = new SharedComputers(() => true); const computer = registration({ computer: true }); broker.register(computer, alice, secret); return { broker, computer }; };
  it("a reconnecting desktop's poll retires the one whose client dropped, which takes no job", async () => {
    const { broker, computer } = screen();
    const dropped = broker.poll(computer.id, alice.session, secret);
    const fresh = broker.poll(computer.id, alice.session, secret);
    await expect(dropped).resolves.toBeNull();
    const result = broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => true);
    const job = await fresh;
    expect(job?.operation.action).toBe("computer_tools");
    expect(broker.liveJob(computer.id, alice.session, secret, job!.id)).toBe(true);
    broker.complete(computer.id, alice.session, secret, job!.id, { ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    broker.close();
  });
  it("a server that stops answers its held poll and every later call as restarting, never as a lost sign-in", async () => {
    const { broker, computer } = screen();
    const held = broker.poll(computer.id, alice.session, secret);
    broker.close();
    await expect(held).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/restarting/) });
    await expect(broker.poll(computer.id, alice.session, secret)).rejects.toMatchObject({ status: 503 });
    expect(() => broker.liveJob(computer.id, alice.session, secret, randomUUID())).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => broker.register(computer, alice, secret)).toThrow(expect.objectContaining({ status: 503 }));
    expect(broker.list(alice.person)).toEqual([]);
  });
  it("a poll whose client went away answers nothing, so its job waits for the next poll", async () => {
    const { broker, computer } = screen();
    const gone = new AbortController();
    const dropped = broker.poll(computer.id, alice.session, secret, gone.signal);
    gone.abort();
    await expect(dropped).resolves.toBeNull();
    const result = broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => true);
    const job = await broker.poll(computer.id, alice.session, secret);
    broker.complete(computer.id, alice.session, secret, job!.id, "done");
    await expect(result).resolves.toBe("done");
    broker.close();
  });
  it("a job never leased is offered again under a new id, and the lost delivery can never start it", async () => {
    vi.useFakeTimers();
    const { broker, computer } = screen();
    const result = broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => true);
    const lost = await broker.poll(computer.id, alice.session, secret);
    await vi.advanceTimersByTimeAsync(10_000);
    const again = await broker.poll(computer.id, alice.session, secret);
    expect(again?.operation).toEqual(lost?.operation);
    expect(again!.id).not.toBe(lost!.id);
    expect(broker.liveJob(computer.id, alice.session, secret, lost!.id)).toBe(false);
    expect(broker.liveJob(computer.id, alice.session, secret, again!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const nothing = broker.poll(computer.id, alice.session, secret);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(nothing).resolves.toBeNull();
    broker.complete(computer.id, alice.session, secret, again!.id, "once");
    await expect(result).resolves.toBe("once");
    broker.close();
  });
  it("waits for a computer that is reconnecting, and names one that stays offline", async () => {
    vi.useFakeTimers();
    const { broker, computer } = screen();
    await vi.advanceTimersByTimeAsync(40_001);
    const waiting = broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => true);
    await vi.advanceTimersByTimeAsync(3_000);
    broker.register(computer, alice, secret);
    await vi.advanceTimersByTimeAsync(250);
    const job = await broker.poll(computer.id, alice.session, secret);
    broker.complete(computer.id, alice.session, secret, job!.id, "back");
    await expect(waiting).resolves.toBe("back");
    await vi.advanceTimersByTimeAsync(45_000);
    const offline = expect(broker.request({ computer_id: computer.id, action: "computer_tools" }, alice.person, () => true)).rejects.toThrow(/^Desktop is lent but has been offline for 1 min: OpenMausBot on it is closed/);
    await vi.advanceTimersByTimeAsync(15_000);
    await offline;
    broker.close();
  });
});
describe("owner partition (audit H1, H2)", () => {
  it("another person's bot turn cannot list or use a lent computer", async () => {
    const broker = new SharedComputers(() => true);
    const computer = registration({ terminal: true, computer: true, folders: [{ id: randomUUID(), name: "Docs", write: true }] });
    broker.register(computer, alice, secret);
    expect(broker.list(alice.person)).toHaveLength(1);
    expect(broker.list(bob.person)).toEqual([]);
    expect(broker.list(null)).toEqual([]);
    await expect(broker.request({ computer_id: computer.id, action: "run_command", command: "id" }, bob.person, () => true)).rejects.toThrow(/offline/);
    await expect(broker.request({ computer_id: computer.id, action: "run_command", command: "id" }, null, () => true)).rejects.toMatchObject({ status: 403 });
    await expect(nothingQueued(broker, computer.id)).resolves.toBeNull();
    broker.close();
  });
  it("a second session cannot squat a lent computer's id, even after its owner goes offline", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = registration({ folders: [{ id: randomUUID(), name: "Docs", write: true }] });
    broker.register(computer, alice, secret);
    await vi.advanceTimersByTimeAsync(40_001);
    broker.register(computer, bob, other);
    const refused = expect(broker.request({ computer_id: computer.id, action: "write_file", folder_id: computer.folders[0]!.id, path: "a.txt", content: "secret" }, alice.person, () => true)).rejects.toThrow(/offline/);
    await vi.advanceTimersByTimeAsync(15_000);
    await refused;
    expect(broker.list(alice.person)).toEqual([]);
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
    expect(broker.status(alice.person)).toEqual([{ id: mac.id, name: "Desktop", online: true, busy: false, lastSeenAt: expect.any(Number), scopes: { folders: [docs], terminal: false, screen: true, internet: false, chrome: false } }]);
    expect(broker.status(null)).toEqual([]);
    expect(JSON.stringify(broker.status(alice.person))).not.toContain(secret);
    await vi.advanceTimersByTimeAsync(40_001);
    expect(broker.status(alice.person)).toMatchObject([{ id: mac.id, online: false }]);
    expect(broker.list(alice.person)).toEqual([]);
    live = false;
    expect(broker.status(alice.person)).toEqual([]);
    broker.close();
  });
});

describe("server-side scope check (audit M1)", () => {
  const readOnly = { id: randomUUID(), name: "Docs", write: false };
  const writable = { id: randomUUID(), name: "Drafts", write: true };
  const lent = registration({ folders: [readOnly, writable] });
  it("refuses shell, screen and writes a read-only grant never lent", () => {
    expect(sharedComputerScopeRefusal(lent, { action: "run_command" })).toMatch(/terminal/);
    expect(sharedComputerScopeRefusal(lent, { action: "computer_call" })).toMatch(/screen/);
    expect(sharedComputerScopeRefusal(lent, { action: "computer_tools" })).toMatch(/screen/);
    expect(sharedComputerScopeRefusal(lent, { action: "write_file", folder_id: readOnly.id })).toMatch(/read-only/);
    expect(sharedComputerScopeRefusal(lent, { action: "read_file", folder_id: randomUUID() })).toMatch(/not been shared/);
    expect(sharedComputerScopeRefusal(lent, { action: "read_file", folder_id: readOnly.id })).toBeNull();
    expect(sharedComputerScopeRefusal(lent, { action: "write_file", folder_id: writable.id })).toBeNull();
  });
  it("edits, appends and deletes only in a folder lent with editing, and only on a desktop that takes them", () => {
    const current = registration({ folders: [readOnly, writable], fileEdits: true });
    for (const action of ["edit_file", "append_file", "delete_file"] as const) {
      expect(sharedComputerScopeRefusal(current, { action, folder_id: readOnly.id })).toMatch(/read-only/);
      expect(sharedComputerScopeRefusal(current, { action, folder_id: randomUUID() })).toMatch(/not been shared/);
      expect(sharedComputerScopeRefusal(current, { action, folder_id: writable.id })).toBeNull();
      expect(sharedComputerScopeRefusal(lent, { action, folder_id: writable.id })).toMatch(/older OpenMausBot .* write_file/);
    }
  });
  it("names the computer when its terminal isn't lent, sends the bot to no switch, and tells it not to run the command another way", () => {
    const refusal = sharedComputerScopeRefusal({ ...lent, name: "Ubuntu NUC", platform: "linux" }, { action: "run_command" });
    expect(refusal).toContain("Ubuntu NUC");
    expect(refusal).not.toMatch(/Settings|turn it on/u);
    expect(refusal).toMatch(/Do not try to run the command another way or anywhere else/);
    expect(sharedComputerScopeRefusal({ ...lent, terminal: true }, { action: "run_command" })).toBeNull();
  });
  it("says where the person lends apps and screen, in the refusal and in the list a bot reads", () => {
    const steps = "OpenMausBot on that Mac lends them by itself once macOS allows it Accessibility and Screen Recording: tell the person in one sentence to allow both for OpenMausBot in System Settings → Privacy & Security on that Mac, and to update OpenMausBot there if it is an older version.";
    expect(sharedComputerScopeRefusal({ ...lent, platform: "darwin" }, { action: "computer_call" })).toBe(`Apps and screen are not lent to this server. ${steps}`);
    expect(sharedComputerScopeRefusal({ ...lent, platform: "win32" }, { action: "computer_call" })).toContain("OpenMausBot on that PC lends them by itself once its computer control works");
    expect(sharedComputerScopeRefusal(lent, { action: "computer_call" })).not.toMatch(/Settings|use-my-computer/u);
    const broker = new SharedComputers(() => true);
    const mac = { ...registration(), platform: "darwin" as const };
    broker.register(mac, alice, secret);
    expect(broker.screenNotLent(alice.person)).toEqual({ screen: `Desktop does not lend its apps and screen. ${steps}` });
    expect(broker.screenNotLent(bob.person)).toEqual({});
    expect(broker.screenNotLent(null)).toEqual({});
    const lending = new SharedComputers(() => true);
    lending.register(registration({ computer: true }), alice, secret);
    expect(lending.screenNotLent(alice.person)).toEqual({});
    broker.close(); lending.close();
  });
  it("on the person's own Cloud, every computer that can't give what's needed sends the bot to ask with a card, never to explain the fix", async () => {
    const ask = 'call ask_for_computer with need "screen"';
    expect(sharedComputerScopeRefusal({ ...lent, platform: "win32" }, { action: "computer_call" }, "ask_for_computer"))
      .toBe("Apps and screen are not lent to this Cloud right now. Call ask_for_computer with need \"screen\" and what you want to do: it asks them with a one-tap Turn on, and you carry on once it's on. Don't explain the fix in chat, and don't use your own cloud computer instead unless they ask.");
    expect(sharedComputerScopeRefusal({ ...lent, name: "HOME-PC" }, { action: "run_command" }, "ask_for_computer")).toContain('Call ask_for_computer with need "terminal"');
    const broker = new SharedComputers(() => true);
    broker.askTool = "ask_for_computer";
    const changes: number[] = [];
    broker.changed = () => changes.push(Date.now());
    const pc = { ...registration(), platform: "win32" as const };
    broker.register(pc, alice, secret);
    expect(broker.screenNotLent(alice.person).screen).toBe(`Desktop doesn't lend its apps and screen right now. To use them, ${ask} and what you want to do: it asks them with a one-tap Turn on, and you carry on once it's on. Don't explain the fix in chat, and don't use your own cloud computer instead unless they ask.`);
    expect(broker.lendingNow(alice.person)).toEqual([{ id: pc.id, name: "Desktop", platform: "win32", computer: false, terminal: false }]);
    expect(broker.lendingNow(bob.person)).toEqual([]);
    broker.disconnect(pc.id, alice.session, secret);
    expect(changes, "connecting and stopping both tell the asks").toHaveLength(2);
    await expect(broker.request({ computer_id: pc.id, action: "computer_call", tool_name: "list_apps" }, alice.person, () => false)).rejects.toThrow(/Call ask_for_computer with need "screen"/);
    broker.close();
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

it("shared screen calls respect local turns, lease expiry and release, and say which bot holds the screen", async () => {
  vi.useFakeTimers();
  const resources = new TurnResources();
  const control = new SharedComputerControl(resources, (owner) => (owner.threadId === "local" ? "Researcher" : undefined));
  const local = { threadId: "local", generation: "first" };
  resources.claim("computer:host", local);
  expect(control.acquire("remote")).toBe(hostScreenBusyText("Researcher"));
  expect(control.acquire("remote")).toMatch(/^Another bot on this computer, Researcher, is using its screen right now, so this call was not performed\. It is not a person\./);
  resources.release(local); expect(control.acquire("remote")).toBeUndefined();
  expect(resources.claim("computer:host", local)).toBe(false);
  await vi.advanceTimersByTimeAsync(40_001);
  expect(resources.claim("computer:host", local)).toBe(true);
  resources.release(local); expect(control.acquire("remote")).toBeUndefined(); control.close();
  expect(resources.claim("computer:host", local)).toBe(true);
  resources.release(local);
  // A turn of a bot this server does not name (a waiting one, say) is still another bot, never a person.
  resources.claim("computer:host", { threadId: "gone", generation: "g" });
  expect(control.acquire("remote")).toBe(hostScreenBusyText());
});

it("a lent call's screen lock left behind by an earlier lent call frees itself for the next one", () => {
  const resources = new TurnResources();
  const control = new SharedComputerControl(resources);
  const earlier = randomUUID(), next = randomUUID();
  expect(control.acquire(earlier)).toBeUndefined();
  // The desktop never released it (it crashed, or the release timed out): the next lent call still gets the screen.
  expect(control.acquire(next)).toBeUndefined();
  expect(resources.holder("computer:host")).toEqual({ threadId: `shared:${next}`, generation: next });
  expect(control.acquire(next)).toBeUndefined();
  control.release(next);
  expect(resources.free("computer:host")).toBe(true);
});
