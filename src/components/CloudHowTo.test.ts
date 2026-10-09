import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./onboarding/Spotlight", () => ({ Spotlight: (props: { anchor: string; placement: string; secondary: { label: string; onClick: () => void }; children: unknown }) =>
  createElement("div", { "data-spotlight": props.anchor, "data-placement": props.placement }, props.children as never, createElement("button", { onClick: props.secondary.onClick }, props.secondary.label)) }));
import { CloudHowTo, switcherPlacement } from "./CloudHowTo";
import { track } from "@/lib/analytics";

const rect = (left: number, width: number) => ({ left, right: left + width, top: 8, bottom: 36, width, height: 28 });
const doc = (...rects: ReturnType<typeof rect>[]) => ({ querySelectorAll: () => rects.map(value => ({ getBoundingClientRect: () => value })) }) as unknown as Document;
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(CloudHowTo)); };

beforeEach(() => { vi.clearAllMocks(); f.values = []; f.index = 0; f.effects = []; f.dispatch = vi.fn(); f.state = { cloudHowTo: true }; });
afterEach(() => vi.unstubAllGlobals());

it("finds the menu button on screen, below it in a full sidebar and beside it in the icons-only one", () => {
  expect(switcherPlacement(doc(rect(10, 140)), 1200, 800)).toBe("below");
  expect(switcherPlacement(doc(rect(8, 40)), 1200, 800)).toBe("right");
  // A closed drawer (off screen) or a hidden button is no button.
  expect(switcherPlacement(doc(rect(-300, 140), { ...rect(10, 0), width: 0 }), 1200, 800)).toBeNull();
  expect(switcherPlacement(doc(), 1200, 800)).toBeNull();
});

it("one step on the menu that keeps Add a Cloud, with Skip; nothing when not asked for", () => {
  vi.stubGlobal("document", doc(rect(10, 140))); vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
  render(); f.effects.forEach(effect => effect());
  const html = render();
  expect(html).toContain('data-spotlight="server-switcher"'); expect(html).toContain('data-placement="below"');
  expect(html).toContain("Add a Cloud from here");
  expect(html).toContain("Click this menu, then choose Add a Cloud. It&#x27;s also where you switch between this computer and My Cloud.");
  expect(html).toContain(">Skip<");
  f.state = { cloudHowTo: false }; expect(render()).toBe("");
});

it("with the menu off screen, the dialog opens instead and says where the menu is for next time", () => {
  vi.stubGlobal("document", doc()); vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
  render(); f.effects.forEach(effect => effect());
  expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_howto" });
  expect(track).toHaveBeenCalledWith("cloud_howto", { result: "no_button" });
  f.state = { cloudHowTo: false };
  expect(render()).toContain("Next time, Add a Cloud is in the menu at the top of the sidebar.");
});
