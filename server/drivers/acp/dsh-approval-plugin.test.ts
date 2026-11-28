import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { DSH_APPROVAL_PLUGIN } from "./dsh-approval-plugin.ts";

const allow = '{"risk":"low","decision":"allow"}';
const stop = { type: "finish", reason: { kind: "stop" } };
const delta = (text: string, index = 0) => ({ type: "text-delta", index, text });
const reasoning = (index: number) => ({ type: "reasoning-delta", index, text: "Analysis" });
const textBlock = (text: string) => ({ type: "text", text });
const instruction = (kind: string, ...content: object[]) => ({ type: "user/message", data: { source: { kind }, content } });
const call = (callId: string, name: string, args: string) => ({ type: "tool/call", data: { callId, name, arguments: args } });
const pending = call("call-1", "bash", '{ "command": "ls -ld ." }');
const justification = "Inspect the directory: preserve punctuation\nand whitespace ";
type ReviewRequest = { messages: { role: string; content: { type: string; text: string }[] }[]; system: string; signal: AbortSignal };

let root: string;
let plugin: { apply(ctx: object, config: object): void };
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omb-dsh-review-"));
  const path = join(root, "approval-preset.mjs");
  writeFileSync(path, DSH_APPROVAL_PLUGIN);
  plugin = await import(pathToFileURL(path).href);
});
afterAll(() => removeTempDir(root));

interface FixtureOptions {
  preset?: string;
  review?: boolean;
  origin?: string;
  location?: string;
  events?: object[];
  chunks?: Iterable<object>;
}

function fixture({ preset = "auto", review = true, origin, location = "task-workspaces/bot-a/thread-b",
  events = [pending], chunks = [delta(allow), stop] }: FixtureOptions = {}) {
  const dataDir = mkdtempSync(join(root, "data-"));
  const session = {
    id: "session-b", header: { origin, cwd: join(dataDir, location) },
    requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }),
    snapshotEvents: () => events,
  };
  type Handler = (...args: any[]) => any;
  const handlers = new Map<string, { fn: Handler; options?: { prepend: boolean } }>();
  const current = vi.fn(() => preset);
  const set = vi.fn();
  const register = vi.fn((_session, path: string) => expect(statSync(path).isDirectory()).toBe(true));
  const requests: ReviewRequest[] = [];
  plugin.apply({
    on: (event: string, fn: Handler, options?: { prepend: boolean }) => handlers.set(event, { fn, options }),
    approval: {}, permissionPresets: { current, set }, sandboxPolicy: { registerWritableRoot: register },
    llm: { async *stream(options: ReviewRequest) { requests.push(options); yield* chunks; } },
  }, { dataDir, review });
  handlers.get("agent/created")!.fn({ agent: { session } });
  const next = vi.fn(async () => "rejected");
  const signal = new AbortController().signal;
  const request = { agent: { session }, toolName: "bash", callId: "call-1", signal,
    reason: "escalate sandbox to danger-full-access: " + justification };
  const ask = (overrides = {}, answer: () => Promise<string> = next) => handlers.get("approval/request")!.fn({ ...request, ...overrides }, answer);
  const memory = join(dataDir, "workspaces", "bot-a", "memory");
  const environment = () => {
    const text = requests[0].messages[0].content[0].text;
    expect(text).toMatch(/^ENVIRONMENT\n/);
    return JSON.parse(text.slice("ENVIRONMENT\n".length));
  };
  return { session, current, set, register, handlers, memory, dataDir, requests, next, signal, ask, environment };
}

describe("dsh approval plugin", () => {
  it("restores an auto session to workspace-write and creates its memory directory before registration", () => {
    const f = fixture();
    expect(f.set.mock.calls).toEqual([[f.session, "workspace-write"]]);
    expect(f.register.mock.calls).toEqual([[f.session, f.memory]]);
    expect(f.handlers.get("approval/request")?.options).toEqual({ prepend: true });
  });

  it("adds the memory directory when the sandbox is already active", () => {
    const f = fixture({ preset: "workspace-write" });
    expect(f.set).not.toHaveBeenCalled();
    expect(f.register.mock.calls).toEqual([[f.session, f.memory]]);
  });

  it("leaves a subagent's inherited permissions in effect", async () => {
    const f = fixture({ origin: "subagent" });
    expect(f.current).not.toHaveBeenCalled();
    expect(f.set).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(existsSync(f.memory)).toBe(false);
    expect(await f.ask()).toBe("allowed-once");
    expect(f.environment().writableRoots).toEqual([f.session.header.cwd, "/tmp"]);
  });

  it.each(["task-workspaces-other/bot-a/thread-b", "task-workspaces/bot-a", "task-workspaces"])(
    "omits the memory directory for cwd %s", async (location) => {
      const f = fixture({ location });
      expect(f.register).not.toHaveBeenCalled();
      expect(existsSync(join(f.dataDir, "workspaces"))).toBe(false);
      expect(await f.ask()).toBe("allowed-once");
      expect(f.environment().writableRoots).toEqual([f.session.header.cwd, "/tmp"]);
    });

  it("restores the sandbox with the default approval responder when review is off", () => {
    const f = fixture({ review: false });
    expect(f.set.mock.calls).toEqual([[f.session, "workspace-write"]]);
    expect(f.register).not.toHaveBeenCalled();
    expect(existsSync(f.memory)).toBe(false);
    expect(f.handlers.has("approval/request")).toBe(false);
  });

  it("passes ordinary approvals directly to the next responder", async () => {
    const f = fixture();
    for (const reason of ["Tool needs confirmation", undefined]) expect(await f.ask({ reason })).toBe("rejected");
    expect(f.requests).toHaveLength(0);
    expect(f.next).toHaveBeenCalledTimes(2);
  });

  it("uses the session route, the last matching call and every user instruction verbatim in session order", async () => {
    const long = "keep the entire text ".repeat(3000);
    const f = fixture({ events: [
      call("call-1", "old-tool", "{}"), instruction("user", textBlock("Older instruction")),
      instruction("user", textBlock(" first\n"), { type: "image" }, textBlock("half ")),
      instruction("user", textBlock(long)), instruction("user", textBlock("Third")),
      instruction("runtime-context", textBlock("Internal context")), instruction("skill-catalog", textBlock("Skills")),
      pending, call("another-id", "other-tool", "{}"),
    ] });
    expect(await f.ask({ toolName: "Display name" })).toBe("allowed-once");
    expect(f.next).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
    const { system, messages, signal, ...options } = f.requests[0];
    expect(system).toMatch(/^REVIEW_POLICY\n/);
    expect(signal).toBe(f.signal);
    expect(options).toEqual({ provider: "test-provider", model: "test-model", temperature: 0, sessionId: f.session.id, purpose: "auto-review" });
    for (const { role, content } of messages) {
      expect(role).toBe("user");
      expect(content).toEqual([textBlock(content[0].text)]);
    }
    const { cwd } = f.session.header;
    expect(f.environment()).toEqual({ cwd, sandbox: "workspace-write", writableRoots: [cwd, f.memory, "/tmp"], omb_data_dir: f.dataDir });
    expect(messages.slice(1).map(m => JSON.parse(m.content[0].text))).toEqual([
      ...["Older instruction", " first\nhalf ", long, "Third"].map(text => ({ role: "user-instruction", text })),
      { kind: "pending-escalation", tool: "bash", arguments: pending.data.arguments, requested_mode: "danger-full-access", justification },
    ]);
  });

  it("reads reasoning and fragmented text in block insertion order", async () => {
    const f = fixture({ chunks: [
      reasoning(9), delta('{"risk":"medium",', 3), reasoning(9), delta('"decision":"allow"}', 3), stop,
    ] });
    expect(await f.ask()).toBe("allowed-once");
    expect(f.next).not.toHaveBeenCalled();
  });

  it("uses the first closed block's text even when deltas arrive late", async () => {
    const f = fixture({ chunks: [
      { type: "block-start", index: 0, blockType: "text" }, delta("Incomplete"),
      { type: "block-end", index: 0, block: textBlock(allow) }, delta("Late text"), stop,
    ] });
    expect(await f.ask()).toBe("allowed-once");
    expect(f.next).not.toHaveBeenCalled();
  });

  function* brokenStream() {
    yield delta(allow);
    throw new Error("Connection lost");
  }

  const denials = ["medium", "high"].flatMap(risk => [undefined, 'punctuation: "{}"'].map(reason => ({
    label: risk + " denial " + (reason ? "with a reason" : "without a reason"),
    chunks: [delta(JSON.stringify({ risk, decision: "deny", reason })), stop],
  })));
  it.each([
    ...denials,
    { label: "surrounding prose", chunks: [delta("Result " + allow), stop] },
    { label: "low risk with deny", chunks: [delta('{"risk":"low","decision":"deny"}'), stop] },
    { label: "high risk with allow", chunks: [delta('{"risk":"high","decision":"allow"}'), stop] },
    { label: "allow with a reason", chunks: [delta('{"risk":"medium","decision":"allow","reason":"ok"}'), stop] },
    { label: "duplicate member", chunks: [delta('{"risk":"high","risk":"low","decision":"allow"}'), stop] },
    { label: "reasoning after text", chunks: [delta(allow), reasoning(1), stop] },
    { label: "two text blocks", chunks: [delta("Description"), delta(allow, 1), stop] },
    { label: "tool call block", chunks: [{ type: "tool-call-delta", index: 7, id: "c", argumentsDelta: "{}" }, delta(allow), stop] },
    { label: "missing finish", chunks: [delta(allow)] },
    { label: "token limit", chunks: [delta(allow), { type: "finish", reason: { kind: "max-tokens" } }] },
    ...["error", "aborted"].map(kind => ({ label: kind, chunks: [delta(allow), {
      type: "finish", reason: { kind, failure: { code: "TEST_FAILURE", message: "Generation interrupted" } },
    }] })),
    { label: "data after finish", chunks: [delta(allow), stop, reasoning(1)] },
    { label: "stream exception", chunks: brokenStream() },
  ])("hands off to the human responder exactly once for $label", async ({ chunks }) => {
    const f = fixture({ chunks });
    expect(await f.ask()).toBe("rejected");
    expect(f.requests).toHaveLength(1);
    expect(f.next).toHaveBeenCalledTimes(1);
  });

  it("hands off a missing call without sending an incomplete review request", async () => {
    const f = fixture({ events: [call("other-id", "bash", "{}")] });
    expect(await f.ask()).toBe("rejected");
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(0);
  });

  it("propagates the human responder's own error without opening a second card", async () => {
    const f = fixture({ chunks: [delta('{"risk":"medium","decision":"deny"}'), stop] });
    const failure = new Error("Responder failed");
    const next = vi.fn(() => { throw failure; });
    await expect(f.ask({}, next)).rejects.toBe(failure);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
