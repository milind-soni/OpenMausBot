// @vitest-environment happy-dom
// A Data receipt renders as the result chip in a 1:1 chat and in a room,
// before anything reads its tool name as a status, a failed turn or a plain
// tool run. Receipts written before the server named the tool "data_show"
// carry the card's title as the tool name, so a result called
// "notice: …" or "error: …" must still be a receipt, with Open in Data and
// no Retry.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { GroupView } = await import("./GroupView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

const at = new Date(2026, 9, 10, 9, 0).getTime();
/** An older server's receipt: the card's title doubled as the tool name. */
const legacyReceipt = (id: string, title: string, parentId?: string, extra: Partial<Message> = {}): Message => ({
  id, parentId, at, role: "bot", kind: "activity", tool: { name: title, ok: true },
  dataResult: { botId: "pepper", cardId: id, title, kind: "table", sql: "SELECT region FROM orders" }, ...extra,
});
const messages: Message[] = [
  { id: "ask", parentId: undefined, at, role: "user", kind: "text", text: "Which regions?" },
  legacyReceipt("c_1", "notice: revenue by region", "ask"),
  legacyReceipt("c_2", "error: rows with no region", "c_1"),
  { id: "answer", parentId: "c_2", at, role: "bot", kind: "text", text: "Two charts are in Data." },
];
const bot: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "answer", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};
const state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "pepper",
  bots: [bot],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  config: { features: { showToolCalls: false }, rooms: { turnTimeoutMinutes: 30 } } as unknown as AppState["config"],
};

function mount(children: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children })));
  return { container, unmount: () => { root.unmount(); container.remove(); } };
}

function expectReceipts(container: HTMLElement) {
  for (const [id, title] of [["c_1", "notice: revenue by region"], ["c_2", "error: rows with no region"]]) {
    const chip = container.querySelector(`[data-data-result="${id}"]`);
    expect(chip, `${title} renders as a result chip`).not.toBeNull();
    expect(chip!.textContent).toContain(title);
    expect(chip!.textContent).toContain(t("data.openResult"));
  }
  // not a bordered status notice carrying the result's words, not a failed turn with Retry, and shown with tool calls off
  const notices = [...container.querySelectorAll("[role=status]")].map((element) => element.textContent ?? "");
  expect(notices.some((text) => text.includes("revenue by region") || text.includes("rows with no region"))).toBe(false);
  expect(container.textContent).not.toContain(t("chat.retry"));
  expect(container.textContent).toContain("Two charts are in Data.");
}

describe("a Data receipt in the transcript", () => {
  it("renders as the result chip in a 1:1 chat whatever the result is called", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const mounted = mount(createElement(ChatView, { bot }));
    try {
      expectReceipts(mounted.container);
    } finally {
      mounted.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("renders as the result chip in a room too", () => {
    const from: NonNullable<Message["from"]> = { botId: "pepper", name: "Pepper", color: "green" };
    const group: Group = {
      id: "room", threadId: "room-thread", name: "Data review", memberIds: ["pepper"],
      defaultResponder: { kind: "member", botId: "pepper" }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1,
      messages: messages.map((message) => (message.role === "bot" ? { ...message, from } : message)),
    };
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const mounted = mount(createElement(GroupView, { group }));
    try {
      expectReceipts(mounted.container);
    } finally {
      mounted.unmount();
      vi.unstubAllGlobals();
    }
  });
});
