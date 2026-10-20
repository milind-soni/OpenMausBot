// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../../electron/cloud-move.mjs";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  state: {} as any,
  dispatch: vi.fn(),
  api: vi.fn(),
  plan: null as any,
  imported: null as null | (() => void),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: vi.fn() }),
  api: fixture.api,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/components/CloudTrialNotice", () => ({ useCloudPlanSnapshot: () => fixture.plan }));
// The sign-in cards and the team library have their own tests.
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance }: { instance: { instanceId: string } }) => h("div", { "data-engine-setup": instance.instanceId }) };
});
vi.mock("@/components/TeamLibraryPanel", async () => {
  const { createElement: h } = await import("react");
  return { TeamLibraryPanel: ({ onImported }: { onImported: () => void }) => { fixture.imported = onImported; return h("div", { "data-team-library": "" }); } };
});
import { CloudWelcome } from "./CloudWelcome";
import { CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, CLOUD_WELCOME_SHOWN as SHOWN, welcomeStepHint } from "@/lib/cloud-setup";
import { resetCloudWelcome, useCloudWelcome } from "@/lib/cloud-welcome";
import { setOneWorkspaceForTests } from "@/lib/one-workspace";

const local = { bots: 6, rooms: 1, chats: 142, bytes: 1.2 * 1024 ** 3, files: 900, routines: 4 };
const emptyCloud = { contents: { bots: 1, rooms: 0, chats: 0 }, empty: true, freeBytes: 9 * 1024 ** 3, previous: null, heldBytes: 0 };
const CLOUD = { id: "cloud", name: "Studio Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev", kind: "cloud" as const };
const overview = (extra: Partial<CloudMoveOverview> = {}): CloudMoveOverview => ({
  phase: "idle", local, cloud: emptyCloud, suggest: true, destination: CLOUD, blocked: null, fit: { fit: "now", neededBytes: 1, freeBytes: 2 }, ...extra,
});
const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] } };
const codex = { ...claude, instanceId: "codex", driverKind: "codex", displayName: "Codex" };
const credit = { instanceId: "trial", driverKind: "openai-compat", displayName: "Trial credit · Claude", readOnly: true, trialCredit: "active", snapshot: { state: "available" }, models: { default: "", options: [] } };

let host: HTMLDivElement;
let root: Root;
let bridge: CloudMoveBridge;
let push: (state: CloudMoveState) => void;
let lending: { open: ReturnType<typeof vi.fn> };
const welcome = { current: null as ReturnType<typeof useCloudWelcome> | null };
function Probe() { welcome.current = useCloudWelcome(); return null; }
const render = () => flushSync(() => root.render([createElement(CloudWelcome, { key: "welcome" }), createElement(Probe, { key: "probe" })]));
const text = () => host.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no button "${label}" in: ${text()}`);
  flushSync(() => target.click());
};
const hintsPut = () => fixture.api.mock.calls.filter(([path, init]) => path === "/api/config" && JSON.parse(String(init.body)).onboarding)
  .map(([, init]) => JSON.parse(String(init.body)).onboarding.hintsSeen as string[]);
const sent = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "send");

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  resetCloudWelcome();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
  fixture.plan = null;
  fixture.imported = null;
  fixture.state = {
    connected: true, selectedId: "b1", activeView: "chat", routines: [], groups: [],
    bots: [{ id: "b1", threadId: "t1", name: "Maus" }, { id: "b2", threadId: "t2", name: "Ada", chiefOfStaff: true }],
    instances: [claude, codex],
    config: { cloudHome: true, onboarding: { ...EMPTY_ONBOARDING }, profile: { name: "", email: "", aboutMe: "" } },
  };
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body ?? "{}"));
    if (patch.onboarding) return { ...fixture.state.config, onboarding: { ...fixture.state.config.onboarding, ...patch.onboarding } };
    throw new Error(`unexpected ${path}`);
  });
  push = () => {};
  bridge = {
    state: vi.fn().mockResolvedValue(overview()), start: vi.fn().mockResolvedValue({ phase: "preparing" }), cancel: vi.fn().mockResolvedValue({ phase: "failed" }),
    restorePrevious: vi.fn(), bring: vi.fn(), dismiss: vi.fn().mockResolvedValue(overview({ suggest: false })),
    onState: vi.fn((callback) => { push = callback; return () => {}; }),
  };
  lending = { open: vi.fn().mockResolvedValue(undefined) };
  window.ogb = {
    platform: "darwin", cloudMove: bridge, cloudLending: lending,
    workspaces: { state: vi.fn().mockResolvedValue({ local: false, name: "Studio Cloud", origin: CLOUD.origin }), menu: vi.fn() },
  } as unknown as typeof window.ogb;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete window.ogb;
  vi.unstubAllGlobals();
});

describe("CloudWelcome", () => {
  it("opens on bringing this computer's stuff, before any chat: the copy is offered with this Mac's counts", async () => {
    render();
    await vi.waitFor(() => expect(text()).toContain("Welcome to Studio Cloud"));
    await vi.waitFor(() => expect(text()).toContain("142 chats"));
    expect(text()).toContain("What should Studio Cloud start with?");
    for (const line of ["Everything from this Mac", "6 bots", "4 routines", "1.2 GB", "Sign-ins and keys stay on this Mac. Routines arrive paused so nothing runs twice."]) {
      expect(text()).toContain(line);
    }
    expect(host.querySelector('[data-bring-choice="copy"]')!.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[aria-current="step"]')!.getAttribute("data-welcome-rail")).toBe("bring");
    expect(button("Copy to Studio Cloud")).toBeDefined();
    expect(text()).not.toContain("Also bring in");
    expect([...document.body.querySelectorAll("button")].map((node) => node.textContent?.trim())).toEqual([
      "1Bring your stuffYour bots and chats (Not done yet)", "2Connect your AIClaude or ChatGPT (Not done yet)", "3Files and appsOptional (Not done yet)",
      "Skip setup", expect.stringContaining("Everything from this Mac"), expect.stringContaining("Start fresh"), "Copy to Studio Cloud", "Skip for now",
    ]);
    expect(sent()).toEqual([]);
    expect(hintsPut()).toEqual([[SHOWN]]);
  });

  it("notes the first time it shows, so a chat before its first step does not end it, and only once", () => {
    render();
    expect(hintsPut()).toEqual([[SHOWN]]);
    flushSync(() => root.unmount());
    root = createRoot(host);
    resetCloudWelcome();
    fixture.api.mockClear();
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [SHOWN] };
    render();
    expect(hintsPut()).toEqual([]);
  });

  it("copies with the existing copy, holds the choices while it runs, and after it lands moves on to the AI", async () => {
    render();
    await vi.waitFor(() => expect(button("Copy to Studio Cloud")?.disabled).toBe(false));
    click("Copy to Studio Cloud");
    expect(bridge.start).toHaveBeenCalledOnce();
    flushSync(() => push({ phase: "uploading", action: "move", destination: CLOUD, progress: { bytesTransferred: 1, totalBytes: 4 } }));
    expect(text()).toContain("Uploading to Studio Cloud");
    expect(host.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("25");
    expect((host.querySelector('[data-bring-choice="fresh"]') as HTMLButtonElement).disabled).toBe(true);
    flushSync(() => push({ phase: "done", action: "move", destination: CLOUD, moved: { bots: 6, rooms: 1, chats: 142 }, routines: 4 }));
    await vi.waitFor(() => expect(text()).toContain("Copied 6 bots and 142 chats to Studio Cloud."));
    expect(text()).toContain("Routines arrive paused: 4 were on here.");
    expect(host.querySelector('[data-welcome-rail="bring"]')!.hasAttribute("data-finished")).toBe(true);
    click("Continue");
    expect(bridge.dismiss).toHaveBeenCalledOnce();
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring")]);
    expect(text()).toContain("Your bots think with your own Claude or ChatGPT plan. Sign in once on Studio Cloud.");
    expect(document.activeElement?.id).toBe("cloud-welcome-step");
    expect(sent()).toEqual([]);
  });

  it("after the copy lands and the window opens the Cloud again, still says what came over, though the Cloud is no longer empty", async () => {
    vi.mocked(bridge.state).mockResolvedValue(overview({
      phase: "done", action: "move", moved: { bots: 6, rooms: 1, chats: 142 }, routines: 4, suggest: false,
      cloud: { ...emptyCloud, contents: { bots: 6, rooms: 1, chats: 142 }, empty: false },
    }));
    render();
    await vi.waitFor(() => expect(text()).toContain("Copied 6 bots and 142 chats to Studio Cloud."));
    expect(host.querySelector('[data-bring-choice="copy"]')!.getAttribute("aria-checked")).toBe("true");
    click("Continue");
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring")]);
  });

  it("on a Cloud that already has bots or chats, says they are already here instead of offering a copy or a fresh start", async () => {
    vi.mocked(bridge.state).mockResolvedValue(overview({ suggest: false, cloud: { ...emptyCloud, contents: { bots: 6, rooms: 1, chats: 142 }, empty: false } }));
    render();
    await vi.waitFor(() => expect(text()).toContain("Studio Cloud already has bots or chats of its own, so nothing is copied over them from here."));
    expect(text()).toContain("Your bots are already here");
    expect(host.querySelector("[data-bring-choice]")).toBeNull();
    expect(button("Choose a team")).toBeUndefined();
    click("Continue");
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.dismiss).not.toHaveBeenCalled();
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring")]);
    expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull();
  });

  it("outside the desktop app, tells the same from the bots and rooms the Cloud shows", () => {
    delete window.ogb;
    fixture.state = { ...fixture.state, bots: [...fixture.state.bots, { id: "b3", threadId: "t3", name: "Rex" }] };
    render();
    expect(text()).toContain("Your bots are already here");
    expect(text()).not.toContain("Open the desktop app to bring your bots from your computer.");
  });

  it("starting fresh opens the team library, and skipping keeps the copy's card from coming back", async () => {
    render();
    await vi.waitFor(() => expect(text()).toContain("142 chats"));
    flushSync(() => (host.querySelector('[data-bring-choice="fresh"]') as HTMLButtonElement).click());
    click("Choose a team");
    expect(host.querySelector("[data-team-library]")).not.toBeNull();
    flushSync(() => fixture.imported!());
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring")]);
    expect(bridge.dismiss).not.toHaveBeenCalled();
    expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull();
    flushSync(() => root.unmount());
    root = createRoot(host);
    resetCloudWelcome();
    fixture.api.mockClear();
    render();
    await vi.waitFor(() => expect(text()).toContain("142 chats"));
    click("Skip for now");
    expect(bridge.dismiss).toHaveBeenCalledOnce();
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring"), CLOUD_SETUP_MOVE_SKIPPED]);
  });

  it("in a desktop app connected to another server as its client, offers no copy from here either", () => {
    window.ogb = { ...window.ogb!, remoteClient: { active: true } } as unknown as typeof window.ogb;
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    expect(text()).toContain("Open the desktop app to bring your bots from your computer.");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(bridge.state).not.toHaveBeenCalled();
  });

  it("outside the desktop app, starts fresh and says where the copy is", () => {
    delete window.ogb;
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    expect(text()).toContain("Welcome to My Cloud");
    expect(text()).toContain("Open the desktop app to bring your bots from your computer.");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(button("Choose a team")).toBeDefined();
    expect([...host.querySelectorAll("button")].some((node) => node.textContent?.startsWith("Copy to"))).toBe(false);
  });

  it("resumes where it was left, and offers the trial's credit for now", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    fixture.state.instances = [claude, codex, credit];
    fixture.plan = { status: "paid", credit: { grantedUsd: 5, remainingUsd: 5, state: "active" } };
    render();
    expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull();
    expect(host.querySelector('[data-welcome-rail="bring"]')!.hasAttribute("data-finished")).toBe(true);
    expect(text()).toContain("You have $5 of Claude credit, so your bots can start right now.");
    for (const tile of ["claude", "codex"]) expect(host.querySelector(`[data-cloud-choice="${tile}"]`)).not.toBeNull();
    click("Use my credit for now");
    expect(hintsPut().at(-1)).toEqual([welcomeStepHint("bring"), SHOWN, welcomeStepHint("engine")]);
    expect(host.querySelector('[data-welcome-step="files"]')).not.toBeNull();
  });

  it("says Connected on an AI signed in here, and leaves the credit out once it is", () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    fixture.state.instances = [{ ...claude, snapshot: { state: "available", authenticated: true } }, codex, credit];
    render();
    expect(host.querySelector('[data-cloud-choice="claude"]')!.hasAttribute("data-connected")).toBe(true);
    expect(text()).not.toContain("Claude credit");
    click("Continue");
    expect(host.querySelector('[data-welcome-step="files"]')).not.toBeNull();
  });

  it("right after an AI is connected here, checks it with one tiny real message and says it works, or what to fix", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    fixture.state.instances = [claude, codex, credit];
    const checks: string[] = [];
    let answer: Record<string, unknown> = { ok: true };
    const config = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      const check = /^\/api\/instances\/([\w.-]+)\/check$/.exec(path);
      if (!check) return config(path, init);
      checks.push(check[1]!);
      return answer;
    });
    render();
    // Already connected or not, nothing is checked until one is connected here.
    expect(checks).toEqual([]);
    fixture.state = { ...fixture.state, instances: [{ ...claude, snapshot: { state: "available", authenticated: true } }, codex, credit] };
    render();
    await vi.waitFor(() => expect(text()).toContain("Claude is working"));
    expect(checks).toEqual(["claude"]);
    expect(host.querySelector('[data-engine-check="working"]')).not.toBeNull();
    answer = { ok: false, error: "ChatGPT isn't signed in on this computer anymore. Sign in again, then check again." };
    fixture.state = { ...fixture.state, instances: [{ ...claude, snapshot: { state: "available", authenticated: true } }, { ...codex, snapshot: { state: "available", authenticated: true } }, credit] };
    render();
    await vi.waitFor(() => expect(host.querySelector('[data-engine-check="failed"]')).not.toBeNull());
    expect(text()).toContain("ChatGPT is connected but didn't answer a test message. ChatGPT isn't signed in on this computer anymore. Sign in again, then check again.");
    answer = { ok: true };
    click("Test again");
    await vi.waitFor(() => expect(host.querySelectorAll('[data-engine-check="working"]')).toHaveLength(2));
    expect(checks).toEqual(["claude", "codex", "codex"]);
  });

  it("files and apps open this computer's Files and Connected apps, then it is ready and says hi to the Chief of Staff", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring"), welcomeStepHint("engine")] };
    render();
    await vi.waitFor(() => expect(text()).toContain("Welcome to Studio Cloud"));
    click("Open on this computer");
    expect(lending.open).toHaveBeenCalledOnce();
    click("Connect apps");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
    click("Finish");
    expect(text()).toContain("Studio Cloud is ready");
    expect(text()).toContain("Your bots now run 24/7. Close your laptop whenever you like.");
    fixture.dispatch.mockClear();
    click("Say hi to your Chief of Staff");
    expect(hintsPut().at(-1)).toContain(CLOUD_WELCOME_DONE);
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "showChat" }, { type: "select", id: "b2" }]);
    expect(welcome.current!.ended).toBe(true);
  });

  it("with all bots together, greets a bot made on My Cloud rather than a copy of this computer's; with only copies, it opens this computer's", async () => {
    const roster = (id: string, name: string) => ({ id, threadId: `t-${id}`, name, title: "", color: "blue", avatarUrl: null, unread: false });
    const together = { page: "cloud" as const, twinHome: "computer" as const, cloudName: "Studio Cloud",
      other: { side: "computer" as const, state: "ready" as const, at: 1, bots: [roster("b1", "Maus"), roster("b2", "Ada")], rooms: [], sections: [] } };
    const open = vi.fn(async () => {});
    window.ogb = { ...window.ogb, oneWorkspace: { open, view: async () => together, onView: () => () => {}, take: async () => null } } as unknown as typeof window.ogb;
    setOneWorkspaceForTests({ view: together });
    try {
      fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring"), welcomeStepHint("engine"), welcomeStepHint("files")] };
      fixture.state.bots = [...fixture.state.bots, { id: "b3", threadId: "t3", name: "Clover" }];
      render();
      await vi.waitFor(() => expect(text()).toContain("Studio Cloud is ready"));
      expect(button("Say hi to your Chief of Staff")).toBeUndefined();
      fixture.dispatch.mockClear();
      click("Say hi to Clover");
      expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "showChat" }, { type: "select", id: "b3" }]);
      expect(open).not.toHaveBeenCalled();

      flushSync(() => root.unmount());
      root = createRoot(host);
      resetCloudWelcome();
      fixture.state.bots = fixture.state.bots.filter((bot: { id: string }) => bot.id !== "b3");
      render();
      await vi.waitFor(() => expect(text()).toContain("Studio Cloud is ready"));
      fixture.dispatch.mockClear();
      click("Say hi to your Chief of Staff");
      expect(open).toHaveBeenCalledWith({ side: "computer", id: "b2" });
      expect(fixture.dispatch.mock.calls.map(([action]) => action).some((action) => action.type === "select")).toBe(false);
    } finally {
      setOneWorkspaceForTests(null);
    }
  });

  it("Skip setup ends it for good, and picking a bot in the sidebar only steps it aside", () => {
    render();
    fixture.state = { ...fixture.state, selectedId: "b2" };
    render();
    expect(welcome.current!.aside).toBe(true);
    expect(hintsPut()).toEqual([[SHOWN]]);
    click("Skip setup");
    expect(hintsPut().at(-1)).toEqual([SHOWN, CLOUD_WELCOME_DONE]);
    expect(welcome.current!.ended).toBe(true);
  });
});
