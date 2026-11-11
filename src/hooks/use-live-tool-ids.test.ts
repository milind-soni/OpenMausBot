// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { ToolRunMessage } from "@/lib/tool-liveness";
import { useLiveToolIds } from "./use-live-tool-ids";

const tool = (id: string, at: number, done = false): ToolRunMessage => ({ id, at, role: "bot", kind: "activity", turnId: "t1", ...(done ? { turnCompletedAt: at } : {}) });
const text = (id: string, at: number): ToolRunMessage => ({ id, at, role: "bot", kind: "text", turnId: "t1" });

describe("useLiveToolIds", () => {
  it("keeps the same set while the same calls run, and a new one when they change", () => {
    const seen: Array<ReadonlySet<string>> = [];
    function Probe({ messages, busy }: { messages: ToolRunMessage[]; busy: boolean }) {
      seen.push(useLiveToolIds(messages, { busy, turnStartedAt: 1 }));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const draw = (messages: ToolRunMessage[], busy = true) => flushSync(() => root.render(createElement(Probe, { messages, busy })));
    draw([tool("a", 2)]);
    draw([tool("a", 2), text("x", 3)]);
    expect(seen[1]).toBe(seen[0]);
    draw([tool("a", 2), text("x", 3), tool("b", 4)]);
    expect([...seen[2]!]).toEqual(["a", "b"]);
    draw([tool("a", 2), text("x", 3), tool("b", 4)], false);
    expect(seen[3]!.size).toBe(0);
    root.unmount();
  });
});
