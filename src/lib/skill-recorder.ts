export type RecordedSkillEvent = {
  id: string;
  type: "app" | "click" | "scroll" | "shortcut" | "typing" | "clipboard" | "download";
  atMs: number;
  app?: string;
  windowTitle?: string;
  direction?: "up" | "down";
  shortcut?: string;
  screenshot?: string;
  keyCount?: number;
  role?: string;
  name?: string;
  identifier?: string;
  ancestry?: string[];
  op?: "copy" | "cut" | "paste";
  filename?: string;
  whereFroms?: string[];
};

export type AppendNativeEventResult = {
  events: RecordedSkillEvent[];
  addedId: string | null;
};

// Cap the timeline but preserve the START of a long demo: once we hold this
// many events we stop taking new ones rather than dropping the head.
const MAX_EVENTS = 600;

function commit(events: RecordedSkillEvent[], next: RecordedSkillEvent): AppendNativeEventResult {
  if (events.length >= MAX_EVENTS) return { events, addedId: null };
  return { events: [...events, next], addedId: next.id };
}

const MAC_KEYS = new Map<number, string>([
  [0, "A"], [1, "S"], [2, "D"], [3, "F"], [4, "H"], [5, "G"], [6, "Z"], [7, "X"], [8, "C"], [9, "V"],
  [11, "B"], [12, "Q"], [13, "W"], [14, "E"], [15, "R"], [16, "Y"], [17, "T"], [18, "1"], [19, "2"],
  [20, "3"], [21, "4"], [22, "6"], [23, "5"], [24, "="], [25, "9"], [26, "7"], [27, "-"], [28, "8"],
  [29, "0"], [30, "]"], [31, "O"], [32, "U"], [33, "["], [34, "I"], [35, "P"], [36, "Return"],
  [37, "L"], [38, "J"], [39, "'"], [40, "K"], [41, ";"], [42, "\\"], [43, ","], [44, "/"], [45, "N"],
  [46, "M"], [47, "."], [48, "Tab"], [49, "Space"], [50, "`"], [51, "Delete"], [53, "Escape"],
  [115, "Home"], [116, "Page Up"], [117, "Forward Delete"], [119, "End"], [121, "Page Down"],
  [123, "Left"], [124, "Right"], [125, "Down"], [126, "Up"],
]);

function contextMatches(a: RecordedSkillEvent, event: NativeSkillRecordingEvent): boolean {
  return a.app === event.app && a.windowTitle === event.windowTitle;
}

let eventSequence = 0;

function idFor(event: NativeSkillRecordingEvent, suffix = ""): string {
  eventSequence += 1;
  return `${event.atMs}-${event.type}${suffix}-${eventSequence}`;
}

export function shortcutLabel(event: NativeSkillRecordingEvent): string {
  const parts = [
    event.control ? "⌃" : "",
    event.option ? "⌥" : "",
    event.shift ? "⇧" : "",
    event.meta ? "⌘" : "",
    MAC_KEYS.get(event.keycode ?? -1) ?? `Key ${event.keycode ?? "?"}`,
  ];
  return parts.join("");
}

export function appendNativeEvent(
  current: readonly RecordedSkillEvent[],
  event: NativeSkillRecordingEvent,
): AppendNativeEventResult {
  const events = [...current];
  const last = events.at(-1);
  if (event.type === "app") {
    if (last?.type === "app" && contextMatches(last, event)) return { events, addedId: null };
    return commit(events, {
      id: idFor(event), type: "app", atMs: event.atMs, app: event.app, windowTitle: event.windowTitle,
    });
  }
  if (event.type === "click") {
    return commit(events, {
      id: idFor(event), type: "click", atMs: event.atMs, app: event.app, windowTitle: event.windowTitle,
      role: event.role, name: event.name, identifier: event.identifier, ancestry: event.ancestry,
    });
  }
  if (event.type === "scroll") {
    const direction = (event.deltaY ?? 0) > 0 ? "up" : "down";
    if (last?.type === "scroll" && last.direction === direction && contextMatches(last, event) && event.atMs - last.atMs < 800) {
      return { events, addedId: null };
    }
    return commit(events, {
      id: idFor(event), type: "scroll", direction, atMs: event.atMs, app: event.app, windowTitle: event.windowTitle,
    });
  }
  if (event.type === "clipboard") {
    // The helper emits the underlying ⌘C/⌘X/⌘V both as a `key` chord (already
    // committed a beat earlier as a shortcut) and as this richer clipboard
    // event. Collapse the duplicate so one keystroke is one step.
    const prev = events.at(-1);
    const collapsible =
      prev?.type === "shortcut" &&
      // Exactly ⌘C/⌘X/⌘V — not ⌥⌘C or other chords that merely end in the letter.
      /^⌘[CXV]$/.test(prev.shortcut ?? "") &&
      contextMatches(prev, event) &&
      Math.abs(event.atMs - prev.atMs) < 1_500;
    return commit(collapsible ? events.slice(0, -1) : events, {
      id: idFor(event), type: "clipboard", atMs: event.atMs, app: event.app,
      windowTitle: event.windowTitle, op: event.op,
    });
  }
  if (event.type === "download") {
    return commit(events, {
      id: idFor(event), type: "download", atMs: event.atMs,
      filename: event.filename, whereFroms: event.whereFroms,
    });
  }
  if (event.type === "typing") {
    // The helper pre-aggregates plain typing into a keyCount; keep the timeline
    // tidy by folding a follow-up burst in the same context into the last one.
    if (last?.type === "typing" && contextMatches(last, event) && event.atMs - last.atMs < 1_200) {
      events[events.length - 1] = { ...last, atMs: event.atMs, keyCount: (last.keyCount ?? 0) + (event.keyCount ?? 0) };
      return { events, addedId: null };
    }
    return commit(events, {
      id: idFor(event), type: "typing", atMs: event.atMs, app: event.app,
      windowTitle: event.windowTitle, keyCount: event.keyCount ?? 0,
    });
  }
  // A "key" event now always carries a modifier — map it to a readable shortcut.
  return commit(events, {
    id: idFor(event), type: "shortcut", shortcut: shortcutLabel(event), atMs: event.atMs,
    app: event.app, windowTitle: event.windowTitle,
  });
}

export function eventLabel(event: RecordedSkillEvent): string {
  switch (event.type) {
    case "app": return `Opened ${event.app || "an app"}`;
    case "click": return event.name ? `Clicked "${event.name}"` : "Clicked a control";
    case "scroll": return `Scrolled ${event.direction ?? "the page"}`;
    case "shortcut": return `Pressed ${event.shortcut ?? "a shortcut"}`;
    case "typing": return `Typed ${event.keyCount ?? 1} character${event.keyCount === 1 ? "" : "s"}`;
    case "clipboard": return event.op === "cut" ? "Cut" : event.op === "paste" ? "Pasted" : "Copied";
    case "download": return `Downloaded ${event.filename ?? "a file"}`;
  }
}

export function formatRecordingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
