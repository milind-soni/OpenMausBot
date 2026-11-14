import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { RoomContextWarningsView, ThreadContextWarningView } from "@/components/ContextWarning";
import { CONTEXT_WARNING_PERCENT, roomContextWarnings, threadContextWarning } from "./context-warning";

const usage = (tokens: number, window?: number) => ({ input: 0, output: 0, costUsd: null, turns: 1, context: { tokens, ...(window ? { window } : {}) } });
const bot = (id: string) => ({ id, name: id }) as Bot;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("context warning", () => {
  it("keeps every thread's reading in view, not only a nearly full one", () => {
    expect(CONTEXT_WARNING_PERCENT).toBe(80);
    expect(threadContextWarning(usage(1_000, 200_000))).toEqual({ tokens: 1_000, window: 200_000, percent: 1 });
    expect(threadContextWarning(usage(180_000, 200_000))).toEqual({ tokens: 180_000, window: 200_000, percent: 90 });
    expect(threadContextWarning(usage(180_000))).toEqual({ tokens: 180_000 });
    expect(threadContextWarning(usage(0, 200_000))).toBeNull();
    expect(threadContextWarning(undefined)).toBeNull();
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

  it("shows the reading in a quiet pill, turns it into a warning at 80%, and locks Compact now while the bot works", () => {
    const calm = renderToStaticMarkup(createElement(ThreadContextWarningView, { name: "Scout", tokens: 678_000, window: 1_000_000, percent: 68, busy: false, pending: false, onCompact: vi.fn() }));
    expect(text(calm)).toBe("Context 678k (68% of 1M) Compact now");
    expect(calm).not.toContain("bg-warning/10");
    expect(calm).not.toContain("disabled=\"\"");

    const full = renderToStaticMarkup(createElement(ThreadContextWarningView, { name: "Scout", tokens: 180_000, window: 200_000, percent: 90, busy: false, pending: false, onCompact: vi.fn() }));
    expect(full).toContain("bg-warning/10");

    const busy = renderToStaticMarkup(createElement(ThreadContextWarningView, { name: "Scout", tokens: 180_000, window: 200_000, percent: 90, busy: true, pending: false, onCompact: vi.fn() }));
    expect(busy).toContain("disabled=\"\"");
    expect(busy).toContain("Stop this bot&#x27;s turn first");
  });
});
