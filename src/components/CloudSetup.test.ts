import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, type WelcomeViewer } from "@/lib/onboarding";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, dispatch: (() => {}) as (action: unknown) => void }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn() }));
vi.mock("@/lib/drafts", () => ({ appendComposerDraft: vi.fn(), getDraft: vi.fn(() => "") }));
import { CloudSetup } from "./CloudSetup";
import { CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED } from "@/lib/cloud-setup";
import { appendComposerDraft, getDraft } from "@/lib/drafts";
import { api } from "@/state/store";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "data-status"?: string; "data-cloud-setup-step"?: string }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const owner: WelcomeViewer = { hosted: false, canSave: true, cloudHome: true };
let viewer: WelcomeViewer | null = owner;
function render() {
  f.index = 0; f.effects = []; let tree: ReactNode;
  function Capture() { tree = CloudSetup({ viewer }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const text = (node: Node): string => Children.toArray(node.props.children).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement(child) ? text(child as Node) : "").join("");
const button = (label: string) => render().nodes.find(node => node.type === "button" && text(node) === label);
/** Open a step that is not the current one by its title. */
const expand = (title: string) => render().nodes.find(node => node.type === "button" && text(node).startsWith(title))!.props.onClick!();
const statuses = () => Object.fromEntries(render().nodes.filter(node => node.props["data-cloud-setup-step"]).map(node => [node.props["data-cloud-setup-step"], node.props["data-status"]]));
/** Run what the component asked for on mount (main's snapshot, the lent-computer check). */
async function mount() { render(); for (const effect of f.effects) effect(); await flush(); }

const ready = { instanceId: "claude", snapshot: { state: "available", authenticated: true } };
const signedOut = { instanceId: "claude", snapshot: { state: "available", authenticated: false } };
const local = { bots: 4, rooms: 1, chats: 37, bytes: 1.5 * 1024 ** 3, files: 900 };
const emptyCloud = { contents: { bots: 1, rooms: 0, chats: 0 }, empty: true, freeBytes: 9 * 1024 ** 3, previous: null, heldBytes: 0 };
const CLOUD = { id: "cloud", name: "My Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev", kind: "cloud" as const };
const overview = (extra: Partial<CloudMoveOverview> = {}): CloudMoveOverview => ({ phase: "idle", local, cloud: emptyCloud, suggest: true, destination: CLOUD, blocked: null, ...extra });
let bridge: CloudMoveBridge, push: (state: CloudMoveState) => void, lent: unknown[], open: ReturnType<typeof vi.fn>;
let dispatched: unknown[];

beforeEach(() => {
  vi.clearAllMocks(); f.values = []; f.index = 0; f.effects = []; viewer = owner; lent = []; dispatched = []; push = () => {};
  f.dispatch = action => { dispatched.push(action); };
  f.state = {
    connected: true, instances: [signedOut], activeView: "chat", selectedId: "b1",
    bots: [{ id: "b1", threadId: "t1", name: "Maus" }],
    config: { cloudHome: true, onboarding: { ...EMPTY_ONBOARDING } },
  };
  bridge = {
    state: vi.fn().mockResolvedValue(overview()), start: vi.fn().mockResolvedValue({ phase: "done" }), cancel: vi.fn().mockResolvedValue({ phase: "failed" }),
    restorePrevious: vi.fn().mockResolvedValue({ phase: "done" }), dismiss: vi.fn().mockResolvedValue(overview({ suggest: false })),
    onState: vi.fn(callback => { push = callback; return () => {}; }),
  };
  open = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", { ogb: { platform: "darwin", cloudMove: bridge, cloudLending: { open } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/shared-computers") return { computers: lent };
    if (path === "/api/config" && init?.method === "PUT") {
      const patch = JSON.parse(String(init.body));
      return { ...f.state.config, onboarding: { ...f.state.config.onboarding, ...patch.onboarding } };
    }
    throw new Error(`unexpected ${path}`);
  });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

it("is not shown before the page knows what it is, or before the Cloud has answered, and asks nothing", async () => {
  viewer = null; f.values = [];
  await mount();
  expect(render().html).toBe("");
  viewer = owner;
  for (const change of [{ connected: false }, { instances: [] }, { config: { cloudHome: true } }]) {
    const saved = f.state; f.state = { ...f.state, ...change }; f.values = [];
    await mount();
    expect(render().html).toBe("");
    f.state = saved;
  }
  expect(bridge.state).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});

it("off a Cloud home, and to a Cloud guest, there is no checklist: the plain Copy this computer here card, only when main suggests it", async () => {
  const server = { id: "vps", name: "bots.example.test", origin: "https://bots.example.test", kind: "server" as const };
  for (const who of [{ hosted: false, canSave: true }, { ...owner, canSave: false }]) {
    viewer = who; f.values = [];
    vi.mocked(bridge.state).mockResolvedValue(overview({ suggest: false, destination: server }));
    await mount();
    expect(render().html).toBe("");
    f.values = [];
    vi.mocked(bridge.state).mockResolvedValue(overview({ suggest: true, destination: server }));
    await mount();
    const { html } = render();
    expect(html).not.toContain("Set up My Cloud");
    expect(html).toContain("Bring your bots and chats from this Mac");
    expect(html).toContain("bots.example.test is empty. Copy 4 bots and 37 chats here (about 1.5 GB).");
  }
  expect(api).not.toHaveBeenCalled();
});

it("on a new Cloud lists the four steps, sign-in first and required, each from the Cloud's own state", async () => {
  await mount();
  const { html } = render();
  expect(html).toContain("Set up My Cloud");
  expect(html).toContain("0 of 4 done");
  for (const title of ["Sign in to Claude or ChatGPT", "Bring your bots from this computer", "Try something that runs while you&#x27;re away", "Optional: Let My Cloud use this Mac"]) expect(html).toContain(title);
  expect(html).toContain("Required.");
  expect(statuses()).toEqual({ engine: "todo", move: "todo", try: "todo", lend: "todo" });
  expect(bridge.state).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledWith("/api/shared-computers");
  // Plain words, no confirmation dialog, not a modal.
  expect(html).not.toMatch(/workspace|organis/i);
  expect(html).not.toContain('aria-modal="true"');
  expect(html).not.toContain('role="dialog"');
  // Nothing to try until an engine can run.
  expect(button("Try it")).toBeUndefined();
});

it("sign-in is done when any engine can run; its action shows the existing sign-in when it is not on screen", async () => {
  await mount();
  // In the chat view the Cloud's sign-in already fills the window.
  expect(button("Sign in")).toBeUndefined();
  f.state.activeView = "routines";
  button("Sign in")!.props.onClick!();
  expect(dispatched).toEqual([{ type: "showChat" }]);
  f.state.instances = [signedOut, ready];
  expect(statuses().engine).toBe("done");
  expect(render().html).toContain("1 of 4 done");
});

it("try something is done by the server's record of a finished turn, and Try it puts the example into the chat", async () => {
  f.state.instances = [ready];
  await mount();
  // Signed in, the next step open is bringing bots; trying something is a click away.
  expect(button("Try it")).toBeUndefined();
  expect(button("Copy to My Cloud")).toBeTruthy();
  expand("Try something that runs while you're away");
  expect(button("Copy to My Cloud")).toBeUndefined();
  button("Try it")!.props.onClick!();
  expect(dispatched).toEqual([{ type: "select", id: "b1" }]);
  expect(appendComposerDraft).toHaveBeenCalledExactlyOnceWith("bot:b1:t1", "Every morning at 8, check the top stories on Hacker News and send me a short summary.");
  // Pressed again with the example still waiting in the composer: not twice.
  vi.mocked(getDraft).mockReturnValueOnce("Every morning at 8, check the top stories on Hacker News and send me a short summary.");
  button("Try it")!.props.onClick!();
  expect(appendComposerDraft).toHaveBeenCalledOnce();
  // Sent or not, only the server's record ticks it.
  expect(statuses().try).toBe("todo");
  f.state.instances = [signedOut];
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, firstTurnAt: "2026-09-30T08:00:00.000Z" };
  expect(statuses()).toMatchObject({ engine: "todo", try: "done" });
});

it("disappears once an engine can run and a bot has finished a turn there", async () => {
  f.state.instances = [ready];
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, firstTurnAt: "2026-09-30T08:00:00.000Z" };
  vi.mocked(bridge.state).mockResolvedValue(overview({ suggest: false }));
  await mount();
  expect(render().html).toBe("");
});

it("Hide setup is one click, kept in the Cloud's own settings, and is the move's Not now too", async () => {
  await mount();
  button("Hide setup")!.props.onClick!(); await flush();
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [CLOUD_SETUP_HIDDEN] } }) });
  expect(dispatched).toContainEqual({ type: "configStatus", config: expect.objectContaining({ onboarding: expect.objectContaining({ hintsSeen: [CLOUD_SETUP_HIDDEN] }) }) });
  expect(bridge.dismiss).toHaveBeenCalledOnce();
  expect(render().html).not.toContain("data-cloud-setup");
  // Another device, a reload, cleared browser storage: the Cloud's record decides.
  f.values = []; f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_SETUP_HIDDEN] };
  vi.mocked(bridge.state).mockResolvedValue(overview({ suggest: false }));
  await mount();
  expect(render().html).toBe("");
});

it("bringing bots opens the copy in place; Copy starts it, and Not now is kept as skipped", async () => {
  await mount();
  expect(render().html).not.toContain("Copy 4 bots and 37 chats");
  // One step is open at a time: here, signing in.
  expect(button("Copy to My Cloud")).toBeUndefined();
  expand("Bring your bots from this computer");
  button("Copy to My Cloud")!.props.onClick!();
  let { html } = render();
  expect(html).toContain("My Cloud is empty. Copy 4 bots and 37 chats here (about 1.5 GB).");
  expect(html).toContain("API keys and sign-ins stay on this computer");
  button("Copy")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([[undefined]]);
  push({ phase: "uploading", action: "move", destination: CLOUD, progress: { bytesTransferred: 1, totalBytes: 2 } });
  expect(render().html).toContain("Uploading to My Cloud");
  push({ phase: "done", action: "move", destination: CLOUD, moved: { bots: 4, rooms: 1, chats: 37 } });
  expect(statuses().move).toBe("done");

  // Another Cloud, where the person says Not now instead.
  f.values = []; f.effects = [];
  await mount();
  expand("Bring your bots from this computer");
  button("Copy to My Cloud")!.props.onClick!();
  button("Not now")!.props.onClick!(); await flush();
  expect(bridge.dismiss).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [CLOUD_SETUP_MOVE_SKIPPED] } }) });
  ({ html } = render());
  expect(statuses().move).toBe("skipped");
  expect(html).toContain("Skipped");
});

it("lending opens the lending switch on this Mac and is done when the Cloud lists a lent computer", async () => {
  await mount();
  expand("Optional: Let My Cloud use this Mac");
  button("Choose what to lend")!.props.onClick!(); await flush();
  expect(open).toHaveBeenCalledExactlyOnceWith();
  expect(statuses().lend).toBe("todo");
  lent = [{ id: "mac", name: "MacBook-Pro", online: true }];
  f.values = [];
  await mount();
  expect(statuses().lend).toBe("done");
  // Opening can fail (another window took over); it says so and can be tried again.
  open.mockRejectedValueOnce(new Error("only available"));
  lent = []; f.values = [];
  await mount();
  expand("Optional: Let My Cloud use this Mac");
  button("Choose what to lend")!.props.onClick!(); await flush();
  expect(render().html).toContain("Could not open Settings on this Mac. Try again.");
});

it("offers bringing bots and lending only in the desktop app, and lending only on a Mac", async () => {
  vi.stubGlobal("window", { ogb: { platform: "win32", cloudMove: bridge, cloudLending: { open } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  await mount();
  expect(Object.keys(statuses())).toEqual(["engine", "move", "try"]);
  // A desktop from before the lending shortcut.
  f.values = [];
  vi.stubGlobal("window", { ogb: { platform: "darwin", cloudMove: bridge }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  await mount();
  expect(Object.keys(statuses())).toEqual(["engine", "move", "try"]);
  // A browser.
  f.values = []; vi.mocked(api).mockClear();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  await mount();
  expect(Object.keys(statuses())).toEqual(["engine", "try"]);
  expect(render().html).toContain("0 of 2 done");
  expect(api).not.toHaveBeenCalledWith("/api/shared-computers");
});
