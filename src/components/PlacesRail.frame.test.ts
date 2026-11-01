// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RailState } from "../../electron/cloud-rail.mjs";

const fixture = vi.hoisted(() => ({ windowChrome: "mac-inset" as "mac-inset" | "win-caption", windowFrame: undefined as boolean | undefined }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { windowChrome: fixture.windowChrome, windowFrame: fixture.windowFrame }, ready: true }),
}));

import { setLocale } from "@/lib/i18n";
import { refreshPlaces } from "@/lib/places";
import { PlacesRail } from "./PlacesRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let tell: (framed: boolean) => void = () => {};
const rail: RailState = { places: [{ id: "home", name: "My Cloud", color: null, kind: "cloud", opens: true, active: true }], add: { cloud: true, link: false, address: false } };

beforeEach(() => {
  setLocale("en");
  fixture.windowChrome = "mac-inset";
  fixture.windowFrame = undefined;
  Object.assign(window, { ogb: {
    workspaces: { places: async () => rail, onChanged: () => () => {} },
    rail: { expand: async () => {}, onSkin: () => () => {}, onFramed: (callback: (framed: boolean) => void) => { tell = callback; return () => {}; } },
  } });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

async function mount() {
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(createElement(PlacesRail, { chrome: true })); });
}
const above = () => host.querySelector("[data-places-rail] > div[aria-hidden]")!.className;

it("starts its places under the frame's top bar while the page beside draws it, and under the traffic lights' old place beside an older page", async () => {
  await mount();
  expect(above(), "the window opens framed").toContain("h-[37px]");
  await act(async () => tell(false));
  expect(above(), "macOS: under the traffic lights where an older release put them").toContain("h-[52px]");
  await act(async () => tell(true));
  expect(above()).toContain("h-[37px]");
});

it("with the frame turned off, stands beside the sidebar as it did before the frame: under macOS's traffic lights, in the sidebar's colour", async () => {
  fixture.windowFrame = false;
  await mount();
  expect(above()).toContain("h-[52px]");
  const nav = host.querySelector("[data-places-rail]")!.className.split(" ");
  expect(nav).toEqual(expect.arrayContaining(["bg-panel", "border-r"]));
  expect(nav).not.toContain("bg-frame");
});

it("on Windows beside an older page, keeps that release's small gap: there are no traffic lights", async () => {
  fixture.windowChrome = "win-caption";
  await mount();
  await act(async () => tell(false));
  expect(above()).toContain("h-3");
});
