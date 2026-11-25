// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { Message } from "@/state/store";
import { noteTurnEvent, resetTurnLive } from "@/state/turn-status";
import { SidebarWorkingStep, useHeldText } from "./SidebarWorkingStep";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); host = document.createElement("div"); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); resetTurnLive(); });

const bot = { threadId: "t-side", tasks: [{ threadId: "t-side", title: "x", createdAt: 0, busy: true }] };
const commandStep = (target: string): Message => ({ id: "a", at: 1, role: "bot", kind: "activity", tool: { name: "Bash", step: { activity: "command", target } } });
const phrase = () => host.querySelector("[data-sidebar-working-phrase]")?.textContent;

describe("sidebar working line", () => {
  it("names the kind of step, never the command itself", () => {
    act(() => root.render(createElement(SidebarWorkingStep, { bot, last: commandStep("sleep 240") })));
    expect(phrase()).toBe("Running a command");
  });

  it("drops the command from the engine's live status too", () => {
    noteTurnEvent({ eventId: "e1", provider: "claudeAgent", threadId: "t-side", createdAt: "2026-11-07T00:00:00.000Z", turnId: "turn-1",
      type: "turn.progress", activity: "command", itemId: "c1", target: "sleep 240" } as RuntimeEvent);
    act(() => root.render(createElement(SidebarWorkingStep, { bot })));
    expect(phrase()).toBe("Running a command");
  });
});

describe("useHeldText", () => {
  let seen: string[] = [];
  function Probe({ text }: { text: string }) { seen.push(useHeldText(text)); return null; }
  const show = (text: string) => act(() => root.render(createElement(Probe, { text })));

  it("changes at most once per hold, and shows the newest text when the hold ends", () => {
    seen = [];
    show("Thinking");
    vi.advanceTimersByTime(1000);
    show("Running a command");
    show("Reading a file");
    expect(seen.at(-1)).toBe("Thinking");
    act(() => vi.advanceTimersByTime(3999));
    expect(seen.at(-1)).toBe("Thinking");
    act(() => vi.advanceTimersByTime(1));
    expect(seen.at(-1)).toBe("Reading a file");
    expect(seen).not.toContain("Running a command");
  });

  it("clears at once when the step ends", () => {
    function Clearing({ text }: { text?: string }) { seen.push(useHeldText(text) ?? "(none)"); return null; }
    seen = [];
    act(() => root.render(createElement(Clearing, { text: "Running a command" })));
    act(() => root.render(createElement(Clearing, {})));
    expect(seen.at(-1)).toBe("(none)");
  });
});
