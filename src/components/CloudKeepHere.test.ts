import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSendPageBridge, KeepHereState } from "../../electron/cloud-send.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], advanced: true }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => f.advanced }));
import { CloudKeepHere } from "./CloudKeepHere";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean; checked?: boolean; "aria-label"?: string }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
let bridge: CloudSendPageBridge, notify: () => void;
/** The switch as React renders it: the gate, then the switch itself. */
function render(with_ = bridge) {
  f.index = 0; f.effects = [];
  const outer = CloudKeepHere({ bridge: with_ });
  const tree = isValidElement(outer) ? (outer.type as (props: unknown) => ReactNode)(outer.props) : outer;
  return { html: tree ? renderToStaticMarkup(createElement(() => tree)) : "", nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const toggle = () => render().nodes.find(node => node.props["aria-label"] === "Keep this computer's bots on this computer");
const press = (label: string) => { const button = render().nodes.find(node => node.type === "button" && node.props.children === label); expect(button, label).toBeTruthy(); button!.props.onClick!(); };
const before: KeepHereState = { shown: true, on: false, moved: false, coming: false };
const moved: KeepHereState = { shown: true, on: false, moved: true, coming: false };
async function ready(state: KeepHereState) {
  vi.mocked(bridge.keepHere!).mockResolvedValue(state);
  render(); f.effects[0]?.(); await flush();
}
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; f.advanced = true; notify = () => {};
  bridge = { notice: vi.fn(), dismiss: vi.fn(), onNotice: vi.fn((listener: () => void) => { notify = listener; return () => {}; }), keepHere: vi.fn(),
    setKeepHere: vi.fn(async (on: boolean) => ({ ...moved, on, moved: false, coming: on })) } as unknown as CloudSendPageBridge;
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); });

it("is never shown in Simple mode, even to someone with a Cloud, and main is not even asked", async () => {
  f.advanced = false;
  vi.mocked(bridge.keepHere!).mockResolvedValue(before);
  render(); for (const effect of f.effects) effect(); await flush();
  expect(render().html).toBe("");
  expect(bridge.keepHere).not.toHaveBeenCalled();
});

it("is never shown without a Cloud of one's own the move applies to, nor by a desktop that has no such switch, nor off the desktop", async () => {
  await ready({ shown: false, on: false, moved: false, coming: false });
  expect(bridge.keepHere).toHaveBeenCalledOnce();
  expect(render().html).toBe("");
  f.values = [];
  expect(render({ ...bridge, keepHere: undefined, setKeepHere: undefined }).html).toBe("");
  f.values = [];
  expect(render(undefined).html).toBe("");
});

it("in Advanced mode, before the move: one switch and one plain line; turning it on keeps this computer's bots here at once", async () => {
  await ready(before);
  const { html } = render();
  expect(html).toContain("Keep this computer&#x27;s bots on this computer");
  expect(html).toContain("stay here instead of moving to My Cloud");
  expect(toggle()!.props.checked).toBe(false);
  toggle()!.props.onClick!();
  await flush();
  expect(bridge.setKeepHere).toHaveBeenCalledExactlyOnceWith(true);
  expect(render().html).not.toContain("Bring them back");
});

it("after the move, turning it on first says what happens; only Bring them back brings this computer's bots home, and then it can't be turned back while they come", async () => {
  await ready(moved);
  toggle()!.props.onClick!();
  let html = render().html;
  for (const text of ["Bring this computer&#x27;s bots back here?", "come back from My Cloud with what they did there", "Their automations run here again and stop on My Cloud",
    "Your other computers don&#x27;t change", "The app opens again once they&#x27;re here"]) expect(html).toContain(text);
  expect(bridge.setKeepHere).not.toHaveBeenCalled();
  press("Cancel");
  expect(render().html).not.toContain("Bring them back");
  expect(bridge.setKeepHere).not.toHaveBeenCalled();

  toggle()!.props.onClick!();
  press("Bring them back");
  await flush();
  expect(bridge.setKeepHere).toHaveBeenCalledExactlyOnceWith(true);
  html = render().html;
  expect(html).toContain("on their way back from My Cloud");
  expect(toggle()!.props.disabled).toBe(true);
  expect(toggle()!.props.checked).toBe(true);
});

it("follows the move's line, and says why when main refuses", async () => {
  await ready({ ...moved, on: true, moved: false });
  expect(toggle()!.props.checked).toBe(true);
  vi.mocked(bridge.keepHere!).mockResolvedValue({ ...before, on: true, moved: false, coming: true });
  notify();
  await flush();
  expect(render().html).toContain("on their way back");
  vi.mocked(bridge.keepHere!).mockResolvedValue({ ...before, on: true });
  notify();
  await flush();
  vi.mocked(bridge.setKeepHere!).mockRejectedValueOnce(new Error("Error invoking remote method 'one-home:keep-set': Error: This computer's bots are on their way back. Try again once they're here."));
  toggle()!.props.onClick!();
  await flush();
  expect(bridge.setKeepHere).toHaveBeenCalledWith(false);
  expect(render().html).toContain("on their way back. Try again once they&#x27;re here.");
});
