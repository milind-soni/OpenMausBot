import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, Message } from "@/state/store";
import { RoomContextWarningsView, ThreadContextWarningView } from "@/components/ContextWarning";
import { CONTEXT_WARNING_PERCENT, compactedSinceReading, roomContextWarnings, threadContextWarning } from "./context-warning";

const usage = (tokens: number, window?: number) => ({ input: 0, output: 0, costUsd: null, turns: 1, context: { tokens, ...(window ? { window } : {}) } });
const line = (role: Message["role"], kind: Message["kind"]) => ({ role, kind });
const bot = (id: string) => ({ id, name: id }) as Bot;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("context warning", () => {
  it("warns a 1:1 thread from 80% of a known window, and not after a compaction", () => {
    expect(CONTEXT_WARNING_PERCENT).toBe(80);
    const history = [line("user", "text"), line("bot", "text")];
    expect(threadContextWarning(usage(157_000, 200_000), history)).toBeNull();
    expect(threadContextWarning(usage(180_000, 200_000), history)).toEqual({ percent: 90 });
    expect(threadContextWarning(usage(180_000), history)).toBeNull();
    expect(threadContextWarning(undefined, history)).toBeNull();
    const compacted = [...history, line("bot", "compaction")];
    expect(compactedSinceReading(compacted)).toBe(true);
    expect(threadContextWarning(usage(180_000, 200_000), compacted)).toBeNull();
    expect(compactedSinceReading([...compacted, line("user", "text"), line("bot", "activity"), line("bot", "text")])).toBe(false);
  });

  it("lists room members at 80% or more in roster order, with a pending Compact now", () => {
    const members = [bot("Scout"), bot("Pixel"), bot("Quill")];
    const warnings = roomContextWarnings({ memberContext: {
      Quill: { tokens: 190_000, window: 200_000, compactRequested: true },
      Scout: { tokens: 170_000, window: 200_000 },
      Pixel: { tokens: 100_000, window: 200_000 },
    } }, members);
    expect(warnings.map(({ bot: member, percent, requested }) => [member.id, percent, requested]))
      .toEqual([["Scout", 85, false], ["Quill", 95, true]]);
    expect(roomContextWarnings({ memberContext: null }, members)).toEqual([]);

    const onCompact = vi.fn();
    const markup = renderToStaticMarkup(createElement(RoomContextWarningsView, { warnings, pendingBotId: null, onCompact }));
    expect(text(markup)).toBe("Scout's context in this room is 85% full. Compact now Quill's context in this room is 95% full. Compacts before its next turn.");
  });

  it("offers Compact now in the 1:1 header, locked while the bot works", () => {
    const idle = renderToStaticMarkup(createElement(ThreadContextWarningView, { name: "Scout", percent: 91, busy: false, pending: false, onCompact: vi.fn() }));
    expect(text(idle)).toBe("Context 91% Compact now");
    expect(idle).not.toContain("disabled=\"\"");
    const busy = renderToStaticMarkup(createElement(ThreadContextWarningView, { name: "Scout", percent: 91, busy: true, pending: false, onCompact: vi.fn() }));
    expect(busy).toContain("disabled=\"\"");
    expect(busy).toContain("Stop this bot&#x27;s turn first");
  });
});
