import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSocket } from "./live-socket.ts";
import { QwenLiveSocket } from "./qwen-live-socket.ts";

class Provider implements LiveSocket {
  readyState = 1;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  event(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const sockets: QwenLiveSocket[] = [];
function setup() {
  const provider = new Provider();
  const socket = new QwenLiveSocket({ upstream: provider, key: "fixture", voice: "longanqian_v3.1", instructions: "Fixture",
    endpoint: { provider: "qwen", apiBase: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen-audio-3.1-realtime-flash" },
  });
  sockets.push(socket);
  const events: Record<string, unknown>[] = [];
  socket.onmessage = ({ data }) => events.push(JSON.parse(String(data)));
  provider.event({ type: "session.updated" });
  const media = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  socket.bindMedia(media);
  const input = (id: string) => {
    provider.event({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
    provider.event({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 100 });
    provider.event({ type: "input_audio_buffer.committed", item_id: id });
  };
  const transcript = (id: string, text = "Hello.") => provider.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
  const response = (id: string) => provider.event({ type: "response.created", response: { id } });
  const done = (id: string) => provider.event({ type: "response.done", response: { id, status: "completed" } });
  const tool = (id: string, responseId: string) => provider.event({ type: "response.function_call_arguments.done", response_id: responseId, call_id: id, name: "delegate_to_bot", arguments: "{}" });
  const greeting = (id: string) => { input(id); response(`r-${id}`); transcript(id); done(`r-${id}`); };
  const accepted = (id: string) => socket.send(JSON.stringify({ type: "session.delegation.accepted", delegation_id: id, request_id: `request-${id}`, thread_id: "thread" }));
  const result = (id: string, content = "Completed fixture.") => socket.send(JSON.stringify({ type: "session.commentary.append", delegation_id: id, request_id: `request-${id}`, thread_id: "thread", status: "completed", content }));
  const task = (id: string) => { input(id); response(`r-${id}`); transcript(id, `Perform ${id}.`); tool(id, `r-${id}`); done(`r-${id}`); };
  const settled = (id: string) => {
    task(id); accepted(id); response(`ack-${id}`); done(`ack-${id}`);
    result(id); socket.releaseDelegation(id); response(`result-${id}`); done(`result-${id}`);
  };
  return { provider, socket, events, media, input, transcript, response, done, tool, greeting, accepted, result, task, settled };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); vi.useRealTimers(); });

it("keeps a call open across 600 completed ordinary turns", () => {
  const t = setup();
  for (let i = 0; i < 600; i++) t.greeting(`g-${i}`);
  expect(t.socket.readyState).toBe(1);
  expect(t.events.filter((event) => event.type === "session.input_transcript.delta")).toHaveLength(600);
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(0);
});

it("retains an outstanding task while completed unrelated turns are reclaimed", () => {
  const t = setup();
  t.input("task"); t.response("task-response"); t.transcript("task", "Perform the fixture task."); t.tool("task-call", "task-response"); t.done("task-response");
  t.socket.send(JSON.stringify({ type: "session.delegation.accepted", delegation_id: "task-call", request_id: "request-1", thread_id: "thread-1" }));
  t.response("task-ack"); t.done("task-ack");
  for (let i = 0; i < 600; i++) t.greeting(`g-${i}`);
  expect(t.socket.readyState).toBe(1);
  for (const content of ["First result part.", "Second result part."]) {
    t.socket.send(JSON.stringify({ type: "session.commentary.append", delegation_id: "task-call", request_id: "request-1", thread_id: "thread-1", status: "completed", content }));
  }
  t.response("result-1"); t.done("result-1");
  t.response("result-2"); t.done("result-2");
  const outputs = t.provider.sent.filter((event) => event.type === "conversation.item.create").map((event) => event.item as { call_id?: string; output?: string });
  expect(outputs.filter((item) => item.call_id === "task-call")).toHaveLength(3);
  expect(outputs.map((item) => item.output).join("\n")).toContain("First result part.");
  expect(outputs.map((item) => item.output).join("\n")).toContain("Second result part.");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(1);
});

it("reclaims rejected VAD turns without making them eligible for delegation", () => {
  const t = setup();
  for (let i = 0; i < 600; i++) {
    const id = `invalid-${i}`;
    t.provider.event({ type: "input_audio_buffer.speech_started", item_id: id });
    t.provider.event({ type: "input_audio_buffer.speech_stopped", item_id: id, reason: "turn_invalid" });
    t.transcript(id, "Must not execute.");
  }
  expect(t.socket.readyState).toBe(1);
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(0);
});

it("reclaims 600 fully settled tools, ACKs and result readouts while bounding historical IDs", () => {
  const t = setup();
  for (let i = 0; i < 600; i++) t.settled(`task-${i}`);
  expect(t.socket.readyState).toBe(1);
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(600);
  const state = t.socket as unknown as { inputs: Map<string, unknown>; responses: Map<string, unknown>; tools: Map<string, unknown>; retiredResponses: Set<string> };
  expect([state.inputs.size, state.responses.size, state.tools.size]).toEqual([0, 0, 0]);
  expect(state.retiredResponses.size).toBe(1_024);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the first pending delegation through 257 other settled tools and delivers every final chunk", () => {
  const t = setup();
  t.task("pending");
  for (let i = 0; i < 257; i++) t.settled(`other-${i}`);
  t.accepted("pending"); t.response("pending-ack"); t.done("pending-ack");
  for (let i = 0; i < 3; i++) t.result("pending", `Final chunk ${i}.`);
  t.socket.releaseDelegation("pending");
  for (let i = 0; i < 3; i++) { t.response(`pending-final-${i}`); t.done(`pending-final-${i}`); }
  const output = t.provider.sent.map((event) => event.item as { call_id?: string; output?: string } | undefined)
    .filter((item) => item?.call_id === "pending").map((item) => item?.output);
  expect(output).toHaveLength(4);
  for (let i = 0; i < 3; i++) expect(output.join("\n")).toContain(`Final chunk ${i}.`);
  expect(t.socket.readyState).toBe(1);
});

it.each(["inputs", "responses", "unmatched tools", "pending controller tools"])("still closes when more than 256 genuinely live %s accumulate", (kind) => {
  const t = setup();
  for (let i = 0; i < 257; i++) {
    if (kind === "inputs") t.input(`input-${i}`);
    else if (kind === "responses") t.response(`response-${i}`);
    else if (kind === "unmatched tools") t.tool(`tool-${i}`, `unknown-${i}`);
    else t.task(`pending-${i}`);
  }
  expect(t.socket.readyState).toBe(3);
  expect(t.events).toContainEqual({ type: "error", error: { code: "qwen-state-limit" } });
  expect(vi.getTimerCount()).toBe(0);
});

it("retains done-before-created correlation for late final ASR and never consumes the next request twice", async () => {
  const t = setup();
  t.input("late"); t.tool("late-tool", "late-response"); t.done("late-response");
  await vi.advanceTimersByTimeAsync(2_999);
  t.transcript("late", "The authorized late request.");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(1);
  t.input("next"); t.transcript("next", "The next request.");
  t.response("late-response"); t.done("late-response"); t.tool("late-tool", "late-response"); t.tool("duplicate-tool", "late-response");
  t.response("next-response"); t.tool("next-tool", "next-response"); t.done("next-response");
  const requests = t.events.filter((event) => event.type === "session.delegation.created").map((event) => event.request);
  expect(requests).toEqual([
    { text: "The authorized late request.", withoutEcho: "The authorized late request." },
    { text: "The next request.", withoutEcho: "The next request." },
  ]);
});

it("keeps a completed ordinary response only until its final ASR arrives or its bounded wait expires", async () => {
  const t = setup();
  t.input("late"); t.response("late-response"); t.done("late-response");
  await vi.advanceTimersByTimeAsync(2_999);
  t.transcript("late", "A late greeting.");
  expect(t.events).toContainEqual(expect.objectContaining({ type: "session.input_transcript.delta", delta: "A late greeting." }));
  t.input("missing"); t.response("missing-response"); t.done("missing-response");
  await vi.advanceTimersByTimeAsync(3_000);
  t.transcript("missing", "Too late to execute."); t.tool("too-late", "missing-response");
  const state = t.socket as unknown as { inputs: Map<string, unknown>; responses: Map<string, unknown> };
  expect([state.inputs.size, state.responses.size]).toEqual([0, 0]);
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("never executes a timed-out request when ASR, duplicate tools and done arrive later", async () => {
  const t = setup();
  t.input("expired"); t.response("expired-response"); t.tool("expired-tool", "expired-response");
  await vi.advanceTimersByTimeAsync(3_000);
  t.transcript("expired", "Must not execute.");
  t.tool("expired-tool", "expired-response"); t.tool("different-tool", "expired-response"); t.done("expired-response");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(0);
  t.response("rejection"); t.done("rejection");
  t.task("next");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(1);
  expect(t.socket.readyState).toBe(1);
});

it("rejects an ambiguous committed batch and recovers for the next unambiguous request", async () => {
  const t = setup();
  t.input("first"); t.transcript("first", "First request.");
  t.input("second"); t.transcript("second", "Second request.");
  t.response("ambiguous"); t.tool("ambiguous-tool", "ambiguous"); t.done("ambiguous");
  await vi.advanceTimersByTimeAsync(3_000);
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(0);
  t.response("reject-batch"); t.done("reject-batch"); t.response("reject-tool"); t.done("reject-tool");
  expect(JSON.stringify(t.provider.sent)).toContain("Please repeat one request");
  t.task("next");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(1);
});

it("ignores unknown done outside the tombstone window without taking committed input or a readout reservation", () => {
  const t = setup();
  for (let i = 0; i < 600; i++) t.settled(`task-${i}`);
  t.input("new"); t.transcript("new", "The next request.");
  t.done("r-task-0");
  t.response("new-response"); t.tool("new-tool", "new-response"); t.done("new-response");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(601);
  t.accepted("new-tool");
  t.result("new-tool", "Queued final result.");
  const creates = () => t.provider.sent.filter((event) => event.type === "response.create").length;
  const before = creates();
  t.done("r-task-0");
  expect(creates()).toBe(before);
  t.response("new-ack"); t.done("new-ack");
  expect(creates()).toBe(before + 1);
});

it("does not replay retired or unknown audio after bounded suppression records are gone", () => {
  const t = setup();
  for (let i = 0; i < 1_100; i++) {
    t.response(`cancel-${i}`);
    t.provider.event({ type: "response.done", response: { id: `cancel-${i}`, status: "cancelled" } });
  }
  const state = t.socket as unknown as { suppressedAudio: Set<string>; retiredResponses: Set<string> };
  expect(state.suppressedAudio.size).toBeLessThanOrEqual(1_024);
  expect(state.retiredResponses.size).toBe(1_024);
  const before = t.media.send.mock.calls.length;
  for (const response_id of ["cancel-0", "cancel-1099", "unknown"]) {
    t.provider.event({ type: "response.audio.delta", response_id, delta: "AQACAA==" });
    t.provider.event({ type: "response.audio_transcript.delta", response_id, delta: "Must not replay." });
  }
  expect(t.media.send.mock.calls).toHaveLength(before);
  expect(t.socket.readyState).toBe(1);
});

it("ignores late retired input events without changing a newer speaker, committed turn or readout reservation", () => {
  const t = setup();
  t.greeting("retired");
  t.provider.event({ type: "input_audio_buffer.speech_started", item_id: "new", audio_start_ms: 200 });
  const note = (content: string) => t.socket.send(JSON.stringify({ type: "session.commentary.append", thread_id: "thread", content }));
  note("First notification.");
  const creates = () => t.provider.sent.filter((event) => event.type === "response.create").length;
  t.provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "retired", reason: "turn_invalid" });
  t.provider.event({ type: "input_audio_buffer.committed", item_id: "retired" });
  t.transcript("retired", "Old transcript.");
  expect(creates()).toBe(0);
  t.provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "new", audio_end_ms: 300 });
  t.provider.event({ type: "input_audio_buffer.committed", item_id: "new" });
  t.transcript("new", "The new request.");
  t.response("new-response");
  t.provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "new" });
  t.provider.event({ type: "input_audio_buffer.committed", item_id: "new" });
  t.tool("new-tool", "new-response"); t.done("new-response");
  expect(creates()).toBe(1);
  t.provider.event({ type: "input_audio_buffer.speech_stopped", item_id: "retired" });
  note("Second notification.");
  t.response("notification-1"); t.done("notification-1");
  expect(creates()).toBe(2);
  t.response("notification-2"); t.done("notification-2");
  t.task("next");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(2);
  expect(t.socket.readyState).toBe(1);
});

it("does not let an untracked tool response's done claim a pending readout reservation", () => {
  const t = setup();
  t.task("first"); t.accepted("first"); t.result("first");
  t.input("new"); t.transcript("new", "New request.");
  t.tool("unrelated-tool", "unrelated-response"); t.done("unrelated-response");
  const creates = () => t.provider.sent.filter((event) => event.type === "response.create").length;
  expect(creates()).toBe(1);
  t.response("first-ack"); t.done("first-ack");
  expect(creates()).toBe(1);
  t.response("new-response"); t.tool("new-tool", "new-response"); t.done("new-response");
  expect(t.events.filter((event) => event.type === "session.delegation.created")).toHaveLength(2);
  expect(creates()).toBe(2);
  t.response("first-result"); t.done("first-result");
});

it("enforces the pending-speech budget when unmatched tool timeouts settle together", async () => {
  const t = setup();
  for (let i = 0; i < 100; i++) t.tool(`unmatched-${i}`, `unknown-${i}`);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(t.socket.readyState).toBe(3);
  expect(t.events).toContainEqual({ type: "error", error: { code: "qwen-pending-speech-limit" } });
  expect(vi.getTimerCount()).toBe(0);
});
