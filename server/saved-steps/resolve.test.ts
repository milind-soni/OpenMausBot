import { beforeEach, describe, expect, it } from "vitest";
import { completeWindowState, windowState } from "../testing/saved-steps-fixtures.ts";
import type { WireElement } from "./driver-wire.ts";
import type { RecipeStep } from "./rules.ts";
import { matchApp, matchElement, matchWindow, POLL_MS, resolveStep, resolveStepSoon, RETRY_MS, type CallOutcome, type ComputerCaller, type Patience } from "./resolve.ts";

const TEXTEDIT = { bundleId: "com.apple.TextEdit", name: "TextEdit" };
const DOCUMENT = { role: "AXTextArea", label: "Document", path: ["AXScrollArea:"] };
const SAVE = { role: "AXButton", label: "Save", path: [] };
const CLICK_DOCUMENT: RecipeStep = { tool: "click", args: {}, app: TEXTEDIT, window: { title: "Untitled" }, element: DOCUMENT };
const CLICK_SAVE: RecipeStep = { ...CLICK_DOCUMENT, element: SAVE };

const TEXTEDIT_APP = { pid: 4242, name: "TextEdit", bundle_id: "com.apple.TextEdit", running: true };
const NOTES_INSTALLED = { pid: 0, name: "Notes", bundle_id: "com.apple.Notes", running: false };
const UNTITLED = { window_id: 7, pid: 4242, title: "Untitled", app_name: "TextEdit" };
const signal = new AbortController().signal;

const ok = (structured: object): CallOutcome => ({ ok: true, structured: structured as Record<string, unknown> });
const apps = (...list: object[]) => ok({ apps: list });
const windows = (...list: object[]) => ok({ windows: list });

const ELEMENTS: WireElement[] = windowState(2).elements ?? [];
const state = (elements: WireElement[] = ELEMENTS, extra: object = {}) => ({ ...completeWindowState({ ...windowState(2), elements }), ...extra });
const renamed = state(ELEMENTS.map((element) => (element.label === "Document" ? { ...element, label: "Body" } : element)));
const untokened = state(ELEMENTS.map(({ element_token: _token, ...element }) => element));
const SECOND_SAVE: WireElement = { element_index: 4, element_token: "s2-e4", role: "AXButton", label: "Save", parent_index: 0, depth: 1 };

type Lookup = "list_apps" | "list_windows" | "get_window_state";
let calls: [string, Record<string, unknown>][] = [];
beforeEach(() => {
  calls = [];
});

function caller(windowStateAnswer: object = state(), answers: Partial<Record<Lookup, CallOutcome>> = {}): ComputerCaller {
  const replies: Record<string, CallOutcome> = {
    list_apps: apps(TEXTEDIT_APP, NOTES_INSTALLED), list_windows: windows(UNTITLED), get_window_state: ok(windowStateAnswer), ...answers,
  };
  return {
    async call(tool, args) {
      calls.push([tool, args]);
      const reply = replies[tool];
      if (!reply) throw new Error(`unexpected ${tool}`);
      return reply;
    },
  };
}

const LOOKUPS: [string, Record<string, unknown>][] = [
  ["list_apps", {}], ["list_windows", { pid: 4242, on_screen_only: false }], ["get_window_state", { pid: 4242, window_id: 7, include_screenshot: false }],
];
const tools = () => calls.map(([tool]) => tool);

describe("resolveStep", () => {
  it("resolves an element step afresh, without a screenshot", async () => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(), signal)).toEqual({ ok: true, args: { pid: 4242, window_id: 7, element_token: "s2-e2" } });
    expect(calls.at(-1)).toStrictEqual(["get_window_state", { pid: 4242, window_id: 7, include_screenshot: false }]);
    expect(calls).toStrictEqual(LOOKUPS);
  });

  it("addresses by index when the snapshot has no tokens", async () => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(untokened), signal)).toStrictEqual({ ok: true, args: { pid: 4242, window_id: 7, element_index: 2 } });
  });

  it("keeps the saved arguments beside the fresh target", async () => {
    const step: RecipeStep = { ...CLICK_DOCUMENT, tool: "set_value", args: { value: "hello world" } };
    expect(await resolveStep(step, caller(completeWindowState(windowState(3))), signal))
      .toEqual({ ok: true, args: { value: "hello world", pid: 4242, window_id: 7, element_token: "s3-e2" } });
  });

  describe("typing into a field", () => {
    const TYPE: RecipeStep = { ...CLICK_DOCUMENT, tool: "set_value", args: { value: "hello world" } };
    const holding = (document: string) => caller(completeWindowState(windowState(3), document));

    it.each(["", "hello world"])("types into a field that holds %j: empty, or already what it types", async (document) => {
      expect(await resolveStep(TYPE, holding(document), signal)).toEqual({ ok: true, args: { value: "hello world", pid: 4242, window_id: 7, element_token: "s3-e2" } });
    });

    it("never replaces someone's text, and does not name it", async () => {
      const out = await resolveStep(TYPE, holding("Dear Sam, the figures are attached"), signal);
      expect(out).toEqual({ ok: false, error: '"Document" (AXTextArea) in Untitled already holds other text' });
      expect(JSON.stringify(out)).not.toContain("Sam");
    });

    it("never types into a field whose text the driver did not report", async () => {
      const tree = state();
      const unread = { ...tree, elements: (tree.elements as Record<string, unknown>[]).map(({ value: _value, ...element }) => element) };
      expect(await resolveStep(TYPE, caller(unread), signal)).toEqual({ ok: false, error: 'could not read what "Document" (AXTextArea) in Untitled holds' });
    });

    it("chooses in a pop-up whatever it shows now", async () => {
      const POPUP: WireElement = { element_index: 4, element_token: "s2-e4", role: "AXPopUpButton", label: "Size", parent_index: 0, depth: 1 };
      const choose: RecipeStep = { tool: "set_value", args: { value: "Large" }, app: TEXTEDIT, window: { title: "Untitled" }, element: { role: "AXPopUpButton", label: "Size", path: [] } };
      const tree = state([...ELEMENTS, { ...POPUP, value: "Small" } as WireElement]);
      expect(await resolveStep(choose, caller(tree), signal)).toEqual({ ok: true, args: { value: "Large", pid: 4242, window_id: 7, element_token: "s2-e4" } });
    });
  });

  it("refuses an answer that does not say it is complete", async () => {
    for (const answer of [windowState(2), state(ELEMENTS, { elements_complete: undefined }), state(ELEMENTS, { elements_complete: null })]) {
      expect(await resolveStep(CLICK_DOCUMENT, caller(answer), signal)).toEqual({ ok: false, error: "only part of Untitled could be read" });
    }
  });

  it.each<[string, object]>([
    ["marked truncated", { truncated: true }],
    ["marked incomplete", { elements_complete: false }],
    ["given a truncation reason", { truncation_reason: "max_elements" }],
    ["counting more elements than it returned", { element_count: 5 }],
    ["counting more in the whole tree", { total_element_count: 900 }],
    ["counting more returned than it sent", { returned_element_count: 5 }],
    ["counting more after filtering", { filtered_element_count: 5 }],
    ["with an unreadable count", { element_count: "4" }],
  ])("refuses a tree the driver cut short: %s", async (_case, extra) => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(ELEMENTS, extra)), signal)).toEqual({ ok: false, error: "only part of Untitled could be read" });
  });

  it.each<[string, object]>([
    ["marked degraded", state(ELEMENTS, { degraded: true })],
    ["with a degraded reason", state(ELEMENTS, { degraded_reason: "AX messaging timed out" })],
    ["degraded with an empty tree", state([], { degraded: true, degraded_reason: "AX tree unavailable", elements_complete: false })],
  ])("refuses a degraded tree: %s", async (_case, answer) => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(answer), signal)).toEqual({ ok: false, error: "Untitled could not be read reliably" });
  });

  it("accepts a tree whose counts match what was returned", async () => {
    const whole = state(ELEMENTS, { filtered_element_count: 4, truncated: false, degraded: false, degraded_reason: null, truncation_reason: null });
    expect(await resolveStep(CLICK_DOCUMENT, caller(whole), signal)).toEqual({ ok: true, args: { pid: 4242, window_id: 7, element_token: "s2-e2" } });
  });

  it.each<[string, object]>([
    ["another app", { pid: 1 }],
    ["another window", { window_id: 8 }],
    ["no app", { pid: undefined }],
    ["no window", { window_id: undefined }],
  ])("refuses an answer that describes %s", async (_case, extra) => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(ELEMENTS, extra)), signal)).toEqual({ ok: false, error: "the computer answered for a different window" });
  });

  it("fails a renamed element with words a person can read", async () => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(renamed), signal)).toEqual({ ok: false, error: 'no "Document" (AXTextArea) in Untitled', missing: true });
  });

  it("fails on two elements with the same role, label and path", async () => {
    expect(await resolveStep(CLICK_SAVE, caller(state([...ELEMENTS, SECOND_SAVE])), signal))
      .toEqual({ ok: false, error: 'more than one "Save" (AXButton) in Untitled' });
  });

  it.each<[string, CallOutcome]>([
    ["the only window was renamed", windows({ ...UNTITLED, window_id: 9, title: "Untitled 2" })],
    ["two windows are open and none has the saved title", windows({ ...UNTITLED, window_id: 8, title: "A" }, { ...UNTITLED, window_id: 9, title: "B" })],
    ["the app has no window", windows()],
    ["only another app has a window with the saved title", windows({ ...UNTITLED, pid: 1 })],
  ])("fails without looking inside when %s", async (_case, listed) => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(), { list_windows: listed }), signal)).toEqual({ ok: false, error: 'no window titled "Untitled"', missing: true });
    expect(tools()).toEqual(["list_apps", "list_windows"]);
  });

  it("fails without looking inside when two windows have the saved title", async () => {
    const twins = windows(UNTITLED, { ...UNTITLED, window_id: 8 });
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(), { list_windows: twins }), signal)).toEqual({ ok: false, error: 'more than one window titled "Untitled"' });
    expect(tools()).toEqual(["list_apps", "list_windows"]);
  });

  it.each<[string, CallOutcome]>([
    ["the app has quit", apps(NOTES_INSTALLED)],
    ["list_apps lists the app as not running", apps({ ...TEXTEDIT_APP, running: false })],
    ["list_apps lists the app without a process", apps({ ...TEXTEDIT_APP, pid: 0 })],
  ])("fails when %s", async (_case, listed) => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(), { list_apps: listed }), signal)).toEqual({ ok: false, error: "TextEdit is not running", missing: true });
    expect(tools()).toEqual(["list_apps"]);
  });

  it("fails when two copies of the app are running", async () => {
    const twice = apps(TEXTEDIT_APP, { ...TEXTEDIT_APP, pid: 4343 });
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(), { list_apps: twice }), signal)).toEqual({ ok: false, error: "more than one TextEdit app is running" });
  });

  it.each<[Lookup, number]>([["list_apps", 1], ["list_windows", 2], ["get_window_state", 3]])("passes a %s failure through", async (tool, made) => {
    expect(await resolveStep(CLICK_DOCUMENT, caller(state(), { [tool]: { ok: false, error: "boom" } }), signal)).toEqual({ ok: false, error: "boom" });
    expect(calls).toStrictEqual(LOOKUPS.slice(0, made));
  });

  it("needs no lookups for launch_app", async () => {
    const step: RecipeStep = { tool: "launch_app", args: { name: "TextEdit" } };
    expect(await resolveStep(step, caller(), signal)).toEqual({ ok: true, args: { name: "TextEdit" } });
    expect(calls).toEqual([]);
  });

  it("targets bring_to_front and an app's hotkey at a fresh pid and window", async () => {
    const front: RecipeStep = { tool: "bring_to_front", args: {}, app: TEXTEDIT, window: { title: "Untitled" } };
    expect(await resolveStep(front, caller(), signal)).toEqual({ ok: true, args: { pid: 4242, window_id: 7 } });
    expect(calls).toStrictEqual(LOOKUPS.slice(0, 2));
    calls = [];
    const save: RecipeStep = { tool: "hotkey", args: { keys: ["cmd", "s"] }, app: TEXTEDIT, window: { title: "Untitled" } };
    expect(await resolveStep(save, caller(), signal)).toStrictEqual({ ok: true, args: { keys: ["cmd", "s"], pid: 4242, window_id: 7 } });
    expect(calls).toStrictEqual(LOOKUPS.slice(0, 2));
  });

  it("refuses a key step whose window was renamed rather than send it to another window", async () => {
    const close: RecipeStep = { tool: "hotkey", args: { keys: ["cmd", "w"] }, app: TEXTEDIT, window: { title: "Invoice.pdf" } };
    expect(await resolveStep(close, caller(), signal)).toEqual({ ok: false, error: 'no window titled "Invoice.pdf"', missing: true });
  });

  it("refuses a key step saved without its window", async () => {
    for (const tool of ["hotkey", "press_key"] as const) {
      expect(await resolveStep({ tool, args: {}, app: TEXTEDIT }, caller(), signal)).toEqual({ ok: false, error: "the saved step does not name its window" });
    }
    expect(calls).toEqual([]);
  });

  it.each<[string, RecipeStep]>([
    ["a key press", { tool: "press_key", args: { key: "return" } }],
    ["a hotkey with a window", { tool: "hotkey", args: { keys: ["cmd", "s"] }, window: { title: "Untitled" } }],
    ["an element step", { tool: "click", args: {}, window: { title: "Untitled" }, element: DOCUMENT }],
  ])("refuses %s saved without its app", async (_case, step) => {
    expect(await resolveStep(step, caller(), signal)).toEqual({ ok: false, error: "the saved step does not name its app" });
    expect(calls).toEqual([]);
  });

  it("refuses an element step saved without its window", async () => {
    const { window: _window, ...noWindow } = CLICK_DOCUMENT;
    expect(await resolveStep(noWindow, caller(), signal)).toEqual({ ok: false, error: "the saved step does not name its window" });
    expect(calls).toEqual([]);
  });
});

describe("matchApp", () => {
  it("prefers bundle id over name", () => expect(matchApp([{ pid: 1, name: "Notes", bundle_id: "a" }, { pid: 2, name: "Notes", bundle_id: "b" }], { bundleId: "b", name: "Notes" })).toEqual({ ok: true, value: 2 }));

  it("never falls back to the name when a bundle id is saved", () =>
    expect(matchApp([{ pid: 1, name: "Notes", bundle_id: "a" }], { bundleId: "b", name: "Notes" })).toEqual({ ok: false, reason: "none" }));

  it("matches the exact name when no bundle id is saved", () =>
    expect(matchApp([{ pid: 1, name: "notes" }, { pid: 2, name: "Notes" }], { name: "Notes" })).toEqual({ ok: true, value: 2 }));

  it("never picks an app that is not running", () => {
    expect(matchApp([{ pid: 0, name: "TextEdit", running: false }], { name: "TextEdit" })).toEqual({ ok: false, reason: "none" });
    expect(matchApp([{ pid: 4242, name: "TextEdit", running: false }], { name: "TextEdit" })).toEqual({ ok: false, reason: "none" });
  });

  it("refuses an identity with neither bundle id nor name", () => {
    expect(matchApp([{ pid: 1, name: "Notes" }], {})).toEqual({ ok: false, reason: "none" });
    expect(matchApp([{ pid: 1, name: "" }], { bundleId: "", name: "" })).toEqual({ ok: false, reason: "none" });
  });

  it("calls two running copies ambiguous", () =>
    expect(matchApp([{ pid: 1, name: "Notes" }, { pid: 2, name: "Notes" }], { name: "Notes" })).toEqual({ ok: false, reason: "ambiguous" }));

  it.each<[string, unknown]>([
    ["not a list", { pid: 1, name: "Notes" }],
    ["a string pid", [{ pid: "1", name: "Notes" }]],
    ["one unreadable entry beside a match", [{ pid: 1, name: "Notes" }, { pid: 2, name: "Notes", bundle_id: 7 }]],
  ])("reads nothing from %s", (_case, list) => expect(matchApp(list, { name: "Notes" })).toEqual({ ok: false, reason: "none" }));
});

describe("matchWindow", () => {
  it("refuses the only window when its title changed", () =>
    expect(matchWindow([{ window_id: 9, pid: 4242, title: "Untitled 2" }], 4242, { title: "Untitled" })).toEqual({ ok: false, reason: "none" }));

  it("refuses two windows when none has the title", () =>
    expect(matchWindow([{ window_id: 8, pid: 4242, title: "A" }, { window_id: 9, pid: 4242, title: "B" }], 4242, { title: "Untitled" })).toEqual({ ok: false, reason: "none" }));

  it("takes the one window with the exact title among several", () =>
    expect(matchWindow([{ window_id: 8, pid: 4242, title: "untitled" }, { window_id: 9, pid: 4242, title: "Untitled" }], 4242, { title: "Untitled" })).toEqual({ ok: true, value: 9 }));

  it("refuses two windows with the saved title", () =>
    expect(matchWindow([{ window_id: 8, pid: 4242, title: "Untitled" }, { window_id: 9, pid: 4242, title: "Untitled" }], 4242, { title: "Untitled" })).toEqual({ ok: false, reason: "ambiguous" }));

  it("ignores other apps' windows", () =>
    expect(matchWindow([{ window_id: 9, pid: 1, title: "Untitled" }], 4242, { title: "Untitled" })).toEqual({ ok: false, reason: "none" }));

  it.each<[string, unknown]>([
    ["an unreadable entry", [{ window_id: 9, pid: 4242, title: "Untitled" }, { window_id: 8, title: "B" }]],
    ["a repeated window id", [{ window_id: 9, pid: 4242, title: "Untitled" }, { window_id: 9, pid: 4242, title: "B" }]],
  ])("reads nothing from a list with %s", (_case, list) => expect(matchWindow(list, 4242, { title: "Untitled" })).toEqual({ ok: false, reason: "none" }));
});

describe("matchElement", () => {
  it("finds the element with the same role, label and path", () => expect(matchElement(ELEMENTS, DOCUMENT)).toEqual({ ok: true, value: ELEMENTS[2] }));

  it("refuses duplicate labels on the same path", () => expect(matchElement([...ELEMENTS, SECOND_SAVE], SAVE)).toEqual({ ok: false, reason: "ambiguous" }));

  it("tells the same label apart by path and role", () => {
    const deeper: WireElement = { ...SECOND_SAVE, parent_index: 1, depth: 2 };
    expect(matchElement([...ELEMENTS, deeper], SAVE)).toEqual({ ok: true, value: ELEMENTS[3] });
    expect(matchElement([...ELEMENTS, deeper], { ...SAVE, path: ["AXScrollArea:"] })).toEqual({ ok: true, value: deeper });
    expect(matchElement(ELEMENTS, { ...SAVE, role: "AXStaticText" })).toEqual({ ok: false, reason: "none" });
  });

  it.each<[string, WireElement, typeof DOCUMENT]>([
    ["a missing parent", { ...SECOND_SAVE, parent_index: 99 }, SAVE],
    ["no parent below the root", { element_index: 5, role: "AXTextArea", label: "Document", depth: 2 }, DOCUMENT],
  ])("counts a look-alike whose ancestry cannot be read (%s) as a second match", (_case, lookAlike, identity) =>
    expect(matchElement([...ELEMENTS, lookAlike], identity)).toEqual({ ok: false, reason: "ambiguous" }));

  it.each<[string, unknown]>([
    ["not a list", undefined],
    ["one unreadable entry beside a match", [...ELEMENTS, { element_index: 5, role: "AXButton", label: 3, depth: 1 }]],
    ["a repeated element index", [...ELEMENTS, ELEMENTS[1]]],
  ])("reads nothing from %s", (_case, list) => expect(matchElement(list, DOCUMENT)).toEqual({ ok: false, reason: "none" }));
});

describe("resolveStepSoon", () => {
  let clock: number;
  let slept: number[];
  const patience: Patience = { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } };
  beforeEach(() => {
    clock = 0;
    slept = [];
  });

  function appearing(after: number, lookup: Lookup, early: CallOutcome): ComputerCaller {
    const real = caller();
    let seen = 0;
    return { async call(tool, args, callSignal) {
      calls.push([tool, args]);
      if (tool === lookup && seen++ < after) return early;
      return real.call(tool, args, callSignal);
    } };
  }

  it.each<[string, Lookup, CallOutcome]>([
    ["an app that is still starting", "list_apps", apps(NOTES_INSTALLED)],
    ["a window that is still opening", "list_windows", windows()],
    ["an element that is still being drawn", "get_window_state", ok(renamed)],
  ])("waits for %s", async (_case, lookup, early) => {
    expect(await resolveStepSoon(CLICK_DOCUMENT, appearing(2, lookup, early), signal, patience)).toEqual({ ok: true, args: { pid: 4242, window_id: 7, element_token: "s2-e2" } });
    expect(slept).toEqual([POLL_MS, POLL_MS]);
  });

  it("gives up once the wait is over", async () => {
    const quit = caller(state(), { list_apps: apps(NOTES_INSTALLED) });
    expect(await resolveStepSoon(CLICK_DOCUMENT, quit, signal, patience)).toEqual({ ok: false, error: "TextEdit is not running", missing: true });
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(RETRY_MS);
    expect(tools()).toHaveLength(RETRY_MS / POLL_MS + 1);
  });

  it.each<[string, Partial<Record<Lookup, CallOutcome>>, object]>([
    ["two apps match", { list_apps: apps(TEXTEDIT_APP, { ...TEXTEDIT_APP, pid: 4343 }) }, state()],
    ["two windows match", { list_windows: windows(UNTITLED, { ...UNTITLED, window_id: 8 }) }, state()],
    ["two elements match", {}, state([...ELEMENTS, { ...ELEMENTS[2]!, element_index: 4, element_token: "s2-e4" }])],
    ["the tree is cut", {}, state(ELEMENTS, { elements_complete: false })],
    ["a lookup fails", { list_apps: { ok: false, error: "the driver crashed" } }, state()],
  ])("never waits when %s", async (_case, answers, tree) => {
    expect((await resolveStepSoon(CLICK_DOCUMENT, caller(tree, answers), signal, patience)).ok).toBe(false);
    expect(slept).toEqual([]);
  });

  it("stops waiting when the replay is stopped", async () => {
    const controller = new AbortController();
    const stopping: Patience = { now: () => clock, sleep: async () => { controller.abort(); } };
    const quit = caller(state(), { list_apps: apps(NOTES_INSTALLED) });
    expect(await resolveStepSoon(CLICK_DOCUMENT, quit, controller.signal, stopping)).toMatchObject({ ok: false, missing: true });
    expect(tools()).toEqual(["list_apps", "list_apps"]);
  });

  it("waits in real time when given no clock", async () => {
    const started = Date.now();
    expect(await resolveStepSoon(CLICK_DOCUMENT, appearing(1, "list_apps", apps(NOTES_INSTALLED)), signal)).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(POLL_MS - 5);
  });
});
