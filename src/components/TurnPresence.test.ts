// @vitest-environment happy-dom
// The presence line rotates gently through a phase's phrases, starts over
// when the bot moves to a new step, and crossfades in place.
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

  it("crossfades the outgoing phrase in the same cell, then drops it", () => {
    render({ phrases: thinking, phase: "think" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    const outgoing = host.querySelector(".turn-phrase-out");
    expect(outgoing?.textContent).toBe("Thinking");
    expect(outgoing?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".turn-phrase-in")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(320));
    expect(host.querySelector(".turn-phrase-out")).toBeNull();
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

  it("floats the outgoing phrase out of flow, so only the shown phrase sets the width", () => {
    render({ phrases: thinking, phase: "think" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    expect(host.querySelector(".turn-phrase-out")?.className).toContain("absolute");
    expect(host.querySelector(".turn-phrase-in")?.className).not.toContain("absolute");
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

describe("thinking shimmer box", () => {
  it("pads the sheen past ascenders, descenders and arabic marks without moving the layout", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const rule = css.match(/\.thinking-shimmer \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("background-clip: text");
    expect(rule).toMatch(/padding: 0\.35em 0\.12em/);
    expect(rule).toMatch(/margin: -0\.35em -0\.12em/);
  });
});
