// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null, instances: [{ instanceId: "test", driverKind: "claudeAgent", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => true,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { renderTrigger: (state: { open: boolean }) => unknown }) => props.renderTrigger({ open: false }),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span"),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));

const { ChatView } = await import("./ChatView");
const { noteTurnEvent, resetTurnLive } = await import("@/state/turn-status");

const THREAD = "selected";
const started = Date.UTC(2026, 9, 23, 12, 0, 0);
const busyBot = (messages: Message[], busy = true): Bot => ({
  id: "bot", threadId: THREAD, name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined, messages,
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: THREAD, title: "Dashboard", createdAt: 1, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? started : undefined,
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "full" }],
});
const ask: Message = { id: "ask", role: "user", kind: "text", at: started, text: "Build me a sales dashboard" };
const intro: Message = { id: "intro", role: "bot", kind: "text", at: started + 5_000, text: "I'll build the dashboard now.", turnId: "t1" };

let seq = 0;
const engine = (event: Partial<RuntimeEvent>) => act(() => noteTurnEvent({
  eventId: `e${++seq}`, provider: "claudeAgent", threadId: THREAD, createdAt: new Date().toISOString(), turnId: "t1", ...event,
} as RuntimeEvent));

let host: HTMLDivElement;
let root: Root;
const render = (shown: Bot) => act(() => root.render(createElement(ChatView, { bot: shown })));
const mascot = () => host.querySelector(".turn-presence");
/** The line as it reads: the phrase fading out is not part of it. */
const statusLine = () => {
  const line = host.querySelector("[data-turn-status]")?.cloneNode(true) as HTMLElement | undefined;
  line?.querySelectorAll(".turn-phrase-out").forEach((node) => node.remove());
  return line?.textContent?.replace(/\s+/g, " ").trim() ?? null;
};

beforeEach(() => {
  vi.useFakeTimers({ now: started + 72_000 });
  resetTurnLive();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the mascot and its status line through a long turn", () => {
  it("stays after the bot's words while the engine writes a file, saying what and how much", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.completed", itemType: "assistant_text", text: intro.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(mascot(), "the bot said a sentence mid-turn: the mascot must not vanish").not.toBeNull();
    expect(statusLine()).toBe("Working · 1m 12s");

    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", bytes: 0 } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 14 * 1024 + 300 } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("Working · 1m 12s · Writing index.html · 14 KB");

    // Ten silent minutes: no frame, no row. Nothing times the mascot out.
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(mascot()).not.toBeNull();
    expect(statusLine()).toBe("Working · 11m 12s · Writing index.html · 14 KB");
  });

  it("stays through a long silent tool, keeping the call's own words while it runs", () => {
    const bash: Message = { id: "bash", role: "bot", kind: "activity", at: started + 6_000, turnId: "t1", tool: { name: "Bash", itemId: "toolu_bash" } };
    engine({ type: "turn.progress", activity: "command", itemId: "toolu_bash", bytes: 20 } as Partial<RuntimeEvent>);
    engine({ type: "item.started", itemType: "tool", itemId: "toolu_bash", title: "Bash" } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro, bash]));
    expect(statusLine()).toBe("Working · 1m 12s · Running a command");
    for (let beat = 0; beat < 20; beat++) {
      act(() => void vi.advanceTimersByTime(30_000));
      engine({ type: "item.updated", itemType: "tool" } as Partial<RuntimeEvent>);
    }
    expect(mascot()).not.toBeNull();
    // The phrase may rest on its alternate by now; the call is still the one running.
    expect(statusLine()).toMatch(/^Working · 11m 12s · (Running a command|Checking the output)$/);

    engine({ type: "item.completed", itemType: "tool", itemId: "toolu_bash", ok: true } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro, { ...bash, tool: { ...bash.tool!, ok: true } }]));
    expect(statusLine(), "with nothing reported, the line is its timer alone").toBe("Working · 11m 12s");
  });

  it("clears when the turn ends, even before busy winds down", () => {
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 15_000 } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(mascot()).not.toBeNull();

    const done: Message = { id: "done", role: "bot", kind: "text", at: started + 80_000, text: "Done: index.html is ready.", turnId: "t1" };
    engine({ type: "item.started", itemType: "tool", itemId: "toolu_write", title: "Write" } as Partial<RuntimeEvent>);
    engine({ type: "item.completed", itemType: "tool", itemId: "toolu_write", ok: true } as Partial<RuntimeEvent>);
    engine({ type: "item.completed", itemType: "assistant_text", text: done.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro, done]));
    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    act(() => void vi.advanceTimersByTime(600));
    expect(mascot(), "the reply settled and the turn ended: busy is still on, the mascot is not").toBeNull();
    expect(statusLine()).toBeNull();

    render(busyBot([ask, intro, done], false));
    expect(mascot()).toBeNull();
  });

  it("hides while the bot waits on the person, and the next turn starts clean", () => {
    engine({ type: "turn.progress", activity: "edit", itemId: "toolu_edit", file: "app.ts", bytes: 2048 } as Partial<RuntimeEvent>);
    const asking = busyBot([ask, intro]);
    render({ ...asking, activity: "waiting-on-you", tasks: asking.tasks!.map((task) => ({ ...task, activity: "waiting-on-you" })) });
    expect(mascot()).toBeNull();

    engine({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    const next: Message = { id: "next", role: "user", kind: "text", at: started + 90_000, text: "Add a chart" };
    render(busyBot([ask, intro, next]));
    expect(statusLine(), "a new prompt shows the line before the new turn's first frame").toBe("Working · 1m 12s");
    engine({ type: "turn.started", turnId: "t2" } as Partial<RuntimeEvent>);
    engine({ type: "content.delta", turnId: "t2", streamKind: "reasoning_text", delta: "Plan the chart" } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("Working · 1m 12s · Thinking");
  });
});
