// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { phraseAt, phraseHoldMs } from "@/lib/live-activity";
import { TurnPresence } from "./TurnPresence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thinking = ["Thinking", "Mulling it over", "Piecing it together", "Chipping away"];
const seed = "bot:thread:1";

let host: HTMLDivElement;
let root: Root;

function render(props: Record<string, unknown>) {
  act(() => root.render(createElement(TurnPresence, { avatar: null, visible: true, seed, since: null, ...props })));
}

const visibleText = () =>
  Array.from(host.querySelectorAll(".thinking-shimmer:not([aria-hidden])")).map((node) => node.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("TurnPresence phrases", () => {
  it("holds each phrase for its seeded 4 to 6 seconds, then moves on", () => {
    render({ phrases: thinking, phase: "think" });
    expect(visibleText()).toEqual(["Thinking"]);
    const hold = phraseHoldMs(`${seed}|think`, 0);
    act(() => void vi.advanceTimersByTime(hold - 1));
    expect(visibleText()).toEqual(["Thinking"]);
    act(() => void vi.advanceTimersByTime(1));
    expect(visibleText()).toEqual([phraseAt(thinking, `${seed}|think`, 1)]);
  });

  it("swaps one phrase for the next and never draws two at once", () => {
    // The fading old phrase sat out of flow: a longer one drew over the size beside it ("Piecing it together" over "· 2 KB").
    render({ label: "Working", phrases: thinking, phase: "think", since: Date.now(), size: "2 KB" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    const drawn = () => Array.from(host.querySelectorAll("[data-turn-now] .thinking-shimmer")).map((node) => node.textContent);
    expect(drawn()).toEqual([phraseAt(thinking, `${seed}|think`, 1)]);
    expect(host.querySelector(".turn-phrase-in")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(320));
    expect(drawn()).toEqual([phraseAt(thinking, `${seed}|think`, 1)]);
  });

  it("starts a new step at its plain label", () => {
    render({ phrases: thinking, phase: "think" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    render({ phrases: ["Searching the web", "Looking it up"], phase: "web" });
    expect(visibleText()).toEqual(["Searching the web"]);
  });

  it("starts a returning phase over, even after a step too short to swap", () => {
    render({ phrases: thinking, phase: "think" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    expect(visibleText()).not.toEqual(["Thinking"]);
    render({ phrases: ["Reading a file", "Reading through"], phase: "read" });
    act(() => void vi.advanceTimersByTime(1000));
    render({ phrases: thinking, phase: "think" });
    expect(visibleText()).toEqual(["Thinking"]);
  });

  it("keeps a single phrase steady", () => {
    render({ phrases: ["Running the test suite"], phase: "spoken" });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(visibleText()).toEqual(["Running the test suite"]);
    expect(host.querySelector(".turn-phrase-out")).toBeNull();
  });

  it("still takes a plain label, as the sidebar-era callers pass", () => {
    const markup = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Running a command", since: 1 }));
    expect(markup).toContain("Running a command");
    expect(markup).toContain("thinking-shimmer");
  });
});

describe("the status line", () => {
  const line = () => {
    const shown = host.querySelector("[data-turn-status]");
    return shown?.textContent?.replace(/\s+/g, " ").trim();
  };

  it("reads Working, the time, what is happening now and how much is written", () => {
    vi.setSystemTime(100_000);
    render({ label: "Working", since: 28_000, phrases: ["Writing index.html"], phase: "live:w", size: "14 KB" });
    expect(line()).toBe("Working · 1m 12s · Writing index.html · 14 KB");
    expect(visibleText(), "the live part shimmers, the lead does not").toEqual(["Writing index.html"]);
  });

  it("is the lead and the timer alone when nothing is reported, and the lead shimmers", () => {
    vi.setSystemTime(100_000);
    render({ label: "Working", since: 88_000 });
    expect(line()).toBe("Working · 12s");
    expect(visibleText()).toEqual(["Working"]);
    expect(host.querySelector("[data-turn-size]")).toBeNull();
  });

  it("fades the first phrase in from nothing, never from the lead", () => {
    render({ label: "Working", since: null });
    render({ label: "Working", since: null, phrases: ["Thinking"], phase: "think" });
    expect(host.querySelector(".turn-phrase-out")).toBeNull();
    expect(line()).toBe("Working · Thinking");
  });
});

describe("a long step's quiet part", () => {
  const line = () => host.querySelector("[data-turn-status]")?.textContent?.replace(/\s+/g, " ").trim();

  it("follows the step with how it is doing, and counts the time since its last output on its own", () => {
    vi.setSystemTime(1_000_000);
    render({ label: "Working", since: 1_000_000 - 72_000, phrases: ["Running scrape.py"], phase: "step", hover: "python3 scrape.py --pages 40", quiet: { kind: "busy" } });
    expect(line()).toBe("Working · 1m 12s · Running scrape.py · busy, no output yet");
    expect(host.querySelector("[data-turn-now]")?.getAttribute("title")).toBe("python3 scrape.py --pages 40");
    render({ label: "Working", since: 1_000_000 - 72_000, phrases: ["Running scrape.py"], phase: "step", quiet: { kind: "output", at: 1_000_000 - 30_000 } });
    expect(host.querySelector("[data-turn-quiet]")?.textContent).toBe("last output just now");
    act(() => void vi.advanceTimersByTime(45_000));
    expect(host.querySelector("[data-turn-quiet]")?.textContent).toBe("last output 1 min ago");
  });

  it("says it in Simple mode too, after the one phrase", () => {
    render({ simple: true, phrases: ["Running scrape.py"], phase: "step", quiet: { kind: "network" } });
    expect(line()).toBe("Running scrape.py · waiting on the network");
  });
});

describe("the Now card", () => {
  const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const card = () => host.querySelector("[role=region]");
  const open = (extra: Record<string, unknown> = {}) =>
    render({ label: "Working", since: Date.now(), phrases: ["Running scrape.py"], phase: "step", card: createElement("p", null, "steps"), cardLabel: "What Biber is doing", ...extra });

  it("is one calm line by default; a click unfolds the card under it and another folds it", () => {
    open();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle()?.getAttribute("aria-label")).toBe("What Biber is doing");
    expect(card()).toBeNull();
    act(() => toggle()!.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card()?.textContent).toBe("steps");
    expect(toggle()?.getAttribute("aria-controls")).toBe(card()?.id);
    act(() => toggle()!.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card()).toBeNull();
  });

  it("folds on Escape and gives focus back to the line", () => {
    open();
    act(() => toggle()!.click());
    toggle()!.focus();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("leaves Escape to whatever else has the focus", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    open();
    act(() => toggle()!.click());
    field.focus();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(card()).not.toBeNull();
    field.remove();
  });

  it("is a plain line with nothing to show, in Simple mode a button as well, and folds when the turn ends", () => {
    render({ label: "Working", since: Date.now(), phrases: ["Thinking"], phase: "think" });
    expect(toggle()).toBeNull();
    open({ simple: true });
    act(() => toggle()!.click());
    expect(card()).not.toBeNull();
    render({ visible: false, card: createElement("p", null, "steps"), cardLabel: "What Biber is doing" });
    act(() => void vi.advanceTimersByTime(300));
    open({ simple: true });
    expect(toggle()?.getAttribute("aria-expanded"), "a new turn starts folded").toBe("false");
  });
});

describe("thinking shimmer box", () => {
  it("pads the sheen past ascenders, descenders and arabic marks without moving the layout", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const rule = css.match(/\.thinking-shimmer \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("background-clip: text");
    expect(rule).toMatch(/padding: 0\.35em 0\.12em/);
    expect(rule).toMatch(/margin: -0\.35em -0\.12em/);
  });
});
