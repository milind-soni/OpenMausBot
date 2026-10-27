// @vitest-environment happy-dom
// Moving through the welcome: one step per press however fast the clicks come, one count for the dots and the counter,
// and a reload that resumes where the person was with what they typed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { welcomeFinishedThisLaunch } from "@/lib/onboarding";
import { readWelcomeDraft, saveWelcomeDraft, WELCOME_DRAFT_KEY } from "@/lib/welcome-draft";
import type { SetupDetection } from "../../../shared/setup-import";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: f.api }));
const analytics = vi.hoisted(() => ({ track: vi.fn(), setEmailGateDone: vi.fn(), identifyEmail: vi.fn() }));
vi.mock("@/lib/analytics", () => analytics);
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }) }));
vi.mock("@/components/EngineSetup", () => ({ EngineSetup: () => null }));
const { WelcomeFlow, STEP_HOLD_MS } = await import("./WelcomeFlow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? "";
const show = async (extra: Record<string, unknown> = {}) => {
  await act(async () => { root.render(createElement(WelcomeFlow, { onDone: vi.fn(), dictation: true, cloudOffer: null, setupImport: null, ...extra })); });
};
const reload = async (extra: Record<string, unknown> = {}) => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await show(extra);
};
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const press = async (label: string) => { await act(async () => { button(label)!.click(); }); };
const settle = async (ms = STEP_HOLD_MS + 50) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const type = async (selector: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const NAME = 'input[type="text"]';
const DRAFT = { name: "" };
const READY_AI = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] } };
const draft = () => readWelcomeDraft();
const putBodies = () => f.api.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(init.body));

// A fresh store per test: Node's own Web Storage (Node 25+) stands in for happy-dom's and keeps nothing without a file.
const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
};
beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  f.dispatch.mockReset();
  f.api.mockReset();
  f.api.mockImplementation(async (path: string, init?: { body?: string }) => (path === "/api/instances" ? { instances: [] } : JSON.parse(init?.body ?? "{}")));
  f.state = { instances: [], config: { profile: { name: "" } }, cloudAdd: null, bots: [] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("moving through the welcome", () => {
  it("moves exactly one step for a double click, and holds Back while the step changes", async () => {
    await show();
    expect(text()).toContain("Step 1 of 3");
    await press("Maybe later");
    expect(text()).toContain("Step 2 of 3");
    expect(button("Back")!.disabled).toBe(true);
    await press("Continue");
    expect(text(), "the second click landed on the new step's Continue").toContain("Step 2 of 3");
    expect(text()).toContain("Connect an AI");
    await settle();
    expect(button("Back")!.disabled).toBe(false);
    await press("Continue");
    expect(text()).toContain("Step 3 of 3");
  });

  it("never finishes the welcome from a click meant for the step before the last", async () => {
    const onDone = vi.fn();
    await show({ onDone, initialBeat: "engines" });
    await press("Continue");
    expect(text()).toContain("Step 3 of 3");
    await press("Continue");
    expect(onDone).not.toHaveBeenCalled();
    await settle();
    await press("Continue");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("shows as many dots as steps, the current one on the step the counter names", async () => {
    await show();
    for (const step of [1, 2, 3]) {
      const dots = [...host.querySelectorAll("[data-step-dot]")];
      expect(dots).toHaveLength(3);
      expect(dots.findIndex((dot) => dot.getAttribute("data-current") === "true")).toBe(step - 1);
      expect(text()).toContain(`Step ${step} of 3`);
      if (step < 3) {
        await press(step === 1 ? "Maybe later" : "Continue");
        await settle();
      }
    }
  });
});

describe("a reload in the middle of the welcome", () => {
  it("resumes on the same step with the name typed", async () => {
    await show();
    await type(NAME, "Ada");
    expect(draft()).toEqual({ beat: "hello", name: "Ada" });
    await reload();
    expect((host.querySelector(NAME) as HTMLInputElement).value).toBe("Ada");
    expect(host.querySelector('input[type="email"]'), "the greeting asks for no email").toBeNull();
    await press("Maybe later");
    expect(draft()).toMatchObject({ beat: "engines", name: "Ada" });
    await reload();
    expect(text()).toContain("Connect an AI");
    expect(text()).toContain("Step 2 of 3");
    await press("Back");
    expect((host.querySelector(NAME) as HTMLInputElement).value).toBe("Ada");
  });

  it("keeps Connect an AI when a working AI shows up after a reload, and Continue goes on to the next step", async () => {
    saveWelcomeDraft({ ...DRAFT, beat: "import" });
    const onDone = vi.fn();
    await show({ onDone });
    expect(text()).toContain("Connect an AI");
    expect(text()).toContain("Step 2 of 3");
    f.state = { ...f.state, instances: [READY_AI] };
    await show({ onDone });
    expect(text(), "the step on screen stays in the count").toContain("Step 2 of 3");
    expect(button("Back")).toBeDefined();
    await press("Continue");
    expect(onDone, "the microphone step is still to come").not.toHaveBeenCalled();
    expect(text()).toContain("Step 3 of 3");
  });

  it("opens on a step that joins late (the import step) once it is offered, or the step before it until then", async () => {
    const found: SetupDetection = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };
    let answer!: (value: SetupDetection) => void;
    const client = { detect: vi.fn(() => new Promise<SetupDetection>((resolve) => { answer = resolve; })), apply: vi.fn() };
    saveWelcomeDraft({ beat: "import", name: "" });
    await show({ setupImport: { client } });
    expect(text()).toContain("Connect an AI");
    await act(async () => { answer(found); });
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(text()).toContain("Bring what you already use");
    expect(text()).toContain("Step 3 of 4");
    await press("Skip");
    expect(text(), "the jump holds clicks like any step change").toContain("Step 3 of 4");
    await settle();
    await press("Skip");
    expect(text()).toContain("Step 4 of 4");
  });

  it("stays where the person is once they have started using the welcome, when the saved step arrives late", async () => {
    const found: SetupDetection = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };
    let answer!: (value: SetupDetection) => void;
    const client = { detect: vi.fn(() => new Promise<SetupDetection>((resolve) => { answer = resolve; })), apply: vi.fn() };
    saveWelcomeDraft({ beat: "import", name: "" });
    await show({ setupImport: { client } });
    await act(async () => { host.querySelector('[role="dialog"]')!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await act(async () => { answer(found); });
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(text()).toContain("Connect an AI");
    expect(text(), "the import step is offered next instead").toContain("Step 2 of 4");
  });

  it("is forgotten once the welcome is finished or skipped, which saves the name", async () => {
    const onDone = vi.fn();
    await show({ onDone });
    await type(NAME, "Ada");
    await press("Skip setup");
    expect(onDone).toHaveBeenCalledOnce();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(putBodies()).toContainEqual({ profile: { name: "Ada" } });
    expect(analytics.identifyEmail, "the welcome never ties analytics to an email").not.toHaveBeenCalled();
    expect(localStorage.getItem(WELCOME_DRAFT_KEY)).toBeNull();
  });

  it("saves the profile once when the greeting is the whole welcome, by Continue or by Maybe later", async () => {
    f.state = { ...f.state, instances: [READY_AI] };
    for (const label of ["Continue", "Maybe later"]) {
      f.api.mockClear();
      const onDone = vi.fn();
      await reload({ dictation: false, onDone });
      await type(NAME, "Ada");
      await press(label);
      await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
      expect(onDone, label).toHaveBeenCalledOnce();
      expect(putBodies().filter((body) => "profile" in body), label).toEqual([{ profile: { name: "Ada" } }]);
    }
  });

  it("sends a profile again on Skip when Continue's save failed", async () => {
    await show();
    await type(NAME, "Ada");
    f.api.mockImplementationOnce(async () => { throw new Error("offline"); });
    await press("Continue");
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(text()).toContain("Couldn't save your details");
    await press("Skip setup");
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(putBodies().filter((body) => "profile" in body)).toEqual([{ profile: { name: "Ada" } }, { profile: { name: "Ada" } }]);
  });

  it("Skip while Continue is still saving waits for that save, and sends the name again if it failed", async () => {
    await show();
    await type(NAME, "Ada");
    let fail!: (error: Error) => void;
    f.api.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await press("Continue");
    await press("Skip setup");
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    const profiles = () => putBodies().filter((body) => "profile" in body);
    expect(profiles(), "nothing sent twice while the first save is on its way").toEqual([{ profile: { name: "Ada" } }]);
    await act(async () => { fail(new Error("offline")); });
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(profiles(), "one retry after the failed save").toEqual([{ profile: { name: "Ada" } }, { profile: { name: "Ada" } }]);
  });

  it("Escape keeps the name too", async () => {
    await show();
    await type(NAME, "Grace");
    await act(async () => { host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(putBodies().filter((body) => "profile" in body)).toEqual([{ profile: { name: "Grace" } }]);
  });

  it("on a hosted workspace, never reads a draft another person left in this browser, and never saves a profile", async () => {
    saveWelcomeDraft({ beat: "hello", name: "Someone Else" });
    const onDone = vi.fn();
    await show({ hosted: true, onDone });
    await press("Continue");
    expect(onDone).toHaveBeenCalledOnce();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(putBodies().filter((body) => "profile" in body), "the shared workspace's profile is left alone").toEqual([]);
    expect(draft(), "nor is the draft touched").toEqual({ beat: "hello", name: "Someone Else" });
  });

  it("marks the welcome finished for this launch, so the Cloud Pro popup waits for the next one; a replay or the preview does not", async () => {
    await show();
    expect(welcomeFinishedThisLaunch()).toBe(false);
    for (const extra of [{ replay: true }, { embedded: true }]) {
      await reload(extra);
      await press("Skip setup");
      expect(welcomeFinishedThisLaunch(), JSON.stringify(extra)).toBe(false);
    }
    await reload();
    await press("Skip setup");
    expect(welcomeFinishedThisLaunch()).toBe(true);
  });

  it("is neither read nor written by a replay from Settings or by the preview", async () => {
    saveWelcomeDraft({ beat: "engines", name: "Old" });
    for (const extra of [{ replay: true }, { embedded: true }]) {
      await reload(extra);
      expect(text(), JSON.stringify(extra)).toContain("Step 1 of 3");
      expect((host.querySelector(NAME) as HTMLInputElement).value).toBe("");
      await type(NAME, "New");
      expect(draft()).toEqual({ beat: "engines", name: "Old" });
    }
  });
});

describe("on a phone-width screen", () => {
  it("keeps Skip in the title's own row after the greeting, so a long title wraps beside it instead of under it", async () => {
    await show({ initialBeat: "engines" });
    const skip = button("Skip setup")!;
    const title = host.querySelector("h1")!;
    expect(skip.className).not.toContain("absolute");
    expect(skip.parentElement).toBe(title.parentElement);
    expect(title.className).toContain("min-w-0");
  });

  it("shows no keyboard shortcut hints on any step", async () => {
    for (const initialBeat of ["hello", "engines", "permissions"]) {
      await reload({ initialBeat });
      expect(host.querySelector("kbd"), initialBeat).toBeNull();
      expect(text(), initialBeat).not.toMatch(/\b(?:Ctrl|Cmd)\b|⌘/);
    }
  });
});
