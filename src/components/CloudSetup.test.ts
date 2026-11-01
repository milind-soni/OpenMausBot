import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, type WelcomeViewer } from "@/lib/onboarding";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, ownHooks: 0, effects: [] as EffectCallback[], state: {} as any, dispatch: (() => {}) as (action: unknown) => void, showThreads: true }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => f.showThreads }));
vi.mock("@/components/onboarding/view-transition", () => ({ withViewTransition: (update: () => void) => { update(); return null; } }));
vi.mock("@/lib/cloud-intent", async original => {
  const actual = await original<typeof import("@/lib/cloud-intent")>();
  return { ...actual, reopenCloudIntent: vi.fn(actual.reopenCloudIntent) };
});
import { CloudSetup } from "./CloudSetup";
import { markIntentSent, reopenCloudIntent } from "@/lib/cloud-intent";
import { CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN, CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, welcomeStepHint } from "@/lib/cloud-setup";
import { cloudWelcomeShown, resetCloudWelcome, takeWelcomeRequest, useCloudWelcome } from "@/lib/cloud-welcome";
import { api } from "@/state/store";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "data-status"?: string; "data-cloud-setup-step"?: string }>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const owner: WelcomeViewer = { hosted: false, canSave: true, cloudHome: true };
let viewer: WelcomeViewer | null = owner;
let welcomeShown = false;
function render() {
  f.index = 0; f.effects = []; let tree: ReactNode;
  function Capture() { tree = CloudSetup({ viewer, welcomeShown }); f.ownHooks = f.index; return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function welcomeNow() {
  let value: ReturnType<typeof useCloudWelcome> | null = null;
  function Probe() { value = useCloudWelcome(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return value!;
}
const text = (node: Node): string => Children.toArray(node.props.children).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement(child) ? text(child as Node) : "").join("");
const button = (label: string) => render().nodes.find(node => node.type === "button" && text(node) === label);
const expand = (title: string) => render().nodes.find(node => node.type === "button" && text(node).startsWith(title))!.props.onClick!();
const statuses = () => Object.fromEntries(render().nodes.filter(node => node.props["data-cloud-setup-step"]).map(node => [node.props["data-cloud-setup-step"], node.props["data-status"]]));
async function mount() { render(); for (const effect of f.effects) effect(); await flush(); }

const ready = { instanceId: "claude", snapshot: { state: "available", authenticated: true } };
/** A Cloud whose first-job question was answered before the welcome existed keeps that checklist. */
const setUpBeforeWelcome = (...hints: string[]) => { f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_INTENT_ASKED, ...hints] }; };
const signedOut = { instanceId: "claude", snapshot: { state: "available", authenticated: false } };
let lent: unknown[];
let dispatched: unknown[];

beforeEach(() => {
  vi.clearAllMocks(); f.values = []; f.index = 0; f.effects = []; f.showThreads = true; viewer = owner; lent = []; dispatched = [];
  welcomeShown = false; resetCloudWelcome();
  f.dispatch = action => { dispatched.push(action); };
  f.state = {
    connected: true, instances: [signedOut], activeView: "chat", selectedId: "b1",
    bots: [{ id: "b1", threadId: "t1", name: "Maus" }], routines: [],
    config: { cloudHome: true, onboarding: { ...EMPTY_ONBOARDING } },
  };
  vi.stubGlobal("window", { ogb: { platform: "darwin" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
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
  expect(api).not.toHaveBeenCalled();
});

it("off a Cloud home, and to a Cloud guest, there is no checklist", async () => {
  for (const who of [{ hosted: false, canSave: true }, { ...owner, canSave: false }]) {
    viewer = who; f.values = [];
    await mount();
    expect(render().html).toBe("");
  }
  expect(api).not.toHaveBeenCalled();
});

it("on a new Cloud stays out of the way while the welcome fills the window", async () => {
  welcomeShown = true;
  await mount();
  expect(render().html).toBe("");
  expect(api).not.toHaveBeenCalled();
});
it("when the person steps away from the welcome, it is the welcome's steps in short, and Continue setup goes back to the step", async () => {
  await mount();
  let { html } = render();
  expect(html).toContain("Set up MausBot Cloud");
  expect(html).toContain("1 of 4 done");
  expect(html).toContain("Bring your stuff");
  expect(html).toContain("Bring your bots, chats and memory, or start fresh.");
  for (const title of ["Create the Cloud", "Connect your AI", "Files and apps"]) expect(html).toContain(title);
  expect(html).not.toContain("Give it a first job");
  expect(statuses()).toEqual({ cloud: "done", move: "todo", engine: "todo", files: "todo" });
  button("Continue setup")!.props.onClick!();
  expect(dispatched).toEqual([{ type: "showChat" }]);
  expect(takeWelcomeRequest()).toBe("bring");
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring"), CLOUD_SETUP_MOVE_SKIPPED] };
  ({ html } = render());
  expect(statuses()).toEqual({ cloud: "done", move: "skipped", engine: "todo", files: "todo" });
  expect(html).toContain("2 of 4 done");
  expect(html).toContain("You&#x27;re on this step");
  f.state.activeView = "routines";
  ({ html } = render());
  expect(html).toContain("Required. Cloud bots use your own Claude or ChatGPT account, or an API key.");
  button("Continue setup")!.props.onClick!();
  expect(takeWelcomeRequest()).toBe("engine");
  expect(api).not.toHaveBeenCalled();
  button("Hide setup")!.props.onClick!(); await flush();
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [welcomeStepHint("bring"), CLOUD_SETUP_MOVE_SKIPPED, CLOUD_SETUP_HIDDEN] } }) });
  expect(cloudWelcomeShown("pending", welcomeNow())).toBe(false);
});
it("after the welcome, it goes once an engine can run and asks for nothing else, without a second Ready", async () => {
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring"), welcomeStepHint("engine"), welcomeStepHint("files"), CLOUD_WELCOME_DONE] };
  f.state.instances = [signedOut];
  await mount();
  expect(statuses()).toEqual({ cloud: "done", engine: "todo", move: "done" });
  expect(render().html).not.toContain("Give it a first job");
  f.state.instances = [ready];
  render(); for (const effect of f.effects) effect();
  f.values.splice(f.ownHooks);
  expect(render().html).toContain("The Cloud is ready");
  f.values = [];
  welcomeShown = true;
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring"), welcomeStepHint("engine")] };
  await mount();
  expect(render().html).toBe("");
  f.state.config.onboarding = { ...f.state.config.onboarding, hintsSeen: [...f.state.config.onboarding.hintsSeen, welcomeStepHint("files"), CLOUD_WELCOME_DONE] };
  welcomeShown = false;
  render(); for (const effect of f.effects) effect();
  f.values.splice(f.ownHooks);
  expect(render().html).toBe("");
});
it("on a Cloud set up before the welcome, starts one step in and leads with a first job", async () => {
  setUpBeforeWelcome();
  await mount();
  const { html } = render();
  expect(html).toContain("Set up MausBot Cloud");
  expect(html).toContain("1 of 3 done");
  expect(html).toContain("Give it a first job");
  for (const title of ["Create the Cloud", "Connect your AI"]) expect(html).toContain(title);
  expect(statuses()).toEqual({ cloud: "done", job: "todo", engine: "todo" });
  expect(html).not.toMatch(/workspace|organis/i);
  expect(html).not.toContain('aria-modal="true"');
  expect(html).not.toContain('role="dialog"');
});
it("connecting an AI is done when any engine can run; its action shows the existing sign-in when it is not on screen", async () => {
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN] };
  await mount();
  expect(button("Connect")).toBeUndefined();
  f.state.activeView = "routines";
  button("Connect")!.props.onClick!();
  expect(dispatched).toEqual([{ type: "showChat" }]);
  f.state.instances = [signedOut, ready];
  expect(statuses().engine).toBe("done");
  expect(render().html).toContain("3 of 4 done");
});
it("a first job is done once given or once a turn has finished there, and Give it a job asks the question again", async () => {
  f.state.instances = [ready];
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_INTENT_ASKED] };
  await mount();
  expect(statuses().job).toBe("todo");
  button("Give it a job")!.props.onClick!();
  expect(reopenCloudIntent).toHaveBeenCalledWith(true);
  expect(dispatched).toEqual([{ type: "showChat" }]);
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN] };
  expect(statuses().job).toBe("done");
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, firstTurnAt: "2026-09-30T08:00:00.000Z" };
  f.state.instances = [signedOut];
  expect(statuses()).toMatchObject({ engine: "todo", job: "done" });
});
it("disappears once an engine can run and a bot has finished a turn there", async () => {
  f.state.instances = [ready];
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, firstTurnAt: "2026-09-30T08:00:00.000Z" };
  await mount();
  expect(render().html).toBe("");
});

it("Hide setup is one click, kept in the Cloud's own settings", async () => {
  await mount();
  button("Hide setup")!.props.onClick!(); await flush();
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [CLOUD_SETUP_HIDDEN] } }) });
  expect(dispatched).toContainEqual({ type: "configStatus", config: expect.objectContaining({ onboarding: expect.objectContaining({ hintsSeen: [CLOUD_SETUP_HIDDEN] }) }) });
  expect(render().html).not.toContain("data-cloud-setup");
  f.values = []; f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_SETUP_HIDDEN] };
  await mount();
  expect(render().html).toBe("");
});

it("minimizes to its progress on this device, and opens again", async () => {
  setUpBeforeWelcome();
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem });
  await mount();
  const toggle = () => render().nodes.find(node => node.type === "button" && (node.props as Record<string, unknown>)["aria-controls"] === "cloud-setup-body")!.props.onClick!();
  toggle();
  let { html } = render();
  expect(html).toContain("1 of 3 done");
  expect(html).not.toContain("Give it a first job");
  expect(button("Hide setup")).toBeUndefined();
  expect(setItem).toHaveBeenLastCalledWith("omb.cloudSetup.collapsed", "1");
  expect(api).not.toHaveBeenCalledWith("/api/config", expect.anything());
  toggle();
  ({ html } = render());
  expect(html).toContain("Give it a first job");
  expect(setItem).toHaveBeenLastCalledWith("omb.cloudSetup.collapsed", "0");
});

it("says the Cloud is ready once, in the session that finished it", async () => {
  setUpBeforeWelcome();
  f.state.instances = [ready];
  await mount();
  expect(render().html).toContain("Set up MausBot Cloud");
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_INTENT_ASKED], firstTurnAt: "2026-09-30T08:00:00.000Z" };
  render(); for (const effect of f.effects) effect();
  // The mocked hooks are one list across components: the finale is a new child, so it starts fresh.
  f.values.splice(f.ownHooks);
  const { html } = render();
  expect(html).toContain("The Cloud is ready");
  expect(html).not.toContain("Set up MausBot Cloud");
});

it("fills its progress from the left by how many steps are done, whichever they are, and picking a step does not move it", async () => {
  setUpBeforeWelcome(CLOUD_INTENT_GIVEN);
  await mount();
  const filled = () => render().nodes
    .filter(node => String((node.props as { className?: string }).className ?? "").includes("progress-fill"))
    .map(node => (node.props as Record<string, unknown>)["data-filled"] === "");
  expect(statuses()).toEqual({ cloud: "done", job: "done", engine: "todo", plan: "todo" });
  expect(filled()).toEqual([true, true, false, false]);
  expect(render().html).toContain('aria-valuenow="2"');
  expand("Approve its plan");
  expect(filled()).toEqual([true, true, false, false]);
});

// These send a first job, which stays sent in the module's store: keep them last.
it("counts a job as given the moment it is sent, before the Cloud's record answers, so nothing flickers", async () => {
  setUpBeforeWelcome();
  f.state.instances = [ready];
  markIntentSent("b1");
  await mount();
  expect(statuses()).toMatchObject({ job: "done", engine: "done", plan: "todo" });
  expect(render().html).toContain("Approve its plan");
});

it("opens the chat the job went to as the bot's row does: with threads hidden at its main thread, not where an activity row left it", async () => {
  setUpBeforeWelcome();
  f.state.instances = [ready];
  markIntentSent("b1");
  f.state.activeView = "routines";
  f.state.bots = [{ id: "b1", threadId: "t1", mainThreadId: "main", name: "Maus",
    tasks: [{ threadId: "t1", title: "Routine report", createdAt: 1 }, { threadId: "main", title: "Set up", createdAt: 2 }] }];
  await mount();
  button("Open the chat")!.props.onClick!();
  expect(dispatched).toEqual([{ type: "showChat" }, { type: "select", id: "b1" }]);
  dispatched.length = 0;
  f.showThreads = false;
  button("Open the chat")!.props.onClick!();
  expect(dispatched).toEqual([{ type: "showChat" }, { type: "switchTask", botId: "b1", threadId: "main" }]);
});

it("is ready only once the job's routine exists, not when the bot's first turn asks its questions, and offers to run it now", async () => {
  f.state.instances = [ready];
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN], firstTurnAt: "2026-10-06T08:00:00.000Z" };
  f.state.routines = [];
  await mount();
  expect(render().html).toContain("Set up MausBot Cloud");
  expect(statuses().plan).toBe("todo");
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  f.state.routines = [{ id: "r1", name: "Morning news digest", botId: "b1", createdAt: Date.now(), nextRunAt: tomorrow.getTime() }];
  render(); for (const effect of f.effects) effect();
  f.values.splice(f.ownHooks);
  const { html } = render();
  expect(html).toContain("The Cloud is ready");
  expect(html).toContain("Morning news digest");
  expect(html).toContain("runs tomorrow at");
  expect(html).toContain("Run it now");
});
