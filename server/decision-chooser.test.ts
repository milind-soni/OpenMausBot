// The chooser (issue #1630) at the unit level. Two layers are pinned:
// the request contract ported from the validated upstream example —
// every bound, the strict ID grammar, the mandatory escapes — and the
// runtime decision table: act at or above threshold, forward with a
// report on every other outcome, and never let a failure break the run.
import { describe, expect, it, vi } from "vitest";

import {
  MAX_CHOICE_BYTES,
  REQUEST_SCHEMA,
  buildChoice,
  createDecisionChooser,
  decisionPayload,
  validateRequest,
  windowStateElements,
  type DecisionReport,
} from "./decision-chooser.ts";
import type { DecisionModelClient } from "./decision-model.ts";

function region(id: string, text = "link") {
  return { id, kind: "text", bounds: { x: 10, y: 20, width: 80, height: 24 }, text, label: "link", confidence: 0.95, interactive: true };
}

function candidate(id: string, description = "d") {
  return { id, description };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    schema: REQUEST_SCHEMA,
    goal: "Book the flight",
    capture_id: "cap-1",
    regions: [region("r0")],
    history: [],
    candidates: [candidate("click:0"), candidate("reobserve"), candidate("abstain")],
    ...overrides,
  };
}

describe("validateRequest", () => {
  it("accepts the shape the builder produces", () => {
    expect(() => validateRequest(validRequest())).not.toThrow();
  });

  it("enforces the contract bounds", () => {
    expect(() => validateRequest(validRequest({ candidates: [candidate("a")] }))).toThrow(/between 2 and 32/);
    expect(() => validateRequest(validRequest({ candidates: Array.from({ length: 33 }, (_, i) => candidate(`c${i}`)) }))).toThrow(/between 2 and 32/);
    expect(() => validateRequest(validRequest({ regions: Array.from({ length: 101 }, (_, i) => region(`r${i}`)) }))).toThrow(/at most 100/);
    expect(() =>
      validateRequest(validRequest({ history: Array.from({ length: 17 }, () => ({ outcome: "acted" })) })),
    ).toThrow(/at most 16/);
  });

  it("requires the escapes and rejects unknown ids or fields", () => {
    expect(() => validateRequest(validRequest({ candidates: [candidate("click:0"), candidate("only")] }))).toThrow(/reobserve and abstain/);
    expect(() => validateRequest(validRequest({ candidates: [candidate("bad id!"), candidate("reobserve"), candidate("abstain")] }))).toThrow(/unsupported characters/);
    expect(() => validateRequest(validRequest({ extra: true }))).toThrow(/cua.jev_choice_request_v1/);
    expect(() => validateRequest(validRequest({ schema: "other" }))).toThrow(/cua.jev_choice_request_v1/);
  });
});

describe("windowStateElements", () => {
  it("finds elements in every known snapshot spelling", () => {
    const elements = [{ role: "button", name: "Go" }];
    expect(windowStateElements({ elements })).toEqual(elements);
    expect(windowStateElements({ accessibility_tree: elements })).toEqual(elements);
    expect(windowStateElements({ ax_tree: { elements } })).toEqual(elements);
    expect(windowStateElements({ tree: { elements } })).toEqual(elements);
  });

  it("yields nothing for an unknown shape, forwarding the screenshot", () => {
    expect(windowStateElements({ pixels: "…" })).toEqual([]);
    expect(windowStateElements({})).toEqual([]);
  });
});

describe("buildChoice", () => {
  const button = (name: string, x = 10) => ({ role: "button", name, bounds: { x, y: 20, width: 80, height: 24 } });

  it("builds one click candidate per activatable element plus the escapes", () => {
    const built = buildChoice({ goal: "g", captureId: "cap-1", elements: [button("OK"), { role: "heading", name: "Title", bounds: { x: 1, y: 1, width: 10, height: 10 } }], history: [] });
    expect(built).not.toBeNull();
    expect(built!.request.candidates.map((c) => c.id)).toEqual(["click:0", "reobserve", "abstain"]);
    expect(built!.clicks.get("click:0")).toMatchObject({ x: 50, y: 32 });
    expect(built!.request.regions).toHaveLength(1);
  });

  it("deduplicates identical controls and caps the candidate list", () => {
    const duplicates = [button("Send"), button("Send"), { ...button("Send"), clickable: true }];
    expect(buildChoice({ goal: "g", captureId: "c", elements: duplicates, history: [] })!.request.candidates).toHaveLength(3);
    const many = Array.from({ length: 60 }, (_, i) => button(`Button ${i}`, i * 5));
    const built = buildChoice({ goal: "g", captureId: "c", elements: many, history: [] });
    expect(built!.request.candidates).toHaveLength(32);
    expect(built!.request.candidates.filter((c) => c.id.startsWith("click:"))).toHaveLength(30);
    expect(built!.request.regions).toHaveLength(30);
  });

  it("returns null when nothing is activatable", () => {
    expect(buildChoice({ goal: "g", captureId: "c", elements: [{ role: "text", name: "hi", bounds: { x: 1, y: 1, width: 5, height: 5 } }], history: [] })).toBeNull();
  });

  it("skips off-screen elements instead of failing the whole request", () => {
    // A window on a monitor left of or above the primary reports negative
    // global coordinates; the wire contract forbids them, so the builder
    // must drop such elements rather than poison the request.
    const offscreen = { role: "button", name: "Hidden", bounds: { x: -10, y: 20, width: 80, height: 24 } };
    expect(buildChoice({ goal: "g", captureId: "c", elements: [offscreen], history: [] })).toBeNull();
    const mixed = buildChoice({ goal: "g", captureId: "c", elements: [offscreen, button("OK")], history: [] });
    expect(mixed!.request.candidates.map((candidate) => candidate.id)).toEqual(["click:0", "reobserve", "abstain"]);
    expect(mixed!.request.regions).toHaveLength(1);
    expect(mixed!.request.regions[0]).toMatchObject({ bounds: { x: 10, y: 20, width: 80, height: 24 } });
  });
});

describe("decisionPayload", () => {
  it("unwraps MCP structured, JSON and bare-driver shapes", () => {
    const bare = { capture_id: "c", elements: [] };
    expect(decisionPayload({ structuredContent: bare })).toEqual(bare);
    expect(decisionPayload({ content: [{ type: "json", json: bare }] })).toEqual(bare);
    expect(decisionPayload({ content: [{ type: "text", text: JSON.stringify(bare) }] })).toEqual(bare);
    expect(decisionPayload(bare)).toEqual(bare);
    expect(decisionPayload({ unrelated: true })).toBeNull();
  });
});

describe("createDecisionChooser", () => {
  const snapshot = {
    capture_id: "cap-1",
    pid: 4242,
    window_id: 7,
    elements: [
      { role: "button", name: "Book flight", bounds: { x: 100, y: 200, width: 120, height: 40 } },
      { role: "link", name: "Cancel", bounds: { x: 100, y: 300, width: 90, height: 24 } },
    ],
  };

  function harness(options: {
    decide?: (criteria: Record<string, string>) => { selectedId: string; confidence: number; probabilities: Record<string, number>; model?: string };
    threshold?: number;
    goal?: string | null;
    windowState?: unknown;
    click?: unknown;
    isHeld?: () => Promise<boolean>;
  }) {
    const reports: DecisionReport[] = [];
    const driverCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const decisions: Array<{ state: unknown; criteria: Record<string, string> }> = [];
    const client: DecisionModelClient = {
      decide: async (request) => {
        decisions.push({ state: request.state, criteria: request.criteria });
        const answer = options.decide?.(request.criteria) ?? { selectedId: "click:0", confidence: 0.95, probabilities: {} };
        return { selectedId: answer.selectedId, confidence: answer.confidence, probabilities: answer.probabilities ?? {}, ...(answer.model ? { model: answer.model } : {}) };
      },
    };
    const chooser = createDecisionChooser({
      client,
      threshold: options.threshold ?? 0.9,
      goal: async () => (options.goal === undefined ? "Book the flight to Tokyo" : options.goal),
      report: (report) => reports.push(report),
      callDriver: async (name, args) => {
        driverCalls.push({ name, args });
        if (name === "get_window_state") return options.windowState ?? { structuredContent: snapshot };
        return options.click ?? { ok: true };
      },
      isHeld: options.isHeld ?? (async () => false),
    });
    return { chooser, reports, driverCalls, decisions };
  }

  const screenshot = { id: 1, name: "screenshot", arguments: {} };

  it("acts above threshold: one click, an honest answer text, a report", async () => {
    const h = harness({ decide: () => ({ selectedId: "click:0", confidence: 0.95, probabilities: { click: 0.95 } }) });
    const decision = await h.chooser.intercept(screenshot);
    expect(decision.handled).toBe(true);
    expect(decision.text).toContain("confidence 95%");
    expect(decision.text).toContain("No screenshot was taken");
    expect(h.driverCalls.map((c) => c.name)).toEqual(["get_window_state", "click"]);
    expect(h.driverCalls[1]!.args).toMatchObject({ x: 160, y: 220, capture_id: "cap-1", pid: 4242, window_id: 7 });
    expect(h.reports).toEqual([{ outcome: "acted", selectedId: "click:0", confidence: 0.95 }]);
  });

  it("clears the decision timeout once a fast decision lands", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({});
      const decision = await h.chooser.intercept(screenshot);
      expect(decision.handled).toBe(true);
      // the 12s race timer must not outlive the decision that beat it
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(13_000);
      expect(h.reports).toEqual([{ outcome: "acted", selectedId: "click:0", confidence: 0.95 }]);
      expect(h.driverCalls.map((call) => call.name)).toEqual(["get_window_state", "click"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the underlying decision when the chooser timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const reports: DecisionReport[] = [];
      const driverCalls: string[] = [];
      let aborted = false;
      const chooser = createDecisionChooser({
        // A decision that never settles: the abort signal is the only
        // observable proof the chooser cancelled the in-flight request
        // instead of leaking it past its own 12s budget.
        client: {
          decide: (request) =>
            new Promise(() => {
              request.signal?.addEventListener("abort", () => (aborted = true));
            }),
        },
        threshold: 0.9,
        goal: async () => "Book the flight",
        report: (report) => reports.push(report),
        callDriver: async (name) => {
          driverCalls.push(name);
          if (name === "get_window_state") return { structuredContent: snapshot };
          return { ok: true };
        },
        isHeld: async () => false,
      });
      const pending = chooser.intercept(screenshot);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await pending).toEqual({ handled: false });
      expect(aborted).toBe(true);
      expect(reports[0]).toMatchObject({ outcome: "error", detail: expect.stringContaining("decision timed out") });
      expect(driverCalls).toEqual(["get_window_state"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries its own history into the next request", async () => {
    const h = harness({});
    await h.chooser.intercept(screenshot);
    expect(h.decisions).toHaveLength(1);
    await h.chooser.intercept({ ...screenshot, id: 2 });
    expect(h.decisions).toHaveLength(2);
    const second = h.decisions[1]!.state as { observation: string };
    const observation = JSON.parse(second.observation) as { history: Array<{ selected_id?: string; outcome?: string }> };
    expect(observation.history).toEqual([{ selected_id: "click:0", outcome: "acted" }]);
  });

  it("forwards with a report below threshold, on abstain and on reobserve", async () => {
    const below = harness({ decide: () => ({ selectedId: "click:0", confidence: 0.7, probabilities: {} }) });
    expect(await below.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(below.driverCalls.map((c) => c.name)).toEqual(["get_window_state"]);
    expect(below.reports).toEqual([{ outcome: "below-threshold", selectedId: "click:0", confidence: 0.7 }]);

    const abstain = harness({ decide: () => ({ selectedId: "abstain", confidence: 0.8, probabilities: {}, model: "jev-latest" }) });
    expect(await abstain.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(abstain.reports).toEqual([{ outcome: "abstained", confidence: 0.8, model: "jev-latest" }]);

    const reobserve = harness({ decide: () => ({ selectedId: "reobserve", confidence: 0.9, probabilities: {} }) });
    expect(await reobserve.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(reobserve.reports).toEqual([{ outcome: "reobserve", confidence: 0.9 }]);
  });

  it("forwards silently when there is no goal, no snapshot or nothing to click", async () => {
    const noGoal = harness({ goal: null });
    expect(await noGoal.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(noGoal.driverCalls).toEqual([]);
    expect(noGoal.reports).toEqual([]);

    const noCapture = harness({ windowState: { structuredContent: { elements: snapshot.elements } } });
    expect(await noCapture.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(noCapture.reports).toEqual([]);

    const nothingClickable = harness({ windowState: { structuredContent: { capture_id: "cap-1", elements: [{ role: "text", name: "label" }] } } });
    expect(await nothingClickable.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(nothingClickable.reports).toEqual([]);
  });

  it("ignores non-screenshot calls entirely", async () => {
    const h = harness({});
    expect(await h.chooser.intercept({ id: 2, name: "type", arguments: { text: "hi" } })).toEqual({ handled: false });
    expect(h.driverCalls).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("reports errors and disables itself after repeated failures", async () => {
    const h = harness({ decide: () => ({ selectedId: "click:99", confidence: 0.99, probabilities: {} }) });
    for (let i = 0; i < 3; i += 1) {
      expect(await h.chooser.intercept(screenshot)).toEqual({ handled: false });
    }
    expect(h.reports).toHaveLength(3);
    expect(h.reports[2]).toMatchObject({ outcome: "error", detail: expect.stringContaining("chooser disabled") });
    // Disabled: further calls forward without a report or a driver call.
    h.driverCalls.length = 0;
    h.reports.length = 0;
    expect(await h.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(h.driverCalls).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("counts a failing driver (rejected window state) toward the breaker", async () => {
    const reports: DecisionReport[] = [];
    const chooser = createDecisionChooser({
      client: { decide: async () => ({ selectedId: "click:0", confidence: 0.99, probabilities: {} }) },
      threshold: 0.9,
      goal: async () => "Book the flight",
      report: (report) => reports.push(report),
      callDriver: async (name) => {
        if (name === "get_window_state") throw new Error("driver call failed");
        return { ok: true };
      },
      isHeld: async () => false,
    });
    for (let i = 0; i < 3; i += 1) await chooser.intercept({ id: i, name: "screenshot", arguments: {} });
    expect(reports).toHaveLength(3);
    expect(reports.map((r) => r.outcome)).toEqual(["error", "error", "error"]);
    expect(reports[2]).toMatchObject({ detail: expect.stringContaining("chooser disabled") });
  });

  it("reports a failed click as an error and forwards", async () => {
    const h = harness({ click: { isError: true } });
    expect(await h.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(h.reports[0]).toMatchObject({ outcome: "error", detail: expect.stringContaining("not confirmed") });
  });

  it("lets a human hold acquired mid-decision win: no click, a superseded report", async () => {
    let release!: () => void;
    const decided = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const reports: DecisionReport[] = [];
    const driverCalls: string[] = [];
    const chooser = createDecisionChooser({
      client: {
        decide: async () => {
          await decided;
          return { selectedId: "click:0", confidence: 0.99, probabilities: {} };
        },
      },
      threshold: 0.9,
      goal: async () => "Book the flight",
      report: (report) => reports.push(report),
      callDriver: async (name) => {
        driverCalls.push(name);
        if (name === "get_window_state") return { structuredContent: snapshot };
        return { ok: true };
      },
      isHeld: async () => held,
    });
    const pending = chooser.intercept(screenshot);
    // The human takes control while the decision is still in flight.
    held = true;
    release();
    expect(await pending).toEqual({ handled: false });
    expect(driverCalls).toEqual(["get_window_state"]);
    expect(reports).toEqual([{ outcome: "superseded", selectedId: "click:0", confidence: 0.99 }]);
  });

  it("treats a failed ownership check as a no-click error", async () => {
    const h = harness({ isHeld: async () => { throw new Error("control endpoint unreachable"); } });
    expect(await h.chooser.intercept(screenshot)).toEqual({ handled: false });
    expect(h.driverCalls.map((call) => call.name)).toEqual(["get_window_state"]);
    expect(h.reports[0]).toMatchObject({ outcome: "error", detail: expect.stringContaining("ownership") });
  });
});

describe("wire cap", () => {
  it("exports the 64 KiB cap the request is checked against", () => {
    expect(MAX_CHOICE_BYTES).toBe(65_536);
  });
});
