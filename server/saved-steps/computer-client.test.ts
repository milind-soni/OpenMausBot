import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_BUSY, CONTROL_HANDED_BACK, CONTROL_WAIT_MS, CONTROL_WAITED, controlRefusal, type ControlState } from "../control-client.ts";
import { computerPersonAwayText } from "../computer-wait.ts";
import { ChatMcpClient } from "../drivers/chat-mcp-tools.ts";
import { createGateInterceptor } from "../mcp-bridge.ts";
import { callOutcome, openComputerCaller, STEP_TIMEOUT_MS } from "./computer-client.ts";

const FAKE = fileURLToPath(new URL("../testing/fake-mcp-server.ts", import.meta.url));
const RECORDING_COMPUTER = `
const { createInterface } = require("node:readline");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
  if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [] } });
  if (method === "tools/call" && params.name === "read_env") send({ jsonrpc: "2.0", id, result: { content: [], structuredContent: {
    journal: process.env.OMB_COMPUTER_JOURNAL ?? null, kept: process.env.FIXTURE_KEPT ?? null } } });
  if (method === "tools/call" && params.name === "unknown_tool") send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
});`;

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const signal = new AbortController().signal;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const GATE = { OMB_CONTROL_URL: "http://127.0.0.1:1/api/internal/computer-control", OMB_CONTROL_TOKEN: "turn-token" };

async function open(spec: Parameters<typeof openComputerCaller>[0]) {
  const caller = await openComputerCaller({ ...spec, env: { ...GATE, ...spec.env } }, signal);
  closers.push(() => caller.close());
  return caller;
}

const recordingComputer = (env: Record<string, string> = {}) => open({ command: process.execPath, args: ["-e", RECORDING_COMPUTER], env });

describe("openComputerCaller", () => {
  it("calls a tool through MCP after the handshake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-saved-steps-caller-"));
    dirs.push(dir);
    const file = join(dir, "call.json");
    const caller = await open({ command: process.execPath, args: ["--experimental-strip-types", FAKE], env: { FAKE_MCP_CALL_FILE: file } });
    expect(await caller.call("click", { element_token: "s2-e2" }, signal)).toEqual({ ok: true, structured: {} });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "click", arguments: { element_token: "s2-e2" } });
    await caller.close();
  });

  it("starts the computer with the journal switched off and keeps the rest of its environment", async () => {
    const caller = await recordingComputer({ OMB_COMPUTER_JOURNAL: "1", FIXTURE_KEPT: "yes" });
    expect(await caller.call("read_env", {}, signal)).toEqual({ ok: true, structured: { journal: "0", kept: "yes" } });
  });

  it("reports a JSON-RPC error as a failed call", async () => {
    const caller = await recordingComputer();
    expect(await caller.call("unknown_tool", {}, signal)).toEqual({ ok: false, error: "MCP request failed; inspect the configured integration" });
  });

  it("gives every call the 60 second step timeout, past the control gate's longest hold, and reports a timeout as a failed call", async () => {
    const caller = await recordingComputer();
    const call = vi.spyOn(ChatMcpClient.prototype, "call").mockRejectedValueOnce(new Error("MCP request timed out; execution outcome may be uncertain"));
    expect(await caller.call("click", { element_index: 2 }, signal)).toEqual({ ok: false, error: "MCP request timed out; execution outcome may be uncertain" });
    expect(STEP_TIMEOUT_MS).toBe(60_000);
    expect(STEP_TIMEOUT_MS).toBeGreaterThan(CONTROL_WAIT_MS);
    expect(call).toHaveBeenCalledWith("tools/call", { name: "click", arguments: { element_index: 2 } }, signal, STEP_TIMEOUT_MS);
  });

  it("fails to open when the computer exits before the handshake", async () => {
    await expect(openComputerCaller({ command: process.execPath, args: ["-e", "process.exit(3)"], env: GATE }, signal)).rejects.toThrow(/MCP server/);
  });

  it.each([
    ["no control gate at all", {}],
    ["a gate address but no turn token", { OMB_CONTROL_URL: GATE.OMB_CONTROL_URL }],
    ["a turn token but no gate address", { OMB_CONTROL_TOKEN: GATE.OMB_CONTROL_TOKEN }],
  ])("never drives a computer spec with %s", async (_, env) => {
    const dir = mkdtempSync(join(tmpdir(), "omb-saved-steps-caller-"));
    dirs.push(dir);
    const file = join(dir, "started");
    const spawn = `require("node:fs").writeFileSync(${JSON.stringify(file)}, "")`;
    await expect(openComputerCaller({ command: process.execPath, args: ["-e", spawn], env }, signal)).rejects.toThrow("this computer is not behind its control gate");
    expect(() => readFileSync(file)).toThrow();
  });
});

describe("callOutcome", () => {
  it.each([
    [{ content: [{ type: "text", text: "A person has taken control" }], isError: true }, { ok: false, error: "A person has taken control" }],
    [{ content: [], structuredContent: { refusal: { code: "x", message: "not allowed" } } }, { ok: false, error: "not allowed" }],
    [{ content: [], structuredContent: { pid: 1 } }, { ok: true, structured: { pid: 1 } }],
    ["junk", { ok: false, error: "the computer returned an invalid result" }],
  ])("callOutcome %#", (result, expected) => expect(callOutcome(result)).toEqual(expected));

  it("joins an error's text items and keeps the first 300 characters", () => {
    const long = "x".repeat(400);
    expect(callOutcome({ content: [{ type: "text", text: "first" }, { type: "image", data: "AAAA" }, { type: "text", text: "second" }], isError: true }))
      .toEqual({ ok: false, error: "first second" });
    expect(callOutcome({ content: [{ type: "text", text: long }], isError: true })).toEqual({ ok: false, error: "x".repeat(300) });
    expect(callOutcome({ content: [], isError: true })).toEqual({ ok: false, error: "the tool reported an error" });
  });

  it.each<[string, ControlState, { actWithinMs?: number }]>([
    ["a person holds the computer", { held: true, helpOpen: false, reason: "person" }, {}],
    ["another thread holds it", { held: true, helpOpen: false, blockedReason: CONTROL_BUSY }, {}],
    ["its state cannot be confirmed", { held: true, helpOpen: false }, {}],
    ["the call waited for it", { held: false, helpOpen: false }, { actWithinMs: -1 }],
    ["the person handed it back mid-call", { held: true, helpOpen: false, blockedReason: CONTROL_HANDED_BACK }, {}],
    ["the person has had it too long", { held: true, helpOpen: false, blockedReason: computerPersonAwayText(30 * 60_000) }, {}],
  ])("fails a call the control gate refuses because %s, marked as the gate's", async (_case, state, timing) => {
    let refused = "";
    const gate = createGateInterceptor({ check: async () => state, forward: () => { throw new Error("forwarded"); }, refuse: (line) => { refused = line; }, ...timing });
    await gate(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: {} } }));
    const text = state.held ? controlRefusal(state) : CONTROL_WAITED;
    expect(callOutcome(JSON.parse(refused).result)).toEqual({ ok: false, error: text.slice(0, 300), gate: true });
  });

  it.each([
    ["the driver's own error", { content: [{ type: "text", text: "AXPress was not performed" }], isError: true }],
    ["a driver error that quotes part of a gate text", { content: [{ type: "text", text: "A person has taken control" }], isError: true }],
    ["the driver's refusal", { content: [], structuredContent: { refusal: { code: "x", message: CONTROL_BUSY } } }],
  ])("never marks %s as the gate's", (_case, result) => {
    const outcome = callOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toHaveProperty("gate");
  });

  it("names a refusal by its code when it has no message", () => {
    expect(callOutcome({ content: [], structuredContent: { refusal: { code: "browser_consent_required" } } })).toEqual({ ok: false, error: "browser_consent_required" });
  });

  it("hands over the raw structured answer, completeness fields included", () => {
    const answer = { pid: 4242, window_id: 7, elements: [], elements_complete: true, element_count: 0, degraded: false };
    expect(callOutcome({ content: [{ type: "text", text: "tree" }], structuredContent: answer })).toEqual({ ok: true, structured: answer });
  });

  it.each([
    ["no content", { structuredContent: { pid: 1 } }],
    ["content that is not a list", { content: "text" }],
    ["an isError that is not a boolean", { content: [], isError: "yes" }],
    ["a structured answer that is not an object", { content: [], structuredContent: [1] }],
  ])("refuses a result with %s", (_case, result) => expect(callOutcome(result)).toEqual({ ok: false, error: "the computer returned an invalid result" }));
});
