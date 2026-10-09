// Settings → Servers: Copy this computer here on each server this app added
// (docs/copy-workspace.md), opening the same copy panel as Settings → OMB Cloud.
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudMoveBridge } from "../../electron/cloud-move.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }) }));
import { ConnectedWorkspacesSettings } from "./ConnectedWorkspacesSettings";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "aria-label"?: string }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render() {
  f.index = 0; f.effects = []; let tree: ReactNode;
  function Capture() { tree = ConnectedWorkspacesSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)).replaceAll("&#x27;", "'");
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const copyButtons = () => render().nodes.filter(node => node.type === "button" && Children.toArray(node.props.children).join("") === "Copy this computer here");

const VPS = { id: "vps", name: "VPS", origin: "https://bots.example.test" };
let move: CloudMoveBridge;
function stub(extra: Record<string, unknown> = {}) {
  vi.stubGlobal("window", {
    ogb: { environments: { state: vi.fn().mockResolvedValue({ localOrigin: "http://127.0.0.1:1", remote: false, activeId: "local", environments: [VPS] }),
      switch: vi.fn(), forget: vi.fn(), addFromLink: vi.fn(), onOpenSettings: () => () => {} }, cloudMove: move, ...extra },
    location: { search: "", href: "http://127.0.0.1:1/settings" }, history: { replaceState: () => {} },
  });
}
async function mount() { render(); for (const effect of f.effects) effect(); await flush(); }
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = [];
  move = { state: vi.fn().mockResolvedValue({ phase: "idle", local: null, cloud: null, suggest: false, destination: { ...VPS, kind: "server" }, blocked: null }),
    start: vi.fn(), cancel: vi.fn(), restorePrevious: vi.fn(), dismiss: vi.fn(), onState: vi.fn(() => () => {}) };
  stub(); setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

it("each server this app added (not this computer) offers Copy this computer here, which opens the copy for that server", async () => {
  await mount();
  const buttons = copyButtons();
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.props["aria-label"]).toBe("Copy this computer here: VPS");
  expect(render().html).not.toContain("Copy this computer's bots and chats");
  buttons[0]!.props.onClick!();
  await mount();
  expect(vi.mocked(move.state).mock.calls).toContainEqual(["vps"]);
  const { html } = render();
  expect(html).toContain("Copy this computer's bots and chats");
  expect(html).toContain("from this computer to VPS");
});

it("is not offered without the desktop app's copy, or to a companion connected to another computer", async () => {
  stub({ cloudMove: undefined });
  await mount();
  expect(copyButtons()).toHaveLength(0);
  f.values = [];
  stub({ remoteClient: { active: true } });
  await mount();
  expect(copyButtons()).toHaveLength(0);
  expect(move.state).not.toHaveBeenCalled();
});

it("a server's own Copy brings the person here, on that server's copy, to start it themselves", async () => {
  // The window switched to this computer at ?desktop-settings=workspaces&copy-to=vps.
  const replaced: string[] = [];
  stub({});
  vi.stubGlobal("window", { ...window, location: { search: "?desktop-settings=workspaces&copy-to=vps", href: "http://127.0.0.1:1/?desktop-settings=workspaces&copy-to=vps" },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { replaced.push(url); } } });
  await mount(); await mount();
  expect(vi.mocked(move.state).mock.calls).toContainEqual(["vps"]);
  expect(render().html).toContain("from this computer to VPS");
  // The panel is open, and nothing started: the person starts it here.
  expect(move.start).not.toHaveBeenCalled();
  expect(replaced.at(-1)).toBe("/?desktop-settings=workspaces");
  // Already on this page: main's message names the panel; Computer access stays its own.
  f.values = [];
  let listener: (id?: string | null, panel?: "copy") => void = () => {};
  stub({});
  (window.ogb!.environments as { onOpenSettings: unknown }).onOpenSettings = (callback: typeof listener) => { listener = callback; return () => {}; };
  await mount();
  expect(render().html).not.toContain("Copy this computer's bots and chats");
  listener("vps");
  expect(render().html).not.toContain("Copy this computer's bots and chats");
  listener("vps", "copy");
  await mount();
  expect(render().html).toContain("from this computer to VPS");
});
