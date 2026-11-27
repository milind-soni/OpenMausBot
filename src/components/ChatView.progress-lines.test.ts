// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

const at = new Date(2026, 9, 27, 18, 59, 0).getTime();
const said = (id: string, text: string, offset: number, terminal = false): Message =>
  ({ id, at: at + offset, role: "bot", kind: "text", text, turnId: "turn-1", turnTerminal: terminal });
const step = (id: string, name: string, offset: number): Message =>
  ({ id, at: at + offset, role: "bot", kind: "activity", tool: { name, ok: true }, turnId: "turn-1" });
const asked: Message = { id: "ask", at, role: "user", kind: "text", text: "What are the 3 best AI meeting note-takers for a 10-person startup?" };
const messages: Message[] = [
  asked,
  said("ack", "I'll check current pricing since this changes often.", 9_000),
  step("search", "WebSearch", 10_000),
  step("fetch", "WebFetch", 14_000),
  said("helper", "I'll spin up a research specialist to dig into the free tiers.", 16_000),
  step("fetch-2", "WebFetch", 20_000),
  said("answer", "Fathom, Fireflies and Granola are the three to look at.", 29_000, true),
].map((message, index, all): Message => ({ ...message, parentId: all[index - 1]?.id }));
const bot: Bot = {
  id: "maus", threadId: "maus-thread", name: "MausBot", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "answer", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "maus-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};

function mount(showToolCalls: boolean) {
  const state: AppState = {
    ...initialState,
    connected: true,
    selectedId: "maus",
    bots: [bot],
    instances: [{ instanceId: "test", driverKind: "claude", displayName: "Claude", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: { showToolCalls } } as unknown as AppState["config"],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  return { container, unmount: () => { root.unmount(); container.remove(); } };
}

const transcript = (container: HTMLElement) => container.querySelector<HTMLElement>("[role=log]")!;
const rows = (container: HTMLElement) => [...transcript(container).querySelectorAll<HTMLElement>("[data-mid]")].map((row) => row.dataset.mid);

afterEach(() => vi.unstubAllGlobals());

describe("a finished turn in a conversation", () => {
  it("keeps the bot's progress lines above its answer, with no chip when steps are hidden", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container, unmount } = mount(false);
    try {
      expect(rows(container)).toEqual(["ask", "ack", "helper", "answer"]);
      const text = transcript(container).textContent ?? "";
      expect(text).toContain("I'll check current pricing since this changes often.");
      expect(text).toContain("I'll spin up a research specialist");
      expect(text.indexOf("I'll check current pricing")).toBeLessThan(text.indexOf("Fathom, Fireflies and Granola"));
      expect(text).not.toContain("Worked for");
      expect(transcript(container).querySelector("button.ui-pill")).toBeNull();
    } finally { unmount(); }
  });

  it("folds only its tool steps into one Worked-for chip when steps are shown", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container, unmount } = mount(true);
    try {
      expect(rows(container)).toEqual(["ask", "ack", "helper", "answer"]);
      const chips = [...transcript(container).querySelectorAll<HTMLButtonElement>("button.ui-pill")];
      expect(chips.map((chip) => chip.textContent)).toEqual(["Worked for 29s"]);
      flushSync(() => chips[0]!.click());
      expect(rows(container)).toEqual(["ask", "ack", "search", "fetch", "fetch-2", "helper", "answer"]);
    } finally { unmount(); }
  });
});
