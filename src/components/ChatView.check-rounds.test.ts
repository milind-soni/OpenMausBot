// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
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
const { t } = await import("@/lib/i18n");

const at = new Date(2026, 10, 25, 9, 0).getTime();
const check = (id: string, parentId: string, name: string, round?: number): Message => ({
  id, parentId, at, role: "bot", kind: "activity", tool: { name, ok: true, input: "Vera · round 1 of 3", output: "Issues found: 1" },
  threadRef: { botId: "pepper", threadId: "check-thread", title: "Check before done" }, ...(round ? { checkRound: round } : {}),
});
const messages: Message[] = [
  { id: "ask", parentId: undefined, at, role: "user", kind: "text", text: "Write the summary" },
  { id: "first", parentId: "ask", at, role: "bot", kind: "text", text: "First summary, it says dusk." },
  check("found", "first", "Vera found 1 issue · fixing it, round 1 of 3", 1),
  { id: "fixed", parentId: "found", at, role: "bot", kind: "text", text: "Fixed summary, it says dawn." },
  check("passed", "fixed", "Checked by Vera · passed in round 2"),
];
const bot: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "passed", modelSelection: { instanceId: "test", model: "m" },
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

describe("Check before done rounds in the chat", () => {
  it("shows an answer a check sent back as one line that opens and folds again, and the fixed answer in full", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
    try {
      flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
      const folded = () => container.querySelector<HTMLButtonElement>("[data-testid=earlier-answer]");
      expect(folded()?.textContent).toBe(`${t("chat.checkWork.earlierAnswer", { round: 1 })}First summary, it says dusk.`);
      expect(container.querySelectorAll("[data-testid=earlier-answer]")).toHaveLength(1);
      expect(container.querySelector("[data-look=message-bot]")?.textContent).toContain("Fixed summary, it says dawn.");
      expect([...container.querySelectorAll("[data-look=message-bot]")].some((row) => row.textContent?.includes("First summary"))).toBe(false);

      flushSync(() => folded()!.click());
      expect(folded()).toBeNull();
      const opened = [...container.querySelectorAll("[data-look=message-bot]")].find((row) => row.textContent?.includes("First summary, it says dusk."));
      expect(opened).toBeDefined();
      const less = [...opened!.querySelectorAll("button")].find((button) => button.textContent === t("chat.showLess"));
      flushSync(() => less!.click());
      expect(folded()).not.toBeNull();
    } finally {
      root.unmount();
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["a citation jump", undefined],
    ["a search hit", "dusk"],
  ])("opens a folded answer for %s, and Show less folds it again", (_name, matchText) => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const focused: AppState = { ...state, focusMessage: { threadId: "pepper-thread", messageId: "first", ...(matchText ? { matchText } : {}), nonce: 1, consumed: false } };
    const value = { state: focused, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
    try {
      flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
      const folded = () => container.querySelector<HTMLButtonElement>("[data-testid=earlier-answer]");
      expect(folded()).toBeNull();
      const opened = container.querySelector(`[data-citation-source="first"]`)?.closest("[data-look=message-bot]");
      expect(opened?.textContent).toContain("First summary, it says dusk.");
      const less = [...opened!.querySelectorAll("button")].find((button) => button.textContent === t("chat.showLess"));
      flushSync(() => less!.click());
      expect(folded()).not.toBeNull();
    } finally {
      root.unmount();
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
