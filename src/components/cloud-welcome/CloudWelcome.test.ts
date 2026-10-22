// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSendNotice } from "../../../electron/cloud-send.mjs";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { setLocale } from "@/lib/i18n";
import { ADVANCED_MODE_KEY } from "@/lib/interface-mode";

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
  return { EngineSetup: ({ instance, description }: { instance: { instanceId: string }; description?: string }) =>
    h("div", { "data-engine-setup": instance.instanceId, "data-description": description }) };
});
vi.mock("@/components/TeamLibraryPanel", async () => {
  const { createElement: h } = await import("react");
  return { TeamLibraryPanel: ({ onImported }: { onImported: () => void }) => { fixture.imported = onImported; return h("div", { "data-team-library": "" }); } };
});
import { CloudWelcome, sentHere } from "./CloudWelcome";
import { CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, CLOUD_WELCOME_SHOWN as SHOWN, welcomeStepHint } from "@/lib/cloud-setup";
import { resetCloudWelcome, useCloudWelcome } from "@/lib/cloud-welcome";

const CLOUD = { name: "Studio Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev" };
const quiet: CloudSendNotice = { ready: true, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null, whole: null };
const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", authentication: { method: "paste-code" }, snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] } };
const codex = { ...claude, instanceId: "codex", driverKind: "codex", displayName: "Codex" };
const credit = { instanceId: "trial", driverKind: "openai-compat", displayName: "Trial credit · Claude", readOnly: true, trialCredit: "active", snapshot: { state: "available" }, models: { default: "", options: [] } };

let host: HTMLDivElement;
let root: Root;
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
  lending = { open: vi.fn().mockResolvedValue(undefined) };
  window.ogb = {
    platform: "darwin", cloudLending: lending,
    cloudSendPage: { notice: vi.fn().mockResolvedValue(quiet), dismiss: vi.fn(), onNotice: vi.fn(() => () => {}) },
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
  it("opens on bringing this computer's stuff, before any chat: a fresh start, with nothing to copy by hand", async () => {
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    await vi.waitFor(() => expect(text()).toContain("What should Studio Cloud start with?"));
    expect(text()).toContain("Welcome to Studio Cloud");
    expect(text()).toContain("Bots on your computer come here by themselves from the OpenMausBot app.");
    expect(host.querySelector('[data-bring-choice="fresh"]')).not.toBeNull();
    expect(host.querySelector("[data-bring-desktop]"), "this is the desktop app already").toBeNull();
    expect(host.querySelector("[data-bring-update]")).toBeNull();
    expect(host.querySelector('[aria-current="step"]')!.getAttribute("data-welcome-rail")).toBe("bring");
    expect([...document.body.querySelectorAll("button")].map((node) => node.textContent?.trim())).toEqual([
      "1Bring your stuffYour bots and chats (Not done yet)", "2Connect your AIClaude or ChatGPT (Not done yet)", "3Files and appsOptional (Not done yet)",
      "Skip setup", "Continue",
    ]);
    expect(sent()).toEqual([]);
    expect(hintsPut()).toEqual([[SHOWN]]);
  });

  it("in an older app that still copies by hand, says to update it to bring the bots here by itself", async () => {
    fixture.state.bots = [fixture.state.bots[0]];
    window.ogb = { ...window.ogb!, cloudMove: {} } as unknown as typeof window.ogb;
    render();
    await vi.waitFor(() => expect(host.querySelector("[data-bring-update]")?.textContent).toBe("Update OpenMausBot to bring your bots here by itself."));
    expect([...host.querySelectorAll("button")].some((node) => node.textContent?.startsWith("Copy"))).toBe(false);
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

  it("on a Cloud that already has bots or chats, says they are already here instead of offering a fresh start", async () => {
    fixture.state = { ...fixture.state, groups: [{ id: "g1", name: "Launch" }] };
    render();
    await vi.waitFor(() => expect(text()).toContain("Studio Cloud already has bots or chats of its own."));
    expect(text()).toContain("Your bots are already here");
    expect(host.querySelector("[data-bring-choice]")).toBeNull();
    expect(button("Choose a team")).toBeUndefined();
    click("Continue");
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

  it("in Advanced mode, starting fresh opens the team library, and skipping is kept as skipped", async () => {
    localStorage.setItem(ADVANCED_MODE_KEY, "1");
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    await vi.waitFor(() => expect(button("Choose a team")).toBeDefined());
    click("Choose a team");
    expect(host.querySelector("[data-team-library]")).not.toBeNull();
    flushSync(() => fixture.imported!());
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring")]);
    expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull();
    flushSync(() => root.unmount());
    root = createRoot(host);
    resetCloudWelcome();
    fixture.api.mockClear();
    render();
    await vi.waitFor(() => expect(button("Skip for now")).toBeDefined());
    click("Skip for now");
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring"), CLOUD_SETUP_MOVE_SKIPPED]);
  });

  it("in Simple mode, starting fresh starts with the assistant: no team to choose, one Continue", async () => {
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    await vi.waitFor(() => expect(text()).toContain("Start with your assistant. It brings in specialists when a job needs them."));
    expect(text()).not.toContain("ready-made team");
    expect(button("Choose a team")).toBeUndefined();
    click("Continue");
    expect(host.querySelector("[data-team-library]")).toBeNull();
    expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring"), CLOUD_SETUP_MOVE_SKIPPED]);
  });

  it("in a desktop app connected to another server as its client, offers no copy from here either", () => {
    window.ogb = { ...window.ogb!, remoteClient: { active: true } } as unknown as typeof window.ogb;
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    expect(text()).toContain("Open the desktop app to bring your bots from your computer.");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("outside the desktop app, starts fresh and says where the copy is", () => {
    delete window.ogb;
    fixture.state.bots = [fixture.state.bots[0]];
    render();
    expect(text()).toContain("Welcome to My Cloud");
    expect(text()).toContain("Open the desktop app to bring your bots from your computer.");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(button("Choose a team")).toBeUndefined();
    expect(button("Continue")).toBeDefined();
    expect([...host.querySelectorAll("button")].some((node) => node.textContent?.startsWith("Copy to"))).toBe(false);
  });

  it("resumes where it was left, and with the trial's credit goes straight past the AI step", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    fixture.state.instances = [claude, codex, credit];
    fixture.plan = { status: "paid", credit: { grantedUsd: 5, remainingUsd: 5, state: "active" } };
    render();
    await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="files"]')).not.toBeNull());
    expect(host.querySelector('[data-welcome-rail="bring"]')!.hasAttribute("data-finished")).toBe(true);
    expect(hintsPut().at(-1)).toEqual(expect.arrayContaining([welcomeStepHint("bring"), SHOWN, welcomeStepHint("engine")]));
    expect(host.querySelector("[data-cloud-choice]")).toBeNull();
  });

  it("uses an AI already signed in here as it is: the AI step finishes itself", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    fixture.state.instances = [{ ...claude, snapshot: { state: "available", authenticated: true } }, codex];
    render();
    await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="files"]')).not.toBeNull());
    expect(hintsPut().at(-1)).toEqual(expect.arrayContaining([welcomeStepHint("engine")]));
  });

  it("with no AI working, leads with the Claude sign-in and folds the other ways under it", () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    render();
    expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull();
    expect(host.querySelector('[data-welcome-recommended="claude"] [data-engine-setup="claude"]')?.getAttribute("data-description"), "one plain line, not the setup's own")
      .toBe("Use the Claude account you already have. You sign in on their own website, so your password stays with them.");
    expect(host.querySelector("[data-cloud-choice]")).toBeNull();
    fixture.state.instances = [{ ...claude, authentication: undefined }, codex];
    render();
    expect(host.querySelector('[data-welcome-recommended="claude"] [data-engine-setup="claude"]')?.hasAttribute("data-description"), "a sign-in finished in Terminal keeps its own instructions")
      .toBe(false);
    click("Other ways");
    expect(host.querySelector('[data-cloud-choice="codex"]')).not.toBeNull();
    expect(host.querySelector('[data-cloud-choice="claude"]'), "the recommended way is not offered twice").toBeNull();
    expect(host.querySelector('[data-cloud-choice="api-key"]')).not.toBeNull();
    click("Skip for now");
    expect(host.querySelector('[data-welcome-step="files"]')).not.toBeNull();
  });

  it("right after an AI is connected here, checks it with one tiny real message and says it works, or what to fix", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring")] };
    fixture.state.instances = [claude, codex];
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
    click("Other ways");
    // Already connected or not, nothing is checked until one is connected here.
    expect(checks).toEqual([]);
    fixture.state = { ...fixture.state, instances: [{ ...claude, snapshot: { state: "available", authenticated: true } }, codex] };
    render();
    await vi.waitFor(() => expect(text()).toContain("Claude is working"));
    expect(checks).toEqual(["claude"]);
    expect(host.querySelector('[data-engine-check="working"]')).not.toBeNull();
    answer = { ok: false, error: "ChatGPT isn't signed in on this computer anymore. Sign in again, then check again." };
    fixture.state = { ...fixture.state, instances: [{ ...claude, snapshot: { state: "available", authenticated: true } }, { ...codex, snapshot: { state: "available", authenticated: true } }] };
    render();
    await vi.waitFor(() => expect(host.querySelector('[data-engine-check="failed"]')).not.toBeNull());
    expect(text()).toContain("ChatGPT is connected but didn't answer a test message. ChatGPT isn't signed in on this computer anymore. Sign in again, then check again.");
    answer = { ok: true };
    click("Test again");
    await vi.waitFor(() => expect(host.querySelectorAll('[data-engine-check="working"]')).toHaveLength(2));
    expect(checks).toEqual(["claude", "codex", "codex"]);
  });

  it("on My Cloud once it is home, the folders card names no other app on this computer: My Cloud's own Settings say what is shared", async () => {
    fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [welcomeStepHint("bring"), welcomeStepHint("engine")] };
    fixture.plan = { status: "paid", tier: "pro", home: true };
    render();
    await vi.waitFor(() => expect(text()).toContain("Welcome to Studio Cloud"));
    const folders = host.querySelector('[data-welcome-files="folders"]')?.textContent ?? "";
    expect(folders).toContain("Bots on Studio Cloud can read the folders your computer shares, while it's on. See what it shares in Settings.");
    expect(folders).not.toMatch(/this computer/iu);
    click("Open Settings");
    expect(lending.open).toHaveBeenCalledOnce();
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
  describe("when this computer's things come over (the move, or Send everything)", () => {
    const counts = { bots: 4, updatedBots: 0, skills: 2, logins: 2, onePassword: true, settings: 1, chats: { conversations: 3, messages: 10 } };
    const sentLast = (extra: Record<string, unknown> = {}) => ({ at: 1, reason: "move", failed: 0, seen: false, sent: counts, ...extra }) as NonNullable<CloudSendNotice["last"]>;
    const notice = (extra: Partial<CloudSendNotice> = {}): CloudSendNotice => ({
      ready: true, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false,
      running: false, last: null, whole: null, ...extra,
    });
    let pushNotice: (value: CloudSendNotice) => void = () => {};
    const withSend = (value: CloudSendNotice | null) => {
      const page = { notice: vi.fn().mockResolvedValue(value), dismiss: vi.fn(),
        onNotice: vi.fn((listener: (next: CloudSendNotice) => void) => { pushNotice = listener; return () => {}; }) };
      window.ogb = { ...window.ogb!, cloudSendPage: page } as unknown as typeof window.ogb;
      return page;
    };
    const rail = () => host.querySelector('[data-welcome-rail="bring"]')!;

    it("says what came over only after a whole send went through, and keeps the choice while nothing is coming", () => {
      const state = (value: CloudSendNotice | null) => sentHere(value)?.state ?? null;
      expect(state(null)).toBeNull();
      expect(state({ ...notice(), whole: undefined } as unknown as CloudSendNotice), "a desktop too old to say keeps its choice").toBeNull();
      expect(state(notice()), "nothing sent and nothing on its way").toBeNull();
      expect(state(notice({ running: true, runningReason: "move" }))).toBe("sending");
      expect(state(notice({ running: true, runningReason: "button" }))).toBe("sending");
      expect(state(notice({ last: sentLast() }))).toBe("sent");
      expect(state(notice({ last: sentLast({ reason: "button" }) }))).toBe("sent");
      expect(state(notice({ last: sentLast({ error: "This app could not sign in to My Cloud. Try again." }) })), "a send that failed as a whole").toBeNull();
      expect(state(notice({ last: sentLast({ reason: "logins" }) })), "one login sent by hand").toBeNull();
      expect(state(notice({ running: true, runningReason: "logins" }))).toBeNull();
      // An older desktop that sends by itself: its first send, its later ones, and nothing gone yet while its switch is on.
      for (const older of ["first", "auto"]) expect(state(notice({ last: sentLast({ reason: older }) })), older).toBe("sent");
      expect(state(notice({ running: true, runningReason: "first" }))).toBe("sending");
      expect(state({ ...notice(), auto: true }), "its switch on, nothing gone yet: on its way").toBe("sending");
      expect(state({ ...notice({ last: sentLast({ reason: "logins" }) }), auto: true })).toBe("sending");
    });

    it("started fresh while nothing came over (moves not on yet), Bring your stuff shows as skipped, never done, until things do come over", async () => {
      // Seen in the real app on Oct 22: with moves off, Continue on a new Cloud ticked Bring your stuff though nothing came.
      withSend(notice());
      fixture.state.bots = [fixture.state.bots[0]];
      render();
      await vi.waitFor(() => expect(button("Continue")).toBeDefined());
      click("Continue");
      await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull());
      expect(rail().hasAttribute("data-finished")).toBe(false);
      expect(rail().hasAttribute("data-skipped")).toBe(true);
      expect(rail().textContent).toBe("Bring your stuffYour bots and chats (Skipped)");
      flushSync(() => pushNotice(notice({ running: true, runningReason: "move" })));
      await vi.waitFor(() => expect(rail().hasAttribute("data-bringing")).toBe(true));
      flushSync(() => pushNotice(notice({ last: sentLast() })));
      await vi.waitFor(() => expect(rail().hasAttribute("data-finished")).toBe(true));
      expect(rail().hasAttribute("data-skipped")).toBe(false);

      // Opened again later, with nothing come over: still skipped.
      flushSync(() => root.unmount());
      root = createRoot(host);
      resetCloudWelcome();
      withSend(notice());
      fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [SHOWN, welcomeStepHint("bring"), CLOUD_SETUP_MOVE_SKIPPED] };
      render();
      await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull());
      expect([rail().hasAttribute("data-finished"), rail().hasAttribute("data-skipped")]).toEqual([false, true]);
    });

    it("moves straight on to the AI while they come over, ticking Bring your stuff only once they arrived, never taking focus", async () => {
      withSend(notice({ running: true, runningReason: "move" }));
      render();
      await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull());
      expect(rail().hasAttribute("data-finished")).toBe(false);
      expect(rail().hasAttribute("data-bringing")).toBe(true);
      expect(hintsPut()).toEqual([[SHOWN]]);
      expect(text()).not.toContain("What should Studio Cloud start with?");
      expect(document.activeElement?.id, "moving on by itself takes no focus").not.toBe("cloud-welcome-step");
      flushSync(() => pushNotice(notice({ last: sentLast() })));
      await vi.waitFor(() => expect(hintsPut().at(-1)).toEqual([SHOWN, welcomeStepHint("bring")]));
      expect(rail().hasAttribute("data-finished")).toBe(true);
      expect(host.querySelector('[data-welcome-step="engine"]'), "the person stays where they are").not.toBeNull();
    });

    it("back on its step it says in one line what is happening, and in Simple mode offers nothing more to choose", async () => {
      withSend(notice({ last: sentLast() }));
      fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [SHOWN, welcomeStepHint("bring")] };
      render();
      flushSync(() => (rail() as HTMLButtonElement).click());
      await vi.waitFor(() => expect(text()).toContain("came over from This computer."));
      expect(text()).not.toContain("by themselves");
      for (const label of ["More", "Choose a team", "Continue"]) expect(button(label)).toBeUndefined();
    });

    it("back on its step it says in one line what is happening, with a fresh start only behind More in Advanced mode", async () => {
      localStorage.setItem(ADVANCED_MODE_KEY, "1");
      withSend(notice({ running: true, runningReason: "move" }));
      render();
      await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="engine"]')).not.toBeNull());
      flushSync(() => (rail() as HTMLButtonElement).click());
      expect(text()).toContain("Your bots are already here");
      expect(text()).toContain("Bringing this computer's bots, chats and logins here…");
      expect(host.querySelector("[data-bring-choice]")).toBeNull();
      for (const label of ["Continue", "Choose a team", "Skip for now"]) expect(button(label)).toBeUndefined();
      flushSync(() => pushNotice(notice({ last: sentLast() })));
      await vi.waitFor(() => expect(text()).toContain("4 bots, 2 skills, 2 logins, 1Password, your settings, and 3 chats came over from This computer."));
      expect(text()).not.toContain("by themselves");
      expect(host.querySelector('[data-welcome-step="bring"]'), "never moved off a step the person opened").not.toBeNull();
      click("More");
      expect(text()).toContain("Start fresh");
      click("Choose a team");
      expect(host.querySelector("[data-team-library]")).not.toBeNull();
    });

    it("a whole send says what arrived and nothing about more coming", async () => {
      withSend(notice({ last: sentLast({ reason: "button", sent: { ...counts, skills: 0, logins: 0, onePassword: false, settings: 0, chats: null } }) }));
      fixture.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [SHOWN, welcomeStepHint("bring")] };
      render();
      flushSync(() => (rail() as HTMLButtonElement).click());
      await vi.waitFor(() => expect(text()).toContain("4 bots came over from This computer."));
      expect(text()).toContain("Your bots are already here");
      expect(text()).not.toContain("by themselves");
    });

    it("a whole send that failed, a single login sent by hand, or an older desktop keep the fresh start", async () => {
      for (const value of [notice({ last: sentLast({ error: "This app could not sign in to My Cloud. Try again." }) }), notice({ last: sentLast({ reason: "logins" }) }),
        { ...notice({ last: sentLast() }), whole: undefined } as unknown as CloudSendNotice]) {
        flushSync(() => root.unmount());
        root = createRoot(host);
        resetCloudWelcome();
        fixture.api.mockClear();
        fixture.state.bots = [fixture.state.bots[0]];
        withSend(value);
        render();
        await vi.waitFor(() => expect(text()).toContain("What should Studio Cloud start with?"));
        expect(host.querySelector('[data-bring-choice="fresh"]')).not.toBeNull();
        expect(hintsPut()).toEqual([[SHOWN]]);
      }
    });

    it("shows no choice while main has not answered yet, and the choice if it never does", async () => {
      vi.useFakeTimers();
      try {
        const page = withSend(null);
        page.notice.mockReturnValue(new Promise(() => {}));
        render();
        expect(host.querySelector('[data-welcome-step="bring"]')).toBeNull();
        await vi.advanceTimersByTimeAsync(1600);
        expect(host.querySelector('[data-welcome-step="bring"]')).not.toBeNull();
      } finally { vi.useRealTimers(); }
    });
  });
});
