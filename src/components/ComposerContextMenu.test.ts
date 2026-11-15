// @vitest-environment happy-dom
// The composer's context button: how full the conversation is, with compacting and starting fresh one click away.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextReading, contextRows, roomContextReadings } from "@/lib/context-usage";
import { BotEditorStore, type Bot, type Group, type Message, type TaskUsage, type useStore } from "@/state/store";
import { ComposerContextMenu } from "./ComposerContextMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = { state: {}, dispatch: vi.fn(), flushBotPatches: vi.fn(async () => null) } as unknown as ReturnType<typeof useStore>;
const line = (id: string, role: Message["role"], kind: Message["kind"] = "text", more: Partial<Message> = {}): Message => ({ id, role, kind, at: 1, text: id, ...more });
const chat = (context: NonNullable<TaskUsage["context"]>, more: Partial<Bot> = {}): Bot => ({
  id: "b1", name: "Pepper", threadId: "t1", busy: false,
  messages: [line("m1", "user"), line("m2", "bot")],
  tasks: [{ threadId: "t1", usage: { input: 0, output: 0, costUsd: null, turns: 1, context } }],
  ...more,
}) as unknown as Bot;

let host: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof vi.fn>;

const render = (props: Parameters<typeof ComposerContextMenu>[0]) => act(async () => {
  root.render(createElement(BotEditorStore, { value: store, children: createElement(ComposerContextMenu, props) }));
});
const trigger = () => host.querySelector<HTMLButtonElement>("[data-composer-context] > button")!;
const panel = () => host.querySelector<HTMLElement>("[data-context-panel]");
const press = (element: HTMLElement) => act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const words = () => panel()!.textContent!.replace(/\s+/g, " ");
const posted = () => fetched.mock.calls.map(([url, init]) => [String(url).replace(/^.*(?=\/api\/)/, ""), JSON.parse(String((init as RequestInit).body))]);

beforeEach(() => {
  fetched = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetched);
  localStorage.setItem("omb-advanced-mode", "0");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the composer's context button", () => {
  it("names how full the chat is and opens a panel with the reading and both actions", async () => {
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }) });
    expect(trigger().getAttribute("aria-label")).toBe("Context 68%");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    await press(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(words()).toContain("68% used");
    expect(words()).toContain("136k of 200k tokens");
    expect([...panel()!.querySelectorAll("button")].map((button) => [button.textContent, button.disabled]))
      .toEqual([["Compact context", false], ["Start fresh", false]]);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(panel()).toBeNull();
  });

  it("compacts through the chat's own route and stays open; starting fresh closes it", async () => {
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }) });
    await press(trigger());
    await press(panel()!.querySelector<HTMLButtonElement>("[data-context-compact]")!);
    expect(posted()).toEqual([["/api/bots/b1/compact", { threadId: "t1" }]]);
    expect(panel()).not.toBeNull();
    await press(panel()!.querySelector<HTMLButtonElement>("[data-context-fresh]")!);
    expect(posted().at(-1)).toEqual(["/api/bots/b1/start-fresh", { threadId: "t1" }]);
    expect(panel()).toBeNull();
  });

  it("offers neither action while the bot works, and no stale reading once the chat was summarized", async () => {
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }, { busy: true }) });
    await press(trigger());
    expect([...panel()!.querySelectorAll("button")].map((button) => button.disabled)).toEqual([true, true]);
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }, { messages: [line("m1", "user"), line("m2", "bot"), line("m3", "bot", "compaction")] }) });
    expect(trigger().getAttribute("aria-label")).toBe("Context");
    expect(words()).toContain("No reading yet");
    expect(panel()!.querySelector<HTMLButtonElement>("[data-context-compact]")!.disabled).toBe(true);
    expect(panel()!.querySelector<HTMLButtonElement>("[data-context-fresh]")!.disabled).toBe(false);
  });

  it("lists what fills the context only when the reading carries it, and only in Advanced", async () => {
    const breakdown = { providerCompacts: true, categories: [
      { id: "systemPrompt", tokens: 8_000 }, { id: "messages", tokens: 100_000 }, { id: "toolCalls", tokens: 20_000 }, { id: "somethingNew", tokens: 8_000 },
    ] };
    await render({ bot: chat({ tokens: 136_000, window: 200_000, breakdown }) });
    await press(trigger());
    expect(panel()!.querySelector("[data-context-breakdown]")).toBeNull();
    expect(words()).toContain("The provider compacts this conversation automatically.");
    localStorage.setItem("omb-advanced-mode", "1");
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "omb-advanced-mode", newValue: "1" })); });
    expect([...panel()!.querySelectorAll("[data-context-breakdown] dt")].map((term) => term.textContent))
      .toEqual(["System prompt", "Tool calls and results", "Messages", "Other", "Free space"]);
    expect(panel()!.querySelector("[data-context-breakdown]")!.textContent).toContain("64k · 32%");
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }) });
    expect(panel()!.querySelector("[data-context-breakdown]")).toBeNull();
  });

  it("shows each measured bot of a room with its own compact, and no start fresh", async () => {
    const members = [{ id: "s", name: "Scout" }, { id: "p", name: "Pixel" }, { id: "q", name: "Quill" }] as Bot[];
    const group = { id: "g1", memberContext: { s: { tokens: 170_000, window: 200_000 }, q: { tokens: 60_000, window: 200_000, compactRequested: true } } } as unknown as Group;
    await render({ group, members });
    expect(trigger().getAttribute("aria-label")).toBe("Context 85%");
    await press(trigger());
    expect([...panel()!.querySelectorAll("[data-context-member]")].map((row) => row.getAttribute("data-context-member"))).toEqual(["s", "q"]);
    expect(words()).toContain("Scout85% used");
    expect(words()).toContain("Compacts before its next turn.");
    expect(panel()!.querySelector("[data-context-fresh]")).toBeNull();
    await press(panel()!.querySelector<HTMLButtonElement>("[data-context-compact]")!);
    expect(posted()).toEqual([["/api/groups/g1/members/s/compact", {}]]);
    await render({ group: { id: "g1", memberContext: null } as unknown as Group, members });
    expect(words()).toContain("No reading yet");
  });
});

describe("context readings", () => {
  it("turns tokens and a window into a share with a tone", () => {
    expect(contextReading(0, 200_000)).toBeNull();
    expect(contextReading(90_000, 200_000)).toEqual({ tokens: 90_000, window: 200_000, percent: 45, tone: "quiet" });
    expect(contextReading(136_000, 200_000)?.tone).toBe("warning");
    expect(contextReading(170_000, 200_000)?.tone).toBe("danger");
    expect(contextReading(170_000, undefined)).toEqual({ tokens: 170_000, window: undefined, percent: undefined, tone: "quiet" });
    expect(roomContextReadings({ memberContext: { a: { tokens: 0, window: 200_000 } } }, [{ id: "a" } as Bot])).toEqual([]);
  });

  it("folds unknown kinds into Other and closes with the free space", () => {
    expect(contextRows({ tokens: 100 })).toBeNull();
    expect(contextRows({ tokens: 100, window: 1_000, breakdown: { categories: [] } })).toBeNull();
    expect(contextRows({ tokens: 100, window: 1_000, breakdown: { categories: [{ id: "x", tokens: 30 }, { id: "other", tokens: 20 }, { id: "tools", tokens: 50 }] } }))
      .toEqual([{ id: "tools", tokens: 50, percent: 5 }, { id: "other", tokens: 50, percent: 5 }, { id: "free", tokens: 900, percent: 90 }]);
    expect(contextRows({ tokens: 100, breakdown: { categories: [{ id: "messages", tokens: 100 }] } })).toEqual([{ id: "messages", tokens: 100, percent: undefined }]);
  });
});
