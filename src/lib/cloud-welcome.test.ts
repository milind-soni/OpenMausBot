import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: vi.fn() }));
import { api } from "@/state/store";
import { CLOUD_SETUP_HIDDEN, CLOUD_WELCOME_DONE, welcomeStepHint } from "./cloud-setup";
import {
  cloudFirstRun, cloudWelcomeShown, cloudWelcomeVisible, endWelcomeHere, markWelcomeSeen, noteWelcomeHints, resetCloudWelcome,
  returnToWelcome, saveWelcomeHints, stepAsideWelcome, takeWelcomeRequest, useCloudWelcome, WELCOME_SAVE_RETRY_MS, welcomeCredit,
  withEarlyHints,
} from "./cloud-welcome";
import { EMPTY_ONBOARDING } from "./onboarding";

beforeEach(() => { resetCloudWelcome(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("cloudFirstRun", () => {
  it("opens the welcome before anything that can start a chat: the first-job question and a job waiting for the sign-in", () => {
    expect(cloudFirstRun({ welcome: true, intent: true, signIn: true })).toBe("welcome");
    expect(cloudFirstRun({ welcome: true, intent: false, signIn: true })).toBe("welcome");
    expect(cloudFirstRun({ welcome: false, intent: true, signIn: true })).toBe("intent");
    expect(cloudFirstRun({ welcome: false, intent: false, signIn: true })).toBe("sign-in");
    expect(cloudFirstRun({ welcome: false, intent: false, signIn: false })).toBeNull();
  });
});

describe("welcomeCredit", () => {
  it("names the amount left where the desktop app's plan says it, and still says there is credit without it", () => {
    const plan = { status: "paid" as const, credit: { grantedUsd: 5, remainingUsd: 4.2, state: "active" as const } };
    expect(welcomeCredit([{ trialCredit: "active" }], plan)).toEqual({ state: "active", left: 4.2 });
    expect(welcomeCredit([{ trialCredit: "active" }], null)).toEqual({ state: "active", left: null });
    expect(welcomeCredit([{}], plan)).toEqual({ state: "active", left: 4.2 });
  });

  it("says when the credit is spent or gone, and is quiet without one", () => {
    expect(welcomeCredit([{ trialCredit: "used_up" }], null)).toEqual({ state: "used_up" });
    expect(welcomeCredit([{ trialCredit: "ended" }], null)).toEqual({ state: "ended" });
    expect(welcomeCredit([{}], { status: "paid", credit: { grantedUsd: 5, remainingUsd: 0, state: "used_up" } })).toEqual({ state: "used_up" });
    expect(welcomeCredit([{}], null)).toBeNull();
    expect(welcomeCredit([], { status: "paid" })).toBeNull();
  });
});

describe("the welcome in this session", () => {
  const read = async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    let value: ReturnType<typeof useCloudWelcome> | null = null;
    function Probe() { value = useCloudWelcome(); return null; }
    renderToStaticMarkup(createElement(Probe));
    return value!;
  };

  it("shows while pending, steps aside when the person leaves it, and comes back where Continue setup asks", async () => {
    expect(cloudWelcomeShown("pending", await read())).toBe(true);
    stepAsideWelcome();
    expect(cloudWelcomeShown("pending", await read())).toBe(false);
    returnToWelcome("engine");
    expect(cloudWelcomeShown("pending", await read())).toBe(true);
    expect(takeWelcomeRequest()).toBe("engine");
    expect(takeWelcomeRequest()).toBeNull();
  });

  it("goes the moment it is done or skipped, before the Cloud's record says so", async () => {
    endWelcomeHere();
    expect(cloudWelcomeShown("pending", await read())).toBe(false);
  });

  it("stays on screen while the Cloud restarts under it once it was shown, and never shows on any other stage", async () => {
    expect(cloudWelcomeShown("waiting", await read())).toBe(false);
    markWelcomeSeen();
    expect(cloudWelcomeShown("waiting", await read())).toBe(true);
    for (const stage of ["none", "ended"]) expect(cloudWelcomeShown(stage, await read())).toBe(false);
  });

  it("counts hints written here before the Cloud's record has them", () => {
    noteWelcomeHints(["cloud-welcome-bring"]);
    noteWelcomeHints(["cloud-welcome-bring", "cloud-setup-move-skipped"]);
    const record = { ...EMPTY_ONBOARDING, hintsSeen: ["tour.composer"] };
    expect(withEarlyHints(record, ["cloud-welcome-bring"])?.hintsSeen).toEqual(["tour.composer", "cloud-welcome-bring"]);
    expect(withEarlyHints(record, [])).toBe(record);
    expect(withEarlyHints(undefined, ["cloud-welcome-bring"])).toBeUndefined();
  });
});

describe("the welcome's progress", () => {
  const owner = { hosted: false, canSave: true, cloudHome: true };
  const stored = new Map<string, string>();
  const read = async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    let value: ReturnType<typeof useCloudWelcome> | null = null;
    function Probe() { value = useCloudWelcome(); return null; }
    renderToStaticMarkup(createElement(Probe));
    return value!;
  };
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
    resetCloudWelcome();
    vi.mocked(api).mockReset();
  });

  it("is judged from the Cloud's record with what was written here and not saved yet, the same as the setup card", async () => {
    const turned = { ...EMPTY_ONBOARDING, firstTurnAt: "2026-10-16T08:00:00.000Z" };
    const facts = { viewer: owner, connected: true, enginesKnown: true, onboarding: turned };
    expect(cloudWelcomeVisible(facts, await read())).toBe(false);
    noteWelcomeHints([welcomeStepHint("bring")]);
    expect(cloudWelcomeVisible(facts, await read())).toBe(true);
  });

  it("is saved with the Cloud's own hints and those written here, and the saved config is handed on", async () => {
    const config = { onboarding: { hintsSeen: ["tour.composer", "cloud-welcome-bring"] } };
    vi.mocked(api).mockResolvedValue(config);
    const dispatch = vi.fn();
    noteWelcomeHints(["cloud-welcome-shown"]);
    expect(await saveWelcomeHints({ ...EMPTY_ONBOARDING, hintsSeen: ["tour.composer"] }, ["cloud-welcome-bring"], dispatch, async () => {})).toBe(true);
    expect(vi.mocked(api).mock.calls).toEqual([["/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: ["tour.composer", "cloud-welcome-shown", "cloud-welcome-bring"] } }) }]]);
    expect(dispatch).toHaveBeenCalledWith({ type: "configStatus", config });
  });

  it("tries once more when the Cloud is busy", async () => {
    const busy = Object.assign(new Error("provider settings are already being updated"), { status: 409 });
    vi.mocked(api).mockRejectedValueOnce(busy).mockResolvedValueOnce({ onboarding: { hintsSeen: [] } });
    const wait = vi.fn(async () => {});
    const dispatch = vi.fn();
    expect(await saveWelcomeHints(undefined, ["cloud-welcome-engine"], dispatch, wait)).toBe(true);
    expect(api).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(WELCOME_SAVE_RETRY_MS);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps an end it still cannot save on this device, so the welcome does not come back on the next launch", async () => {
    vi.mocked(api).mockRejectedValue(new Error("offline"));
    for (const end of [CLOUD_WELCOME_DONE, CLOUD_SETUP_HIDDEN]) {
      stored.clear();
      resetCloudWelcome();
      expect(await saveWelcomeHints(undefined, [end], vi.fn(), async () => {})).toBe(false);
      expect(stored.get("omb.cloudWelcome.done")).toBe("1");
      resetCloudWelcome();
      const next = await read();
      expect(next).toMatchObject({ ended: true, doneHere: true });
      expect(next.early).toContain(CLOUD_WELCOME_DONE);
      expect(cloudWelcomeVisible({ viewer: owner, connected: true, enginesKnown: true, onboarding: { ...EMPTY_ONBOARDING } }, next)).toBe(false);
    }
  });

  it("keeps nothing for a step it could not save: the welcome opens on that step again", async () => {
    vi.mocked(api).mockRejectedValue(new Error("offline"));
    expect(await saveWelcomeHints(undefined, [welcomeStepHint("bring")], vi.fn(), async () => {})).toBe(false);
    expect(stored.has("omb.cloudWelcome.done")).toBe(false);
    expect((await read()).doneHere).toBe(false);
  });
});
