// @vitest-environment happy-dom
// The open chat's rows re-render only when their own message changes. A
// store event elsewhere (another bot's frame, a field of this bot that no
// row shows) renders none of them; a patched tool chip renders that chip
// and nothing else. Counted through the leaf each row draws, which is not
// memoized here, so it renders exactly when its row does.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

const renders = vi.hoisted(() => ({ botText: 0, userText: 0, toolChip: 0, speak: 0 }));
vi.mock("./ChatMarkdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ChatMarkdown")>(),
  ChatMarkdown: ({ text }: { text: string }) => {
    renders.botText++;
    return createElement("p", null, text);
  },
}));
vi.mock("./ThreadRefs", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ThreadRefs")>(),
  ThreadRefText: ({ text }: { text: string }) => {
    renders.userText++;
    return createElement("span", null, text);
  },
}));
vi.mock("./ToolActivity", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ToolActivity")>(),
  ToolActivity: ({ tool }: { tool: { name: string } }) => {
    renders.toolChip++;
    return createElement("span", null, tool.name);
  },
}));
// The real button, run inside a counting component: whatever it subscribes
// to re-renders this component, so every render of it is counted.
vi.mock("./SpeakButton", async (importOriginal) => {
  const { SpeakButton } = await importOriginal<typeof import("./SpeakButton")>();
  return {
    SpeakButton: (props: Parameters<typeof SpeakButton>[0]) => {
      renders.speak++;
      return SpeakButton(props);
    },
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");

const message = (id: string, parentId: string | undefined, fields: Partial<Message>): Message =>
  ({ id, parentId, role: "bot", kind: "text", at: new Date(2026, 9, 3, 9, Number(id.slice(1))).getTime(), ...fields });
// Three turns, each a question, one tool step and an answer; the last turn's
// step is still running.
const messages: Message[] = [];
for (let turn = 0; turn < 3; turn++) {
  const at = turn * 3;
  messages.push(
    message(`m${at}`, messages.at(-1)?.id, { role: "user", text: `Question ${turn}` }),
    message(`m${at + 1}`, `m${at}`, { kind: "activity", tool: { name: `Read file ${turn}`, ok: turn < 2 ? true : undefined } }),
  );
  if (turn < 2) messages.push(message(`m${at + 2}`, `m${at + 1}`, { text: `Answer ${turn}` }));
}
const running = messages.at(-1)!;

const profile = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});

let state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "pepper",
  bots: [profile("pepper", { messages, activeLeafId: running.id }), profile("scout")],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  config: { features: { showToolCalls: true } } as AppState["config"],
};
const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw() {
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const children = createElement(ChatView, { bot: state.bots.find((bot) => bot.id === "pepper")! });
  flushSync(() => root.render(createElement(BotEditorStore, { value, children })));
  await settle();
}
async function rowRendersAfter(change: (current: AppState) => AppState) {
  renders.botText = renders.userText = renders.toolChip = renders.speak = 0;
  state = change(state);
  await draw();
  return { ...renders };
}

beforeAll(async () => {
  // late on the day of the thread, so its separator reads "Today"
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 23, 0));
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await draw();
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chat transcript rows", () => {
  it("draws every row once on mount", () => {
    expect(document.querySelectorAll("[data-mid]")).toHaveLength(messages.length);
    expect(document.body.textContent).toContain("Today");
    expect(document.body.textContent).toContain("Answer 1");
    expect(document.body.textContent).toContain("Read file 2");
  });

  it("renders no row when another bot changes", async () => {
    const scout = state.bots.find((bot) => bot.id === "scout")!;
    expect(await rowRendersAfter((current) => reducer(current, { type: "botPatched", bot: { ...scout, busy: true } })))
      .toEqual({ botText: 0, userText: 0, toolChip: 0, speak: 0 });
  });

  it("renders no row when this bot changes in a way no row shows", async () => {
    expect(await rowRendersAfter((current) => {
      const { messages: _transcript, ...frame } = current.bots.find((bot) => bot.id === "pepper")!;
      return reducer(current, { type: "botPatched", bot: { ...frame, turnStartedAt: 5, tasks: frame.tasks?.map((task) => ({ ...task, updatedAt: 99 })) } });
    })).toEqual({ botText: 0, userText: 0, toolChip: 0, speak: 0 });
  });

  it("renders only the tool chip that changed", async () => {
    expect(await rowRendersAfter((current) => reducer(current, {
      type: "messagePatched", threadId: "pepper-thread", message: { ...running, tool: { name: "Read file 2, page 2" } },
    }))).toEqual({ botText: 0, userText: 0, toolChip: 1, speak: 0 });
    expect(document.body.textContent).toContain("Read file 2, page 2");
  });

  // The separator used to follow every store event; now it follows the date.
  it("moves Today on to Yesterday after midnight, at the next store event", async () => {
    vi.setSystemTime(new Date(2026, 9, 4, 0, 30));
    const scout = state.bots.find((bot) => bot.id === "scout")!;
    await rowRendersAfter((current) => reducer(current, { type: "botPatched", bot: { ...scout, unread: true } }));
    expect(document.body.textContent).toContain("Yesterday");
    expect(document.body.textContent).not.toContain("Today");
  });
});
