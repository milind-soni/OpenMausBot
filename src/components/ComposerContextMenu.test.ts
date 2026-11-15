// @vitest-environment happy-dom
// The composer's context button: how full the conversation is, with compacting and starting fresh one click away.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextReading, contextRows, roomContextReadings } from "@/lib/context-usage";
import { BotEditorStore, type Bot, type Group, type Message, type TaskUsage, type useStore } from "@/state/store";
import type { ContextBreakdown } from "../../shared/context-breakdown";
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
let breakdown: ContextBreakdown | null;

const render = (props: Parameters<typeof ComposerContextMenu>[0]) => act(async () => {
  root.render(createElement(BotEditorStore, { value: store, children: createElement(ComposerContextMenu, props) }));
});
const trigger = () => host.querySelector<HTMLButtonElement>("[data-composer-context] > button")!;
const panel = () => host.querySelector<HTMLElement>("[data-context-panel]");
const press = (element: HTMLElement) => act(async () => { element.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const words = () => panel()!.textContent!.replace(/\s+/g, " ");
const requests = () => fetched.mock.calls.map(([url, init]) => [String(url).replace(/^.*(?=\/api\/)/, ""), JSON.parse(String((init as RequestInit).body))]);
const posted = () => requests().filter(([path]) => !path.endsWith("/context"));
const counted: ContextBreakdown = {
  tokens: 136_000, window: 200_000,
  categories: [
    { id: "system_prompt", kind: "used", tokens: 8_000 }, { id: "system_tools", kind: "used", tokens: 10_000 },
    { id: "mcp_tools", kind: "used", tokens: 6_000 }, { id: "memory_files", kind: "used", tokens: 2_000 },
    { id: "skills", kind: "used", tokens: 3_000 }, { id: "custom_agents", kind: "used", tokens: 1_000 },
    { id: "something_new", kind: "used", tokens: 6_000 }, { id: "messages", kind: "used", tokens: 100_000 },
    { id: "autocompact_buffer", kind: "buffer", tokens: 24_000 }, { id: "free_space", kind: "free", tokens: 40_000 },
  ],
  messages: { toolCalls: 12_000, toolResults: 24_000, attachments: 4_000, assistant: 40_000, user: 20_000 },
  autoCompact: true, autoCompactAt: 176_000,
};

beforeEach(() => {
  breakdown = null;
  fetched = vi.fn(async (url: unknown) => new Response(String(url).endsWith("/context") ? JSON.stringify({ threadId: "t1", breakdown }) : "{}", { status: 200, headers: { "content-type": "application/json" } }));
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

  it("asks the engine what fills the context when the panel opens, and lists it in Simple mode too", async () => {
    breakdown = counted;
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }) });
    expect(requests()).toEqual([]);
    await press(trigger());
    expect(requests()).toEqual([["/api/bots/b1/context", { threadId: "t1" }]]);
    expect([...panel()!.querySelectorAll("[data-context-breakdown] > div")].map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]))
      .toEqual([
        ["System prompt", "8k · 4%"], ["Memory files", "2k · 1%"], ["Tools", "16k · 8%"], ["Skills and subagents", "4k · 2%"],
        ["Tool calls and results", "36k · 18%"], ["Messages", "64k · 32%"], ["Other", "6k · 3%"],
        ["Reserved for compacting", "24k · 12%"], ["Free space", "40k · 20%"],
      ]);
    expect(words()).toContain("The provider compacts this conversation automatically.");
  });

  it("takes the total from the engine's count when it differs from the last turn's reading", async () => {
    breakdown = {
      tokens: 6_000, window: 200_000,
      categories: [
        { id: "system_prompt", kind: "used", tokens: 1_900 }, { id: "messages", kind: "used", tokens: 4_100 },
        { id: "free_space", kind: "free", tokens: 194_000 },
      ],
    };
    const bot = chat({ tokens: 12, window: 200_000 }, { id: "b3" });
    await render({ bot });
    expect(trigger().getAttribute("aria-label")).toBe("Context 0%");
    await press(trigger());
    expect(words()).toContain("3% used");
    expect(words()).toContain("6k of 200k tokens");
    expect(words()).not.toContain("0% used");
    expect(panel()!.querySelector("[data-context-meter]")!.getAttribute("data-context-meter")).toBe("3");
    expect(trigger().getAttribute("aria-label")).toBe("Context 3%");
    expect([...panel()!.querySelectorAll("[data-context-breakdown] dd")].map((cell) => cell.textContent)).toEqual(["1.9k · 1%", "4.1k · 2.1%", "194k · 97%"]);

    await press(trigger());
    fetched.mockImplementation(() => new Promise<Response>(() => {}));
    await render({ bot: { ...bot, messages: [...bot.messages!, line("m3", "bot", "compaction")] } as Bot });
    await press(trigger());
    expect(words()).toContain("No reading yet");
    expect(panel()!.querySelector("[data-context-breakdown]")).toBeNull();

    await press(trigger());
    await render({ bot: { ...bot, threadId: "t2", tasks: [{ threadId: "t2", usage: { input: 0, output: 0, costUsd: null, turns: 1, context: { tokens: 50_000, window: 200_000 } } }] } as unknown as Bot });
    await press(trigger());
    expect(words()).toContain("25% used");
    expect(panel()!.querySelector("[data-context-breakdown]")).toBeNull();
  });

  it("keeps the total alone when the engine has no count, and the last count on screen while a new one loads", async () => {
    await render({ bot: chat({ tokens: 136_000, window: 200_000 }, { id: "b2" }) });
    await press(trigger());
    expect(words()).toContain("68% used");
    expect(panel()!.querySelector("[data-context-breakdown]")).toBeNull();
    expect(words()).not.toContain("The provider compacts");
    await press(trigger());

    breakdown = counted;
    await press(trigger());
    expect(panel()!.querySelector("[data-context-breakdown]")).not.toBeNull();
    await press(trigger());
    fetched.mockImplementation(() => new Promise<Response>(() => {}));
    await press(trigger());
    expect(panel()!.querySelectorAll("[data-context-breakdown] > div")).toHaveLength(9);

    await press(trigger());
    fetched.mockImplementation(async () => { throw new Error("offline"); });
    await press(trigger());
    expect(panel()!.querySelector("[data-context-breakdown]")).toBeNull();
    expect(words()).toContain("68% used");
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
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

  it("needs a window and something counted as used; the rest of the messages is what tools did not take", () => {
    expect(contextRows(null)).toBeNull();
    expect(contextRows({ tokens: 0, window: 1_000, categories: [{ id: "free_space", kind: "free", tokens: 1_000 }] })).toBeNull();
    expect(contextRows({ tokens: 100, window: 1_000, categories: [{ id: "messages", kind: "used", tokens: 100 }], messages: { toolCalls: 60, toolResults: 40, attachments: 0, assistant: 0, user: 0 } }))
      .toEqual([{ id: "toolCalls", tokens: 100, percent: 10 }]);
    expect(contextRows({ tokens: 100, window: 1_000, categories: [{ id: "messages", kind: "used", tokens: 100 }, { id: "compact_buffer", kind: "buffer", tokens: 50 }] }))
      .toEqual([{ id: "messages", tokens: 100, percent: 10 }, { id: "reserved", tokens: 50, percent: 5 }]);
  });
});
