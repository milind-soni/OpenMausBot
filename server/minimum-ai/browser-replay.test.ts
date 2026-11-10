import { expect, it, vi } from "vitest";
import { captureBrowserClick, createBrowserRecording, listBrowserTargets, replayBrowserClick, safeBrowserFillTarget } from "./browser-replay.ts";
import type { CdpPage } from "../browser/cdp/page.ts";

const step = { origin: "https://example.test", url: "https://example.test/sample", role: "button", name: "Move Sample Alpha to trash" };
const tree = '- button "Move Sample Alpha to trash" [ref=e1]\n- button "Move Sample Beta to trash" [ref=e2]';

it("refuses a password field even when its visible label looks harmless", async () => {
  const page = { refs: { resolve: () => ({ backendNodeId: 1, session: { send: async () => ({ node: { nodeName: "INPUT", attributes: ["type", "password"] } }) } }) } } as unknown as CdpPage;
  expect(await safeBrowserFillTarget(page, "e1", { kind: "fill", origin: "https://example.test", url: "https://example.test/sample", role: "textbox", name: "Name", value: "sample" })).toBe(false);
});

it("finds current unique targets matching a literal prefix and rejects ambiguity", () => {
  const snapshot = { url: "https://example.test/sample", tree, truncated: false, frames: 1 };
  const query = { origin: "https://example.test", url: snapshot.url, role: "button", prefix: "Move Sample " };
  expect(listBrowserTargets(snapshot, query).map((target) => target.name)).toEqual(["Move Sample Alpha to trash", "Move Sample Beta to trash"]);
  expect(() => listBrowserTargets({ ...snapshot, tree: tree + '\n- button "Move Sample Alpha to trash" [ref=e3]' }, query)).toThrow(/ambiguous/i);
  expect(() => listBrowserTargets({ ...snapshot, truncated: true }, query)).toThrow();
});

it("only returns a complete first-run recording and ignores late callbacks after it closes", () => {
  const complete = createBrowserRecording();
  complete.record(step);
  expect(complete.finish()).toEqual([step]);
  complete.record(step);
  expect(() => complete.finish()).toThrow();
  const incomplete = createBrowserRecording();
  incomplete.record(step);
  incomplete.unsupported("unsupported action");
  expect(() => incomplete.finish()).toThrow(/incomplete/i);
  expect(() => createBrowserRecording().finish()).toThrow(/incomplete/i);
});

it("keeps the observed peer names in memory for checking a learned pattern", () => {
  const recording = createBrowserRecording();
  recording.record(step, ["Move Sample Alpha to trash", "Move Sample Beta to trash"]);
  expect(recording.finish()[0]).toMatchObject({ ...step, observedNames: ["Move Sample Alpha to trash", "Move Sample Beta to trash"] });
});

it("captures a unique current reference as a reusable page and element identity", () => {
  expect(captureBrowserClick({ url: "https://example.test/sample", tree, truncated: false, frames: 1 }, "@e1")).toEqual(step);
  expect(() => captureBrowserClick({ url: "https://example.test/sample", tree: tree + '\n- button "Move Sample Alpha to trash" [ref=e3]', truncated: false, frames: 1 }, "@e1")).toThrow();
  expect(() => captureBrowserClick({ url: "https://example.test/sample", tree, truncated: true, frames: 1 }, "@e1")).toThrow();
  expect(() => captureBrowserClick({ url: "https://example.test/sample", tree, truncated: false, frames: 1 }, "#unsafe-selector")).toThrow();
});

it("resolves a current target inside the browser's exclusive session before clicking", async () => {
  const click = vi.fn(async () => undefined);
  const exclusive = vi.fn(async (work: (session: any) => Promise<void>) => work({ snapshot: async () => ({ url: "https://example.test/sample", tree, truncated: false, frames: 1 }), click }));
  await replayBrowserClick(step, exclusive, new AbortController().signal);
  expect(exclusive).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledWith("@e1", expect.any(AbortSignal));
});

it.each([
  { url: "https://other.test/", tree, truncated: false, frames: 1 },
  { url: "https://example.test/another-page", tree, truncated: false, frames: 1 },
  { url: "https://example.test/", tree, truncated: true, frames: 1 },
  { url: "https://example.test/", tree, truncated: false, frames: 2 },
  { url: "https://example.test/", tree: tree + '\n- button "Move Sample Alpha to trash" [ref=e3]', truncated: false, frames: 1 },
  { url: "https://example.test/", tree: '- button "Different item" [ref=e1]', truncated: false, frames: 1 },
  { url: "https://example.test/", tree: tree + '\n- iframe:\n  - (frame not readable: unavailable)', truncated: false, frames: 1 },
])("stops before a click on an unsafe or ambiguous snapshot", async (snapshot) => {
  const click = vi.fn();
  await expect(replayBrowserClick(step, async (work) => work({ snapshot: async () => snapshot, click }), new AbortController().signal)).rejects.toThrow();
  expect(click).not.toHaveBeenCalled();
});

it("does not click after the run is cancelled during its snapshot", async () => {
  const controller = new AbortController(), click = vi.fn();
  await expect(replayBrowserClick(step, async (work) => work({ snapshot: async () => { controller.abort(); return { url: "https://example.test/", tree, truncated: false, frames: 1 }; }, click }), controller.signal)).rejects.toThrow();
  expect(click).not.toHaveBeenCalled();
});
