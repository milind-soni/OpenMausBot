// The floor's enforcement, fed fake permission requests and a fake adapter.
// No command in this file is ever run: the adapter only records the answer
// it was given.
import { homedir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs, loadConfig, parseConfigPatch, parseStoredConfig, saveConfig, type AppConfig } from "./config.ts";
import type { RequestOutcome } from "./contracts.ts";
import { flushDecisionLog, readDecisions } from "./decision-log.ts";
import { autoVerdict } from "./auto-approve.ts";
import { bindSafetyFloor, denyAtSafetyFloor, floorBlockForToolCall, heldAtSafetyFloor, safetyFloorBlock, safetyFloorClears, safetyFloorEnabled, safetyFloorOn, shellCommandOfToolCall } from "./safety-floor-gate.ts";
import { floorReading } from "./safety-floor.ts";

const ON: AppConfig = { safetyFloor: { enabled: true } };
/** The server's platform is given to every bind that expects the floor to
 * act, so these tests say the same thing on a Windows runner, where the
 * gate is inert. */
const HOST = "linux" as const;
/** A command the reader is made to fail on, to stand for any it cannot read. */
const GARBLED = "unreadable-fixture --flag";
/** The floor switched on, with a reader that cannot read GARBLED. */
const bindWithBrokenReader = () => bindSafetyFloor(() => ON, (command, platform, home) =>
  command === GARBLED ? { read: false } : floorReading(command, platform, home), HOST);
// A shell that already exports the switch must not turn the floor on here.
beforeEach(() => { delete process.env.OMB_SAFETY_FLOOR; });
afterEach(() => bindSafetyFloor(() => ({})));

type Decision = { behavior: "allow" | "deny" | "answer"; message?: string };

/** A provider adapter that runs nothing: it records each answer it is given
 * and each turn it is told to stop. */
function fakeAdapter(respond: (decision: Decision) => RequestOutcome | Promise<RequestOutcome> = () => "rejected") {
  const answers: Array<{ threadId: string; requestId: string; decision: Decision }> = [];
  const interrupted: Array<{ threadId: string; turnId?: string }> = [];
  return {
    answers,
    interrupted,
    respondToRequest: async (threadId: string, requestId: string, decision: Decision) => {
      answers.push({ threadId, requestId, decision });
      return respond(decision);
    },
    interruptTurn: async (threadId: string, turnId?: string) => {
      interrupted.push({ threadId, turnId });
    },
  };
}

/** One fake permission request, as a driver would raise it for a shell command. */
function request(command: string | undefined, overrides: { adapter?: ReturnType<typeof fakeAdapter>; isCurrent?: () => boolean; noCwd?: boolean; release?: () => void } = {}) {
  const adapter = overrides.adapter ?? fakeAdapter();
  const said: unknown[] = [];
  let released!: () => void;
  const settled = new Promise<void>((resolve) => { released = resolve; });
  const threadId = `thread-${Math.random().toString(36).slice(2)}`;
  const blocked = denyAtSafetyFloor({
    // With no known working directory a driver attaches no `command`
    // descriptor, only the line the engine asked to run.
    event: { threadId, turnId: "turn-1", tool: "Bash", summary: command ?? "mcp tool",
      ...(command === undefined ? {} : overrides.noCwd ? { commandLine: command } : { command: { command, cwd: "/work" }, commandLine: command }) },
    requestId: "request-1",
    bot: { id: "bot-1", name: "Ada" },
    adapter,
    isCurrent: overrides.isCurrent ?? (() => true),
    say: (message) => said.push(message),
    release: () => { released(); overrides.release?.(); },
  });
  const rows = async () => {
    await flushDecisionLog(DATA_DIR);
    return readDecisions(DATA_DIR, 200).filter((row) => row.threadId === threadId);
  };
  return { blocked, adapter, said, settled, threadId, rows };
}

describe("the safetyFloor setting", () => {
  it("is off until switched on, in config.json or with OMB_SAFETY_FLOOR=1", () => {
    expect(safetyFloorEnabled({}, {})).toBe(false);
    expect(safetyFloorEnabled({ safetyFloor: {} }, {})).toBe(false);
    expect(safetyFloorEnabled({ safetyFloor: { enabled: false } }, {})).toBe(false);
    expect(safetyFloorEnabled({ safetyFloor: { enabled: true } }, {})).toBe(true);
    // the environment switches it on over the file, and nothing else it says counts
    expect(safetyFloorEnabled({}, { OMB_SAFETY_FLOOR: "1" })).toBe(true);
    expect(safetyFloorEnabled({ safetyFloor: { enabled: false } }, { OMB_SAFETY_FLOOR: " 1 " })).toBe(true);
    for (const value of ["", "0", "true", "yes", "on"]) {
      expect(safetyFloorEnabled({}, { OMB_SAFETY_FLOOR: value }), value).toBe(false);
      expect(safetyFloorEnabled(ON, { OMB_SAFETY_FLOOR: value }), value).toBe(true);
    }
  });

  it("is a typed config key that a settings save keeps", () => {
    expect(parseStoredConfig({}).safetyFloor).toBeUndefined();
    expect(parseStoredConfig({ safetyFloor: { enabled: true } })).toEqual({ safetyFloor: { enabled: true } });
    expect(parseConfigPatch({ safetyFloor: { enabled: true } })).toEqual({ safetyFloor: { enabled: true } });
    expect(() => parseConfigPatch({ safetyFloor: { enabled: "yes" } })).toThrow("safetyFloor.enabled");
    expect(() => parseConfigPatch({ safetyFloor: { enabled: true, rules: ["rm"] } })).toThrow("safetyFloor");
    ensureDirs();
    saveConfig({ safetyFloor: { enabled: true } });
    expect(loadConfig().safetyFloor).toEqual({ enabled: true });
    saveConfig({ safetyFloor: { enabled: false } });
    expect(loadConfig().safetyFloor).toEqual({ enabled: false });
  });
});

describe("safetyFloorBlock", () => {
  it("says nothing while the floor is off", () => {
    expect(safetyFloorBlock("rm -rf /")).toBeNull();
    bindSafetyFloor(() => ({ safetyFloor: { enabled: false } }));
    expect(safetyFloorBlock("rm -rf /")).toBeNull();
  });

  it("names the block for the person and for the engine once the floor is on", () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    expect(safetyFloorBlock("sudo rm -rf /")).toEqual({
      rule: "delete-root",
      label: "recursive delete of the filesystem root",
      line: "Blocked by the safety floor: recursive delete of the filesystem root",
      reason: expect.stringContaining("Blocked by the safety floor: recursive delete of the filesystem root."),
    });
    expect(safetyFloorBlock("rm -rf ./build")).toBeNull();
    expect(safetyFloorBlock(undefined)).toBeNull();
    expect(safetyFloorBlock("")).toBeNull();
  });

  it("reads the setting each time, so a settings save applies to the next request", () => {
    let config: AppConfig = {};
    bindSafetyFloor(() => config, undefined, HOST);
    expect(safetyFloorOn()).toBe(false);
    expect(safetyFloorBlock("rm -rf ~")).toBeNull();
    config = ON;
    expect(safetyFloorOn()).toBe(true);
    expect(safetyFloorBlock("rm -rf ~")?.rule).toBe("delete-home");
  });

  it("is switched on by OMB_SAFETY_FLOOR=1 alone, whatever the saved config says", () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: false } }), undefined, HOST);
    process.env.OMB_SAFETY_FLOOR = "1";
    try {
      expect(safetyFloorOn()).toBe(true);
      expect(safetyFloorBlock("rm -rf /")?.rule).toBe("delete-root");
    } finally {
      delete process.env.OMB_SAFETY_FLOOR;
    }
    expect(safetyFloorOn()).toBe(false);
  });

  it("knows this machine's home directory by its own path, unless that home is a scratch one", () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    // This suite's own home is a throwaway under the temp folder: deleting it
    // is cleanup, not the loss of somebody's home.
    expect(safetyFloorBlock(`rm -rf "${homedir()}"`)).toBeNull();
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const home = "/Users/fixture-person";
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(homedir()).toBe(home);
      expect(safetyFloorBlock(`rm -rf "${home}"`)?.rule).toBe("delete-home");
      expect(safetyFloorBlock(`rm -rf "${home}/project"`)).toBeNull();
    } finally {
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
    }
  });
});

describe("denyAtSafetyFloor", () => {
  it("leaves every request alone while the floor is off", async () => {
    const off = request("rm -rf /");
    expect(off.blocked).toBe(false);
    expect(off.adapter.answers).toEqual([]);
    expect(off.said).toEqual([]);
    expect(await off.rows()).toEqual([]);
  });

  it("denies a never-list command instead of allowing it, says so once, and logs the decision", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    const floored = request("TOKEN=sk-live-1234567890abcdef rm -rf /");
    expect(floored.blocked).toBe(true);
    await floored.settled;
    // the engine got one answer, and it was a deny with the reason
    expect(floored.adapter.answers).toEqual([{
      threadId: floored.threadId,
      requestId: "request-1",
      decision: { behavior: "deny", message: expect.stringContaining("Blocked by the safety floor: recursive delete of the filesystem root.") },
    }]);
    expect(floored.adapter.interrupted).toEqual([]);
    // one status row the person always sees, whatever the Tool calls setting
    expect(floored.said).toEqual([{
      role: "bot",
      kind: "activity",
      tool: { name: "notice: Blocked by the safety floor: recursive delete of the filesystem root", ok: true },
    }]);
    expect(await floored.rows()).toEqual([expect.objectContaining({
      threadId: floored.threadId,
      requestId: "request-1",
      botId: "bot-1",
      botName: "Ada",
      tool: "Bash",
      decision: "auto-denied",
      source: "safety-floor",
      rule: "delete-root",
    })]);
    // neither line carries the command, so a credential typed into it stays out
    expect(JSON.stringify([floored.said, floored.adapter.answers])).not.toContain("sk-live");
  });

  it("denies a request that carries only the command line, with no working directory", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    const floored = request("rm -rf /", { noCwd: true });
    expect(floored.blocked).toBe(true);
    await floored.settled;
    expect(floored.adapter.answers).toEqual([expect.objectContaining({ decision: expect.objectContaining({ behavior: "deny" }) })]);
    expect(await floored.rows()).toEqual([expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule: "delete-root" })]);
  });

  it("survives a failure after the denial without an unhandled rejection", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = request("rm -rf /", { release: () => { throw new Error("watchdog gone"); } });
      expect(failing.blocked).toBe(true);
      await failing.settled;
      await expect.poll(() => errors.mock.calls.length).toBe(1);
      expect(String(errors.mock.calls[0][0])).toContain("[safety-floor]");
    } finally {
      errors.mockRestore();
    }
  });

  it("lets everything else through to the grant that was about to answer", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    for (const command of ["rm -rf ./build", "git commit -m 'rm -rf /'", "npm test", undefined]) {
      const ordinary = request(command);
      expect(ordinary.blocked, String(command)).toBe(false);
      expect(ordinary.adapter.answers).toEqual([]);
      expect(ordinary.said).toEqual([]);
      expect(await ordinary.rows()).toEqual([]);
    }
  });

  it("stops the turn when the denial cannot be delivered, rather than leave the request open", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    const adapter = fakeAdapter(() => { throw new Error("broker gone"); });
    const undelivered = request("rm -rf ~", { adapter });
    expect(undelivered.blocked).toBe(true);
    await undelivered.settled;
    expect(adapter.interrupted).toEqual([{ threadId: undelivered.threadId, turnId: "turn-1" }]);
    expect(undelivered.said).toHaveLength(1);
    expect(await undelivered.rows()).toHaveLength(1);
  });

  it("never stops a turn that is no longer the one that asked", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    const adapter = fakeAdapter(() => { throw new Error("broker gone"); });
    let delivered!: () => void;
    const answered = new Promise<void>((resolve) => { delivered = resolve; });
    const respond = adapter.respondToRequest;
    adapter.respondToRequest = async (...args) => {
      try { return await respond(...args); } finally { delivered(); }
    };
    const stale = request("rm -rf ~", { adapter, isCurrent: () => false });
    expect(stale.blocked).toBe(true);
    await answered;
    await flushDecisionLog(DATA_DIR);
    expect(adapter.interrupted).toEqual([]);
  });

  it("holds without an adapter too: nothing is allowed and the block is still recorded", async () => {
    bindSafetyFloor(() => ON, undefined, HOST);
    const said: unknown[] = [];
    let released!: () => void;
    const settled = new Promise<void>((resolve) => { released = resolve; });
    expect(denyAtSafetyFloor({
      event: { threadId: "thread-no-adapter", tool: "shell", summary: "mkfs.ext4 /dev/sda1", command: { command: "mkfs.ext4 /dev/sda1", cwd: "/" } },
      requestId: "request-2", bot: { id: "bot-2", name: "Bo" }, adapter: undefined, isCurrent: () => true,
      say: (message) => said.push(message), release: () => released(),
    })).toBe(true);
    await settled;
    expect(said).toEqual([{ role: "bot", kind: "activity", tool: { name: "notice: Blocked by the safety floor: formatting a disk", ok: true } }]);
    await flushDecisionLog(DATA_DIR);
    expect(readDecisions(DATA_DIR, 200).filter((row) => row.threadId === "thread-no-adapter")).toEqual([
      expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule: "format-disk", botName: "Bo" }),
    ]);
  });
});

describe("a command the floor cannot read", () => {
  it("is not answered automatically: the grant's verdict becomes a card for the person", () => {
    bindWithBrokenReader();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const event = { threadId: "thread-unread", tool: "Bash", summary: "x", commandLine: GARBLED };
      const full = autoVerdict("full", "Bash");
      expect(full.approve).toBeTruthy();
      expect(heldAtSafetyFloor(event, full)).toEqual({ approve: null, source: "safety-floor" });
      expect(heldAtSafetyFloor(event, autoVerdict("ask", "Bash", { commandAllowed: true }))).toEqual({ approve: null, source: "safety-floor" });
      // a verdict that already leaves it to a person is left alone
      const card = autoVerdict("ask", "Bash");
      expect(heldAtSafetyFloor(event, card)).toBe(card);
      // and so is everything the floor could read
      expect(heldAtSafetyFloor({ ...event, commandLine: "npm test" }, full)).toBe(full);
      expect(heldAtSafetyFloor({ ...event, commandLine: "rm -rf /" }, full)).toBe(full);
      expect(heldAtSafetyFloor({ ...event, commandLine: undefined }, full)).toBe(full);
      // no driver answers for it by itself either
      expect(safetyFloorClears(GARBLED)).toBe(false);
      expect(safetyFloorClears("npm test")).toBe(true);
      expect(safetyFloorClears("rm -rf /")).toBe(false);
      expect(safetyFloorClears(undefined)).toBe(true);
      // it is not denied either: nothing says it is on the list
      expect(safetyFloorBlock(GARBLED)).toBeNull();
      // logged once, and never with the command's text
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toContain("[safety-floor]");
      expect(JSON.stringify(errors.mock.calls)).not.toContain("unreadable-fixture");
    } finally {
      errors.mockRestore();
    }
  });

  it("is not denied by the fold: the request is left for the card", async () => {
    bindWithBrokenReader();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unread = request(GARBLED);
      expect(unread.blocked).toBe(false);
      expect(unread.adapter.answers).toEqual([]);
      expect(unread.said).toEqual([]);
      expect(await unread.rows()).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("is refused where a runtime answers its own gate, because no card will be shown there", async () => {
    bindWithBrokenReader();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const block = floorBlockForToolCall({ threadId: "thread-unread-chat", botId: "bot-4", tool: "shell_exec", input: { command: GARBLED } });
      expect(block).toMatchObject({ rule: "unreadable", line: "Blocked by the safety floor: a command it could not read" });
      expect(block!.reason).toContain("could not read");
      await flushDecisionLog(DATA_DIR);
      expect(readDecisions(DATA_DIR, 200).filter((row) => row.threadId === "thread-unread-chat")).toEqual([
        expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule: "unreadable" }),
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it("treats a reader that throws the same way", () => {
    bindSafetyFloor(() => ON, () => { throw new Error("reader crashed"); }, HOST);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(safetyFloorClears("npm test")).toBe(false);
      expect(heldAtSafetyFloor({ threadId: "t", tool: "Bash", summary: "x", commandLine: "npm test" }, autoVerdict("full", "Bash")))
        .toEqual({ approve: null, source: "safety-floor" });
    } finally {
      errors.mockRestore();
    }
  });

  it("leaves everything alone while the floor is off, readable or not", () => {
    bindSafetyFloor(() => ({}), () => ({ read: false }), HOST);
    const full = autoVerdict("full", "Bash");
    expect(safetyFloorClears(GARBLED)).toBe(true);
    expect(heldAtSafetyFloor({ threadId: "t", tool: "Bash", summary: "x", commandLine: GARBLED }, full)).toBe(full);
    expect(floorBlockForToolCall({ threadId: "t", tool: "shell_exec", input: { command: GARBLED } })).toBeNull();
  });
});

describe("a runtime that answers its own tool gate", () => {
  it("finds the shell command a tool call carries, and nothing in any other argument", () => {
    expect(shellCommandOfToolCall({ command: "ls -la" })).toBe("ls -la");
    expect(shellCommandOfToolCall({ cmd: "ls -la" })).toBe("ls -la");
    expect(shellCommandOfToolCall({ command: "", cmd: "pwd" })).toBe("pwd");
    expect(shellCommandOfToolCall({ command: ["rm", "-rf", "/"] })).toBeUndefined();
    expect(shellCommandOfToolCall({ text: "rm -rf /", note: "rm -rf /" })).toBeUndefined();
    expect(shellCommandOfToolCall({})).toBeUndefined();
  });

  it("blocks a never-list command and records it, only while the floor is on", async () => {
    const call = { threadId: "thread-chat", botId: "bot-3", tool: "computer_exec", summary: '{"command":"rm -rf /"}', input: { command: "rm -rf /" } };
    expect(floorBlockForToolCall(call)).toBeNull();
    bindSafetyFloor(() => ON, undefined, HOST);
    expect(floorBlockForToolCall({ ...call, input: { command: "ls /" } })).toBeNull();
    expect(floorBlockForToolCall({ ...call, input: { text: "rm -rf /" } })).toBeNull();
    expect(floorBlockForToolCall(call)).toMatchObject({ rule: "delete-root", line: "Blocked by the safety floor: recursive delete of the filesystem root" });
    await flushDecisionLog(DATA_DIR);
    expect(readDecisions(DATA_DIR, 200).filter((row) => row.threadId === "thread-chat")).toEqual([
      expect.objectContaining({ botId: "bot-3", tool: "computer_exec", decision: "auto-denied", source: "safety-floor", rule: "delete-root" }),
    ]);
  });
});

describe("on a Windows server", () => {
  /** The setting on, the server's platform Windows, and a reader that counts
   * its calls: nothing should ever be handed to it. */
  const bindOnWindows = () => {
    const reader = vi.fn(floorReading);
    bindSafetyFloor(() => ON, reader, "win32");
    return reader;
  };

  it("is not applied: the gate behaves exactly as with the setting off", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reader = bindOnWindows();
      expect(safetyFloorOn()).toBe(false);
      expect(safetyFloorBlock("rm -rf /")).toBeNull();
      expect(safetyFloorBlock("rd /s /q C:\\")).toBeNull();
      expect(safetyFloorClears("rm -rf /")).toBe(true);
      expect(safetyFloorClears("rd /s /q C:\\")).toBe(true);
      const full = autoVerdict("full", "Bash");
      expect(heldAtSafetyFloor({ threadId: "t", tool: "Bash", summary: "x", commandLine: 'dir "C:\\Users\\me\\"' }, full)).toBe(full);
      // the fold's check: nothing denied, nothing said, nothing logged
      const untouched = request("rm -rf /");
      expect(untouched.blocked).toBe(false);
      expect(untouched.adapter.answers).toEqual([]);
      expect(untouched.said).toEqual([]);
      expect(await untouched.rows()).toEqual([]);
      // a runtime answering its own gate is not stopped either
      expect(floorBlockForToolCall({ threadId: "thread-windows", tool: "shell_exec", input: { command: "rm -rf /" } })).toBeNull();
      await flushDecisionLog(DATA_DIR);
      expect(readDecisions(DATA_DIR, 200).filter((row) => row.threadId === "thread-windows")).toEqual([]);
      // and no command was classified at all
      expect(reader).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
    }
  });

  it("says so once at startup when the setting is on, and only then", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // a fresh copy of the module: the notice is once per server process
      vi.resetModules();
      const fresh = await import("./safety-floor-gate.ts");
      fresh.bindSafetyFloor(() => ({}), undefined, "win32");
      fresh.bindSafetyFloor(() => ON, undefined, "linux");
      fresh.bindSafetyFloor(() => ON, undefined, "darwin");
      expect(warnings).not.toHaveBeenCalled();
      fresh.bindSafetyFloor(() => ON, undefined, "win32");
      fresh.bindSafetyFloor(() => ON, undefined, "win32");
      expect(fresh.safetyFloorOn()).toBe(false);
      fresh.safetyFloorClears("rm -rf /");
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(String(warnings.mock.calls[0][0])).toMatch(/^\[safety-floor\] .*not applied on a Windows server yet/);
      // the environment switch counts as "on" too
      vi.resetModules();
      const viaEnv = await import("./safety-floor-gate.ts");
      process.env.OMB_SAFETY_FLOOR = "1";
      try {
        viaEnv.bindSafetyFloor(() => ({}), undefined, "win32");
      } finally {
        delete process.env.OMB_SAFETY_FLOOR;
      }
      expect(warnings).toHaveBeenCalledTimes(2);
    } finally {
      warnings.mockRestore();
    }
  });
});
