import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { LimitResetClock, UNNAMED_LIMIT_MS } from "./limit-resets.ts";

const NOW = Date.UTC(2026, 10, 13, 10);
const RESET = NOW + 2 * 60 * 60_000;
const base = { eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString() };
const started = (threadId: string) => ({ ...base, threadId, type: "turn.started" }) as RuntimeEvent;
const completed = (threadId: string) => ({ ...base, threadId, type: "turn.completed", ok: true }) as RuntimeEvent;
const clocks: LimitResetClock[] = [];

function clock() {
  const onChange = vi.fn();
  const instance = new LimitResetClock({ accounts: () => [], now: () => NOW, onChange });
  clocks.push(instance);
  return { instance, onChange };
}

afterEach(() => { for (const instance of clocks.splice(0)) instance.stop(); });

describe("concurrent turns and engine limit holds", () => {
  it("keeps a new refusal when an already-running turn finishes successfully", () => {
    const { instance, onChange } = clock();
    instance.noteRuntimeEvent("claude", started("older"));
    instance.noteRuntimeEvent("claude", started("limited"));
    instance.noteRuntimeEvent(undefined, {
      ...base, threadId: "limited", type: "runtime.error", message: "usage limit", limit: "engine", limitResetsAt: RESET,
    } as RuntimeEvent);
    instance.noteRuntimeEvent(undefined, { ...completed("limited"), ok: false } as RuntimeEvent);
    onChange.mockClear();
    instance.noteRuntimeEvent(undefined, completed("older"));
    expect(instance.blockedUntil("claude")).toBe(RESET);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["guessed", "repeated reset", "unnamed after reset"] as const)("keeps a %s hold when an earlier turn completes", (kind) => {
    const { instance } = clock();
    if (kind !== "guessed") instance.noteRefusal("claude", RESET);
    instance.noteRuntimeEvent("claude", started("older"));
    if (kind === "repeated reset") instance.noteRefusal("claude", RESET);
    else instance.noteLimit("claude", undefined);
    instance.noteRuntimeEvent(undefined, completed("older"));
    expect(instance.blockedUntil("claude")).toBe(kind === "guessed" ? NOW + UNNAMED_LIMIT_MS : RESET);
  });

  it("lets a turn started after the refusal clear the hold even in the same millisecond", () => {
    const { instance } = clock();
    instance.noteRefusal("claude", RESET);
    instance.noteRuntimeEvent("claude", started("later"));
    instance.noteRuntimeEvent(undefined, completed("later"));
    expect(instance.blockedUntil("claude")).toBeNull();
  });

  it("lets a later turn on the same thread clear the hold", () => {
    const { instance } = clock();
    instance.noteRuntimeEvent("claude", started("thread"));
    instance.noteRefusal("claude", RESET);
    instance.noteRuntimeEvent(undefined, completed("thread"));
    expect(instance.blockedUntil("claude")).toBe(RESET);
    instance.noteRuntimeEvent("claude", started("thread"));
    instance.noteRuntimeEvent(undefined, completed("thread"));
    expect(instance.blockedUntil("claude")).toBeNull();
  });

  it("does not disqualify a successful turn when another engine refuses", () => {
    const { instance } = clock();
    instance.noteRefusal("codex", RESET);
    instance.noteRuntimeEvent("codex", started("working"));
    instance.noteRefusal("claude", RESET);
    instance.noteRuntimeEvent(undefined, completed("working"));
    expect(instance.blockedUntil("codex")).toBeNull();
    expect(instance.blockedUntil("claude")).toBe(RESET);
  });
});
