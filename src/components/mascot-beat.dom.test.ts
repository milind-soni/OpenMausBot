// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MausMotion } from "@/lib/mascot";
import { MOTION_BEAT_MS, useMotionBeat } from "./mascot-beat";

let container: HTMLDivElement, root: Root;
const seen: boolean[] = [];
function Probe({ motion, motionKey }: { motion: MausMotion | undefined; motionKey: number }) {
  seen.push(useMotionBeat(motion, motionKey));
  return null;
}
const show = (motion: MausMotion | undefined, motionKey: number) => act(async () => root.render(createElement(Probe, { motion, motionKey })));
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const playing = () => seen.at(-1);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  seen.length = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("plays a beat from the render that brings it and ends it, though the store keeps the motion", async () => {
  await show("blink", 1);
  expect(playing()).toBe(true);
  await wait(MOTION_BEAT_MS - 1);
  expect(playing()).toBe(true);
  await wait(1);
  expect(playing()).toBe(false);
  // The open chat sits idle with the same last motion: the face stays at rest.
  await wait(60_000);
  await show("blink", 1);
  expect(playing()).toBe(false);
});

it("plays again for the next beat of the same kind, from its first render", async () => {
  await show("blink", 1);
  await wait(MOTION_BEAT_MS);
  expect(playing()).toBe(false);
  await show("blink", 2);
  expect(seen.at(-1)).toBe(true);
  await wait(MOTION_BEAT_MS);
  expect(playing()).toBe(false);
});

it("a newer beat during one restarts the time it plays", async () => {
  await show("working", 1);
  await wait(MOTION_BEAT_MS - 100);
  await show("success", 2);
  await wait(MOTION_BEAT_MS - 1);
  expect(playing()).toBe(true);
  await wait(1);
  expect(playing()).toBe(false);
});

it("no motion is never a beat", async () => {
  await show(undefined, 0);
  expect(playing()).toBe(false);
  await show("none", 3);
  expect(playing()).toBe(false);
});
