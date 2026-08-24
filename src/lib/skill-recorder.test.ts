import { describe, expect, it } from "vitest";
import { appendNativeEvent, shortcutLabel, type RecordedSkillEvent } from "./skill-recorder";

const event = (patch: Partial<NativeSkillRecordingEvent>): NativeSkillRecordingEvent => ({
  type: "key", atMs: 100, app: "Notes", windowTitle: "Ideas", ...patch,
});

describe("skill recording events", () => {
  it("collapses a ⌘C key chord into the clipboard event so one keystroke is one step", () => {
    // The helper emits both a `key` chord and a `clipboard` event for ⌘C.
    const afterChord = appendNativeEvent([], event({ keycode: 8, meta: true }));
    expect(afterChord.events).toEqual([expect.objectContaining({ type: "shortcut", shortcut: "⌘C" })]);
    const afterClip = appendNativeEvent(afterChord.events, event({ type: "clipboard", atMs: 220, op: "copy" }));
    expect(afterClip.events).toEqual([expect.objectContaining({ type: "clipboard", op: "copy" })]);
    expect(afterClip.events).toHaveLength(1);
  });

  it("keeps a non-clipboard chord (⌥⌘C) as its own shortcut step", () => {
    const afterChord = appendNativeEvent([], event({ keycode: 8, meta: true, option: true }));
    const afterClip = appendNativeEvent(afterChord.events, event({ type: "clipboard", atMs: 220, op: "copy" }));
    expect(afterClip.events).toHaveLength(2);
    expect(afterClip.events[0]).toMatchObject({ type: "shortcut" });
    expect(afterClip.events[1]).toMatchObject({ type: "clipboard" });
  });

  it("stores a pre-aggregated typing burst as a keyCount, never characters", () => {
    const result = appendNativeEvent([], event({ type: "typing", keyCount: 7 }));
    expect(result.events).toEqual([expect.objectContaining({ type: "typing", keyCount: 7 })]);
    const json = JSON.stringify(result.events);
    expect(json).not.toContain("keycode");
    expect(json).not.toContain("A");
    expect(result.events[0]).not.toHaveProperty("shortcut");
  });

  it("folds consecutive typing bursts in the same context into one keyCount", () => {
    const first = appendNativeEvent([], event({ type: "typing", keyCount: 3 }));
    const second = appendNativeEvent(first.events, event({ type: "typing", atMs: 400, keyCount: 4 }));
    expect(second.events).toEqual([expect.objectContaining({ type: "typing", keyCount: 7 })]);
    expect(JSON.stringify(second.events)).not.toContain("keycode");
  });

  it("keeps modified keys as readable shortcuts", () => {
    const native = event({ keycode: 35, meta: true, shift: true });
    expect(shortcutLabel(native)).toBe("⇧⌘P");
    expect(appendNativeEvent([], native).events[0]).toMatchObject({ type: "shortcut", shortcut: "⇧⌘P" });
  });

  it("carries a click's element identity into the compiled event", () => {
    const native = event({
      type: "click", x: 10, y: 20, button: "left",
      role: "AXButton", name: "Submit", identifier: "submit-btn", ancestry: ["Window", "Toolbar"],
    });
    expect(appendNativeEvent([], native).events[0]).toMatchObject({
      type: "click", role: "AXButton", name: "Submit", identifier: "submit-btn", ancestry: ["Window", "Toolbar"],
    });
  });

  it("records a clipboard action with its op", () => {
    const result = appendNativeEvent([], event({ type: "clipboard", op: "copy" }));
    expect(result.events[0]).toMatchObject({ type: "clipboard", op: "copy" });
  });

  it("records a download with its filename and origins", () => {
    const native = event({ type: "download", filename: "invoice.pdf", whereFroms: ["https://acme.example/invoice.pdf"] });
    expect(appendNativeEvent([], native).events[0]).toMatchObject({
      type: "download", filename: "invoice.pdf", whereFroms: ["https://acme.example/invoice.pdf"],
    });
  });

  it("coalesces repeated scrolling in the same window", () => {
    const first = appendNativeEvent([], event({ type: "scroll", deltaY: -2 }));
    const second = appendNativeEvent(first.events, event({ type: "scroll", atMs: 600, deltaY: -7 }));
    expect(second.events).toHaveLength(1);
  });

  it("gives same-millisecond events distinct ids", () => {
    const first = appendNativeEvent([], event({ type: "click", atMs: 100 }));
    const second = appendNativeEvent(first.events, event({ type: "click", atMs: 100 }));
    expect(second.events[0]?.id).not.toBe(second.events[1]?.id);
  });

  it("caps the timeline at 600 events and keeps the first ones", () => {
    let events: RecordedSkillEvent[] = [];
    for (let i = 0; i < 650; i += 1) {
      events = appendNativeEvent(events, event({ type: "click", atMs: i })).events;
    }
    expect(events).toHaveLength(600);
    expect(events[0]?.atMs).toBe(0);
    expect(events.at(-1)?.atMs).toBe(599);

    // Once at the cap, a new event is refused rather than dropping the head.
    const atCap = appendNativeEvent(events, event({ type: "click", atMs: 999 }));
    expect(atCap.addedId).toBeNull();
    expect(atCap.events).toHaveLength(600);
    expect(atCap.events[0]?.atMs).toBe(0);
  });
});
