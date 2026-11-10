// @vitest-environment happy-dom
// The real mode with the switch to Simple as the only mode turned on, as it can be again: a paired remote client keeps
// the controls its "advanced || remoteClient" branches gave it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("@/lib/simple-only", () => ({ SIMPLE_ONLY: true }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { readAdvancedMode, setAdvancedMode } = await import("@/lib/interface-mode");
const { simpleRoomHeader } = await import("@/lib/room-panel");
const { BotEditorStore, initialState } = await import("@/state/store");

const messages: Message[] = [
  { id: "m1", role: "user", kind: "text", text: "hello", at: 1 },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: "Hi.", at: 2 },
];
const task = (threadId: string, extra = {}) => ({ threadId, title: threadId, createdAt: 1, busy: false, activity: "idle" as const,
  modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" as const, ...extra });
const bot: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "m2", modelSelection: { instanceId: "test", model: "m" },
  tasks: [task("pepper-thread"), task("side-job", { busy: true, activity: "working" })],
};

let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw() {
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: {} } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
const head = () => document.querySelector("[data-chathead-controls]")!;

beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { delete window.ogb; });
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("Simple as the only mode", () => {
  it("reads as Simple even after something asks for Advanced", () => {
    setAdvancedMode(true);
    expect(readAdvancedMode()).toBe(false);
  });

  it("keeps a paired remote client's chat menu and other-activity picker, which this computer's Simple chat leaves out", async () => {
    await draw();
    expect(head().querySelector('[data-testid="chat-more"]')).toBeNull();
    expect(document.querySelector("[data-background-activity]")).toBeNull();

    window.ogb = { remoteClient: { active: true } } as NonNullable<Window["ogb"]>;
    await draw();
    expect(head().querySelector('[data-testid="chat-more"]')).not.toBeNull();
    expect(document.querySelector("[data-background-activity]")).not.toBeNull();
  });

  it("keeps a paired remote client's full room header", () => {
    const room = { advanced: readAdvancedMode(), group: { dm: false }, setupPending: false };
    expect(simpleRoomHeader({ ...room, remoteClient: false })).toBe(true);
    expect(simpleRoomHeader({ ...room, remoteClient: true })).toBe(false);
  });
});
