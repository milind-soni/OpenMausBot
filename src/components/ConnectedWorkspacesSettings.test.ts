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

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "aria-label"?: string;
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void; type?: string; value?: string }>;
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

// ── Local environments (Environments on this computer) ─────────────────────
const LOCAL_ENV = { id: "env-1", kind: "local", name: "Work", dataDir: "/home/me/.openmausbot-work", missing: false };
const GONE_ENV = { id: "env-2", kind: "local", name: "Old", dataDir: "/home/me/.openmausbot-old", missing: true };
const envState = (overrides: Record<string, unknown> = {}) => ({
  localOrigin: "http://127.0.0.1:1", remote: false, packaged: true, activeId: "local",
  environments: [LOCAL_ENV, GONE_ENV, VPS], ...overrides,
});
function stubEnvironments(stateOverrides: Record<string, unknown> = {}, bridgeExtra: Record<string, unknown> = {}, ogbExtra: Record<string, unknown> = {}) {
  const environments = { state: vi.fn().mockResolvedValue(envState(stateOverrides)), switch: vi.fn(),
    forget: vi.fn(), addFromLink: vi.fn(), create: vi.fn(), pickDir: vi.fn(), onOpenSettings: () => () => {}, ...bridgeExtra };
  stub({ environments, ...ogbExtra });
  return environments;
}
const rowButton = (ariaLabel: string) => render().nodes.filter(n => n.type === "button" && n.props["aria-label"] === ariaLabel)[0];
const textButton = (label: string) => render().nodes.filter(n => n.type === "button" && Children.toArray(n.props.children).join("") === label)[0];
const forms = () => render().nodes.filter(n => n.type === "form");
const envFormFields = () => nodes(forms()[0]!.props.children).filter(n => n.type === "input");

it("lists local environments with their folders above the servers, marking a missing one", async () => {
  await stubEnvironments(); await mount();
  const { html } = render();
  expect(html).toContain("Environments on this computer");
  expect(html).toContain("Your servers");
  expect(html.indexOf("Environments on this computer")).toBeLessThan(html.indexOf("Your servers"));
  expect(html).toContain("/home/me/.openmausbot-work");
  expect(html.match(/>missing</g)).toHaveLength(1);
  expect(html).toContain("https://bots.example.test");
});

it("hides local environments and the create form in a dev build", async () => {
  await stubEnvironments({ packaged: false }); await mount();
  const { html } = render();
  expect(html).not.toContain("Environments on this computer");
  expect(html).not.toContain("Choose…");
  expect(html).not.toContain("/home/me/.openmausbot-work");
});

it("creates an environment with the chosen folder — and without one when the field is left empty", async () => {
  const environments = stubEnvironments({}, { create: vi.fn().mockResolvedValue({ ok: true, state: envState() }) });
  await mount();
  envFormFields()[0]!.props.onChange!({ target: { value: "Work" } });
  envFormFields()[1]!.props.onChange!({ target: { value: "/data/work" } });
  forms()[0]!.props.onSubmit!({ preventDefault: () => {} });
  await flush();
  expect(environments.create).toHaveBeenCalledWith("Work", "/data/work");
  // The form is empty again, so a second create without a path sends none.
  expect(envFormFields()[0]!.props.value).toBe("");
  expect(envFormFields()[1]!.props.value).toBe("");
  envFormFields()[0]!.props.onChange!({ target: { value: "Solo" } });
  forms()[0]!.props.onSubmit!({ preventDefault: () => {} });
  await flush();
  expect(environments.create).toHaveBeenLastCalledWith("Solo", undefined);
  // A failed create says one generic thing, whatever main's reason was.
  environments.create.mockResolvedValueOnce({ ok: false, error: "duplicate" });
  envFormFields()[0]!.props.onChange!({ target: { value: "Work" } });
  forms()[0]!.props.onSubmit!({ preventDefault: () => {} });
  await flush();
  expect(render().html).toContain("Couldn't create the environment.");
});

it('"Choose…" fills the folder field from the native picker', async () => {
  stubEnvironments({}, { pickDir: vi.fn().mockResolvedValue({ ok: true, path: "/picked/dir" }) });
  await mount();
  textButton("Choose…")!.props.onClick!();
  await flush();
  expect(render().html).toContain('value="/picked/dir"');
});

it("asks what to do with the folder when forgetting a local environment, and deletes only when asked", async () => {
  const environments = stubEnvironments();
  await mount();
  rowButton("Forget Old")!.props.onClick!();
  await mount();
  expect(render().html).toContain("Also delete this folder");
  textButton("Cancel")!.props.onClick!();
  await mount();
  expect(render().html).not.toContain("Also delete this folder");
  expect(environments.forget).not.toHaveBeenCalled();
  // Keep the files (default): no purge argument at all.
  rowButton("Forget Work")!.props.onClick!();
  await mount();
  textButton("Forget")!.props.onClick!();
  await flush();
  expect(environments.forget.mock.calls).toEqual([["env-1"]]);
  rowButton("Forget Old")!.props.onClick!();
  await mount();
  render().nodes.find(n => n.type === "input" && n.props.type === "checkbox")!.props.onChange!({ target: { checked: true } });
  await mount();
  textButton("Forget")!.props.onClick!();
  await flush();
  expect(environments.forget.mock.calls).toEqual([["env-1"], ["env-2", true]]);
});

it("confirms before switching to a local environment, and a failed switch says one generic thing", async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  const environments = stubEnvironments({}, { switch: vi.fn().mockResolvedValue({ ok: true }) }, { confirm });
  await mount();
  rowButton("Switch to Work")!.props.onClick!();
  await flush();
  expect(confirm).toHaveBeenCalled();
  expect(confirm.mock.calls[0][0]).toBe("Switch to Work? The app restarts on that environment. Running turns stop.");
  expect(environments.switch).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  rowButton("Switch to Work")!.props.onClick!();
  await flush();
  expect(environments.switch).toHaveBeenCalledWith("env-1");
  environments.switch.mockResolvedValueOnce({ ok: false, error: "busy" });
  rowButton("Switch to Old")!.props.onClick!();
  await flush();
  expect(environments.switch).toHaveBeenCalledWith("env-2");
  expect(render().html).toContain("Couldn't switch.");
});

it("a failed forget keeps the panel honest: one generic error, no crash", async () => {
  const environments = stubEnvironments({}, { forget: vi.fn().mockResolvedValue({ ok: false, error: "purge" }) });
  await mount();
  rowButton("Forget Work")!.props.onClick!();
  await mount();
  textButton("Forget")!.props.onClick!();
  await flush();
  expect(environments.forget).toHaveBeenCalledWith("env-1");
  expect(render().html).toContain("Couldn't forget the environment.");
  expect(render().html).not.toContain("purge");
});

it("offers no Forget for the environment this app is on", async () => {
  await stubEnvironments({ activeId: "env-1" }); await mount();
  const { html } = render();
  expect(html).not.toContain('aria-label="Forget Work"');
  expect(html).toContain('aria-label="Forget Old"');
});
