// Drivers that answer a permission request inside the driver, with nobody
// looking: Codex at Full access, and an ACP agent whose exact operation was
// kept with "Always allow this session" or whose instance is legacy
// full-auto. With the safety floor on, none of them answers a never-list
// command by itself; it is raised as a request like any other.
//
// The driver and the fold must read the same text. The request a driver
// raises carries the engine's exact command line whether or not its working
// directory is known, and the fold's own check, handed that request, denies
// it. A command the floor cannot read goes to a card instead.
//
// The engines are the repository's scripted fakes. They send a permission
// REQUEST naming a command and record the answer; neither runs anything.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoVerdict } from "../auto-approve.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { bindSafetyFloor, denyAtSafetyFloor, heldAtSafetyFloor } from "../safety-floor-gate.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { CodexDriver } from "./codex.ts";

// Creating a Codex instance looks up the latest release; keep that offline.
vi.mock("./codex-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-release.ts")>(),
  readLatestCodexRelease: async () => "0.156.1",
}));

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const FAKE_CODEX = join(TESTING, "fake-codex-app-server.ts");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");
const WIPE = "rm -rf /";
/** The server's platform is given explicitly, so the suite says the same
 * thing on a Windows runner, where the gate is inert. */
const floorOn = (host: NodeJS.Platform = "linux") => bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, host);

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let scratch: string;

beforeEach(() => {
  // A shell that already exports the switch must not turn the floor on here.
  delete process.env.OMB_SAFETY_FLOOR;
  ensureDirs();
  chmodSync(FAKE_CODEX, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-floor-drivers-"));
});

afterEach(async () => {
  bindSafetyFloor(() => ({}));
  for (const name of ["FAKE_CODEX_MODE", "FAKE_CODEX_APPROVAL_REQUEST", "FAKE_CODEX_DUMP", "FAKE_ACP_MODE", "FAKE_ACP_PERMISSION_TOOL_CALL", "FAKE_ACP_PERMISSION_ANSWER"]) {
    delete process.env[name];
  }
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

const opened = () => recorder!.events.filter((event) => event.type === "request.opened");
type Request = Extract<RuntimeEvent, { type: "request.opened" }>;
const nextRequest = async (turnId?: string): Promise<Request> => {
  const event = await recorder!.until((candidate) => candidate.type === "request.opened" && (turnId === undefined || candidate.turnId === turnId));
  if (event.type !== "request.opened") throw new Error("not a request");
  return event;
};
/** What the request.opened fold does once Full access has said "approve":
 * its two safety-floor checks, on the request exactly as the driver raised
 * it. Returns "denied", "card" (left for a person) or "allowed". */
const foldAtFullAccess = (request: Request): "denied" | "card" | "allowed" => {
  const verdict = heldAtSafetyFloor(request, autoVerdict("full", request.tool));
  if (!verdict.approve) return "card";
  return denyAtSafetyFloor({
    event: request, requestId: request.requestId!, bot: { id: "bot-floor", name: "Floor fixture" }, adapter: instance!.adapter,
    isCurrent: () => true, say: () => {}, release: () => {},
  }) ? "denied" : "allowed";
};

describe("Codex at Full access", () => {
  /** One Full-access turn in which the fake app-server asks to run `command`. */
  const ask = async (threadId: string, command: string | string[], where: Record<string, string> = { cwd: scratch }, method = "item/commandExecution/requestApproval") => {
    process.env.FAKE_CODEX_MODE = "approval";
    process.env.FAKE_CODEX_APPROVAL_REQUEST = JSON.stringify({ method, params: { command, ...where } });
    const dump = join(scratch, `${threadId}.json`);
    process.env.FAKE_CODEX_DUMP = dump;
    instance = await CodexDriver.create({
      instanceId: "codex-floor", displayName: "Codex floor fixture", environment: {}, enabled: true,
      config: { cli: FAKE_CODEX, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: "go", cwd: scratch, approvalMode: "full" });
    return { decision: () => JSON.parse(readFileSync(dump, "utf8")).decision as unknown };
  };

  it("still answers by itself while the floor is off", async () => {
    const turn = await ask("t-codex-off", WIPE);
    await recorder!.until((event) => event.type === "turn.completed");
    expect(opened()).toEqual([]);
    expect(turn.decision()).toEqual({ decision: "accept" });
  });

  it("raises a never-list command as a request instead of accepting it", async () => {
    floorOn();
    const turn = await ask("t-codex-floored", WIPE);
    const request = await recorder!.until((event) => event.type === "request.opened");
    // the exact command rides the request, so the harness can deny it
    expect(request).toMatchObject({ requestType: "permission", tool: "shell", command: { command: WIPE, cwd: scratch } });
    expect(await instance!.adapter.respondToRequest("t-codex-floored", request.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(turn.decision()).toEqual({ decision: "decline" });
  });

  it("hands the harness the same command line when the working directory is unknown, and the harness denies it", async () => {
    floorOn();
    // A helper thread's request names no directory, so no exact-command
    // descriptor can be made for it. The command line still travels.
    const turn = await ask("t-codex-no-cwd", WIPE, { threadId: "helper-thread" });
    const request = await nextRequest();
    expect(request.command).toBeUndefined();
    expect(request.commandLine).toBe(WIPE);
    expect(foldAtFullAccess(request)).toBe("denied");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(turn.decision()).toEqual({ decision: "decline" });
  });

  it("reads a legacy argv request as the command line it runs, and the harness denies it", async () => {
    floorOn();
    const turn = await ask("t-codex-argv", ["bash", "-lc", WIPE], { cwd: scratch }, "execCommandApproval");
    const request = await nextRequest();
    expect(request.commandLine).toBe("bash -lc 'rm -rf /'");
    expect(foldAtFullAccess(request)).toBe("denied");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(turn.decision()).toEqual({ decision: "denied" });
  });

  it("still answers an ordinary legacy argv request by itself", async () => {
    floorOn();
    const turn = await ask("t-codex-argv-ok", ["bash", "-lc", "echo 'it''s fine'"], { cwd: scratch }, "execCommandApproval");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(opened()).toEqual([]);
    expect(turn.decision()).toEqual({ decision: "approved" });
  });

  it("raises a command the floor cannot read, and the harness leaves it for a card", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), () => ({ read: false }), "linux");
      const turn = await ask("t-codex-unreadable", "npm test");
      const request = await nextRequest();
      expect(foldAtFullAccess(request)).toBe("card");
      // the person answers the card
      await instance!.adapter.respondToRequest("t-codex-unreadable", request.requestId!, { behavior: "allow" });
      await recorder!.until((event) => event.type === "turn.completed");
      expect(turn.decision()).toEqual({ decision: "accept" });
    } finally {
      errors.mockRestore();
    }
  });

  it("is not held back on a Windows server, where the floor is not applied", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      floorOn("win32");
      const turn = await ask("t-codex-windows", WIPE);
      await recorder!.until((event) => event.type === "turn.completed");
      expect(opened()).toEqual([]);
      expect(turn.decision()).toEqual({ decision: "accept" });
    } finally {
      warnings.mockRestore();
    }
  });

  it("goes on answering every other command by itself", async () => {
    floorOn();
    const turn = await ask("t-codex-ordinary", "git commit -m 'never run rm -rf /'");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(opened()).toEqual([]);
    expect(turn.decision()).toEqual({ decision: "accept" });
  });
});

describe("an ACP agent", () => {
  const create = async (config: { fullAuto: boolean }, command: string, kind = "execute") => {
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOL_CALL = JSON.stringify({ kind, rawInput: { command }, title: command });
    process.env.FAKE_ACP_PERMISSION_ANSWER = join(scratch, "answer.txt");
    instance = await GrokAgentDriver.create({
      instanceId: "acp-floor", displayName: "ACP floor fixture", environment: {}, enabled: true,
      config: { cli: FAKE_ACP, ...config },
    });
    recorder = recordEvents(instance.adapter);
  };
  const answer = () => readFileSync(join(scratch, "answer.txt"), "utf8");
  /** Two turns asking for the same operation; the person keeps the first
   * with "Always allow this session". Returns how many cards were raised. */
  const askTwice = async (threadId: string) => {
    await instance!.adapter.sendTurn({ threadId, text: "go", approvalMode: "ask" });
    const first = await recorder!.until((event) => event.type === "request.opened");
    await instance!.adapter.respondToRequest(threadId, first.requestId!, { behavior: "allow", always: true });
    await recorder!.until((event) => event.type === "turn.completed");
    const second = await instance!.adapter.sendTurn({ threadId, text: "again", approvalMode: "ask", resumeCursor: "fake-acp-session" });
    return second.turnId;
  };

  it("repeats a kept allow for an ordinary command, floor on or off", async () => {
    floorOn();
    await create({ fullAuto: false }, "npm test");
    const turnId = await askTwice("t-acp-kept");
    await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(opened()).toHaveLength(1);
    expect(answer()).toBe("allow-once");
  });

  it("repeats a kept allow even for a never-list command on a Windows server, where the floor is not applied", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      floorOn("win32");
      await create({ fullAuto: false }, WIPE);
      const turnId = await askTwice("t-acp-windows");
      await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(opened()).toHaveLength(1);
    } finally {
      warnings.mockRestore();
    }
  });

  it("does not put a command line on a question, whatever its input holds", async () => {
    floorOn();
    // A question is told from a permission by its id. Its input is the
    // agent's own, and a `command` in it is not a command anybody runs.
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOL_CALL = JSON.stringify({ toolCallId: "interaction_pick", kind: "other", title: "Which cleanup?", rawInput: { command: WIPE } });
    process.env.FAKE_ACP_PERMISSION_ANSWER = join(scratch, "answer.txt");
    instance = await GrokAgentDriver.create({
      instanceId: "acp-floor-question", displayName: "ACP floor fixture", environment: {}, enabled: true,
      config: { cli: FAKE_ACP, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-acp-question", text: "go", approvalMode: "ask" });
    const question = await nextRequest(turnId);
    expect(question.requestType).toBe("question");
    expect(question.command).toBeUndefined();
    expect(question.commandLine).toBeUndefined();
    await instance.adapter.respondToRequest("t-acp-question", question.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  });

  it("asks again for a never-list command, however it was kept", async () => {
    floorOn();
    await create({ fullAuto: false }, WIPE);
    const turnId = await askTwice("t-acp-floored");
    // the kept allow does not answer: the person gets the card again
    const again = await recorder!.until((event) => event.type === "request.opened" && event.turnId === turnId);
    expect(again).toMatchObject({ requestType: "permission", tool: "shell", command: { command: WIPE } });
    await instance!.adapter.respondToRequest("t-acp-floored", again.requestId!, { behavior: "deny" });
    await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(opened()).toHaveLength(2);
  });

  it("hands the harness the command line of a request it cannot type as a shell command, and the harness denies it", async () => {
    floorOn();
    // Not `execute`, so the driver attaches no exact-command descriptor; at
    // Full access the harness would have allowed it unread.
    await create({ fullAuto: false }, WIPE, "other");
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-acp-untyped", text: "go", approvalMode: "full" });
    const request = await nextRequest(turnId);
    expect(request.command).toBeUndefined();
    expect(request.commandLine).toBe(WIPE);
    expect(foldAtFullAccess(request)).toBe("denied");
    await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(answer()).toBe("reject");
  });

  it("does not let a legacy full-auto instance answer a never-list command by itself", async () => {
    floorOn();
    await create({ fullAuto: true }, WIPE);
    // a direct adapter caller that names no approval level
    await instance!.adapter.sendTurn({ threadId: "t-acp-legacy", text: "go" });
    const request = await recorder!.until((event) => event.type === "request.opened");
    expect(request).toMatchObject({ requestType: "permission", command: { command: WIPE } });
    await instance!.adapter.respondToRequest("t-acp-legacy", request.requestId!, { behavior: "deny" });
    await recorder!.until((event) => event.type === "turn.completed");
  });
});
