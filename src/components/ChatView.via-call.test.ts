// A request spoken on a Live call is an ordinary user message with a small
// "via call" line under it; typed messages have none. A finished call leaves
// one compact record row in the chat, which is not a message the chat reads
// its working line from.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "cua-driver-unavailable", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
// the thread controls are not what this test is about
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span") }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const message = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "user", kind: "text", text, at: 1_700_000_000_000, ...extra }) as Message;

const bot = (messages: Message[]): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages,
  modelSelection: { instanceId: "test", model: "m" },
});

describe("via call label", () => {
  it("marks a request spoken on a Live call, and only that one", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([message("m1", "typed words"), message("m2", "spoken words", { via: "call" })]),
    }));
    expect(markup).toContain("typed words");
    expect(markup).toContain("spoken words");
    expect(markup.match(/>via call</g)).toHaveLength(1);
    // the label follows the spoken request, not the typed one
    expect(markup.indexOf(">via call<")).toBeGreaterThan(markup.indexOf("spoken words"));
  });

  it("shows no label without a call", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: bot([message("m1", "typed words")]) }));
    expect(markup).toContain("typed words");
    expect(markup).not.toContain("via call");
  });

  it("draws a finished call's row as its record, and keeps the spoken request inline", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      bot: bot([
        message("m1", "spoken words", { via: "call", callId: "c1" }),
        message("r1", "Call with Pepper · 0:42", {
          role: "bot",
          kind: "call",
          call: { callId: "c1", botId: "bot", client: "ios", startedAt: 1_700_000_000_000, endedAt: 1_700_000_042_000, seconds: 42, endReason: "hung-up" },
        }),
      ]),
    }));
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("Call with Pepper");
    // the spoken request is still its own line, labelled as before
    expect(markup).toContain("spoken words");
    expect(markup.match(/>via call</g)).toHaveLength(1);
    // the fallback line is for older clients: never drawn as a bubble here
    expect(markup).not.toContain("Call with Pepper · 0:42");
  });
});

// Hanging up while the bot is still working puts the call's record after the
// steps so far; the steps that follow land after it. The working line and the
// working dots read the chat's last real message, never the record.
describe("a call's record at the end of a chat that is still working", () => {
  const record = message("r1", "Call with Pepper · 0:42", {
    role: "bot",
    kind: "call",
    call: { callId: "c1", botId: "bot", client: "ios", startedAt: 1_700_000_000_000, endedAt: 1_700_000_042_000, seconds: 42, endReason: "hung-up" },
  });
  const spoken = message("m1", "run the tests", { via: "call", callId: "c1" });
  const drawWorking = (messages: Message[]) =>
    renderToStaticMarkup(createElement(ChatView, { bot: { ...bot(messages), busy: true } }));

  it("keeps naming the step that is running when the call ended under it", () => {
    const markup = drawWorking([
      spoken,
      message("a1", "", { role: "bot", kind: "activity", requestMessageId: "m1", tool: { name: "Bash", spoken: "running the tests", itemId: "item-a1" } }),
      record,
    ]);
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("Running the tests");
  });

  it("shows no working line for a reply that settled just before the call ended", () => {
    const markup = drawWorking([
      spoken,
      message("b1", "All tests pass.", { role: "bot", requestMessageId: "m1" }),
      record,
    ]);
    expect(markup).toContain("All tests pass.");
    expect(markup).not.toContain("thinking-shimmer");
  });

  // A step the harness never settles (Stop in the middle of a tool, a killed
  // turn, a restart) has no outcome for good. The record shows it as running
  // only while the chat works, and as nothing in particular once it stops.
  it("draws a step with no outcome as running while the chat works, and not once it stops", () => {
    const work = [
      spoken,
      message("a1", "", { role: "bot", kind: "activity", requestMessageId: "m1", tool: { name: "Read", spoken: "reading a file", itemId: "item-a1" } }),
      record,
    ];
    expect(drawWorking(work)).toContain('<span class="sr-only"> (Running)</span>');
    const stopped = renderToStaticMarkup(createElement(ChatView, { bot: bot(work) }));
    expect(stopped).toContain('data-testid="call-record"');
    expect(stopped).toContain("Reading a file");
    expect(stopped).not.toContain("(Running)");
  });

  it("still shows the working line for a request nobody has answered yet", () => {
    const markup = drawWorking([spoken, record]);
    expect(markup).toContain("thinking-shimmer");
  });
});

// The chat holds the newest page of a long conversation. A call that began
// before the oldest message loaded may have lines in the part not loaded yet,
// and its record says so while older messages remain.
describe("a call's record in a chat whose older messages are not all loaded", () => {
  const spoken = message("m1", "run the tests", { via: "call", callId: "c1" });
  const step = message("a1", "", { role: "bot", kind: "activity", requestMessageId: "m1", tool: { name: "Bash", spoken: "running the tests", ok: true, itemId: "item-a1" } });
  const recordFrom = (startedAt: number) => message("r1", "Call with Pepper · 4:10", {
    role: "bot",
    kind: "call",
    call: { callId: "c1", botId: "bot", client: "ios", startedAt, endedAt: 1_700_000_000_000, seconds: 250, endReason: "hung-up" },
  });
  const draw = (hasMore: boolean, startedAt: number) =>
    renderToStaticMarkup(createElement(ChatView, { bot: { ...bot([spoken, step, recordFrom(startedAt)]), hasMore } }));
  const began = 1_700_000_000_000 - 250_000; // before every loaded message

  it("says its lines may be incomplete when the call began before the oldest loaded message", () => {
    const markup = draw(true, began);
    expect(markup).toContain('data-testid="call-record"');
    expect(markup).toContain("Some of this call may be in earlier messages");
  });

  it("says nothing once the whole conversation is loaded", () => {
    expect(draw(false, began)).not.toContain("Some of this call may be in earlier messages");
  });

  it("says nothing for a call that began within the loaded messages", () => {
    expect(draw(true, 1_700_000_000_000 + 1_000)).not.toContain("Some of this call may be in earlier messages");
  });
});
