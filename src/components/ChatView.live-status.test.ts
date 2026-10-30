// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null, instances: [{ instanceId: "test", driverKind: "claudeAgent", displayName: "Test" } as InstanceInfo] },
    dispatch,
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
const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced, setAdvancedMode: vi.fn() }));
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
const { useActivityFocus } = await import("@/lib/activity-focus");

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
  mode.advanced = true;
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Simple mode's working line", () => {
  it("is the bot's 28px avatar and one quiet friendly phrase, with the timer and size kept in its tooltip", () => {
    mode.advanced = false;
    engine({ type: "turn.started" });
    render(busyBot([ask]));
    expect(mascot()).not.toBeNull();
    expect(statusLine()).toBe("Thinking it through");
    expect(mascot()!.innerHTML).toContain('width="28px"');
    const row = mascot()!.firstElementChild as HTMLElement;
    expect([...row.classList]).toEqual(expect.arrayContaining(["h-9", "ps-2", "gap-2"]));
    expect(row.title).toMatch(/^Working · /);
    expect(mascot()!.querySelector("[data-turn-status]")!.classList).toContain("text-ink-tertiary");
    expect(mascot()!.classList).not.toContain("-mt-3");

    engine({ type: "item.completed", itemType: "assistant_text", text: intro.text! } as Partial<RuntimeEvent>);
    render(busyBot([ask, intro]));
    expect(mascot()!.classList, "under the bot's own bubble it sits close, as one more part of the reply").toContain("-mt-3");
    // The reply that just arrived pops in first; the line comes back once it has.
    act(() => void vi.advanceTimersByTime(600));
    engine({ type: "turn.progress", activity: "write", itemId: "toolu_write", file: "index.html", bytes: 14 * 1024 + 300 } as Partial<RuntimeEvent>);
    expect(statusLine()).toBe("Writing some code");
  });

  it("says Teammates working while the bot waits on its teammates", () => {
    mode.advanced = false;
    const waiting = busyBot([ask, intro], false);
    render({ ...waiting, waitingForTeammates: true, tasks: waiting.tasks!.map((task) => ({ ...task, waitingForTeammates: true })) });
    expect(statusLine()).toBe("Teammates working");
  });
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

describe("what the bot is doing right now", () => {
  const search: Message = { id: "search", role: "bot", kind: "activity", at: started + 4_000, turnId: "t1",
    tool: { name: "WebSearch", itemId: "s1", ok: true, step: { activity: "web", target: "Biber Dammbau" } } };
  const bash: Message = { id: "bash", role: "bot", kind: "activity", at: started + 6_000, turnId: "t1",
    tool: { name: "Bash", itemId: "b1", step: { activity: "command", target: "scrape.py", detail: "python3 scrape.py --pages 40" } } };
  const toggle = () => host.querySelector<HTMLButtonElement>(".turn-presence button[aria-expanded]");
  const steps = () => [...host.querySelectorAll("[data-now-step]")].map((step) => `${step.getAttribute("data-now-step")}: ${step.querySelector("[dir=auto]")?.textContent}`);

  it("names the step, says how it is doing, and unfolds the ask's steps with a way into the Activity panel at this run", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", detail: "python3 scrape.py --pages 40", quiet: { kind: "busy" } } as Partial<RuntimeEvent>);
    render(busyBot([ask, search, bash]));
    expect(statusLine()).toBe("Working · 1m 12s · Running scrape.py · busy, no output yet");
    expect(host.querySelector("[data-turn-now]")?.getAttribute("title")).toBe("python3 scrape.py --pages 40");
    expect(toggle()?.getAttribute("aria-label")).toBe("What Pepper is doing");
    expect(host.querySelector("[data-now-card]")).toBeNull();

    act(() => toggle()!.click());
    expect(steps()).toEqual(["done: Searched the web for “Biber Dammbau”", "now: Running scrape.py"]);
    const seen: Array<ReturnType<typeof useActivityFocus>> = [];
    const probe = createRoot(document.createElement("div"));
    act(() => probe.render(createElement(() => { seen.push(useActivityFocus("bot")); return null; })));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("[data-now-card] button")].find((button) => button.textContent === "Open activity")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleActivity", open: true });
    expect(seen.at(-1)).toEqual({ botId: "bot", threadId: THREAD, turnId: "t1" });
    act(() => probe.unmount());
  });

  it("shows a running command's last lines of output in the card, and the time since they came on the line", () => {
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", quiet: { kind: "output", at: started + 72_000 - 125_000 },
      tail: ["page 39 of 40", "page 40 of 40"] } as Partial<RuntimeEvent>);
    render(busyBot([ask, bash]));
    expect(statusLine()).toBe("Working · 1m 12s · Running scrape.py · last output 2 min ago");
    act(() => toggle()!.click());
    expect(host.querySelector("[data-now-output]")?.textContent).toBe("page 39 of 40\npage 40 of 40");
  });

  it("is the same calm line in Simple mode, where the card unfolds too", () => {
    mode.advanced = false;
    engine({ type: "turn.started" });
    engine({ type: "item.started", itemType: "tool", itemId: "b1", title: "Bash" } as Partial<RuntimeEvent>);
    engine({ type: "turn.progress", activity: "command", itemId: "b1", target: "scrape.py", quiet: { kind: "idle" } } as Partial<RuntimeEvent>);
    render(busyBot([ask, search, bash]));
    expect(statusLine()).toBe("Running scrape.py · idle, no output yet");
    act(() => toggle()!.click());
    expect(steps()).toEqual(["done: Searched the web for “Biber Dammbau”", "now: Running scrape.py"]);
  });
});
