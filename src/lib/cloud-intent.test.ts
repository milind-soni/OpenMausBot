import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_INTENT_ASKED } from "./cloud-setup";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "./onboarding";

const owner = { hosted: false, canSave: true, cloudHome: true };
const record = (extra: Partial<OnboardingStatus> = {}): OnboardingStatus => ({ ...EMPTY_ONBOARDING, ...extra });
const facts = (extra: Record<string, unknown> = {}) => ({ viewer: owner, connected: true, enginesKnown: true, onboarding: record(), reopened: false, ...extra });

async function load(stored: string | null = null) {
  const saved = new Map<string, string>(stored ? [["omb.cloudIntent.pending", stored]] : []);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  vi.resetModules();
  return { module: await import("./cloud-intent"), saved };
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe("cloudIntentDue", () => {
  it("asks only on the owner's own Cloud home, once the Cloud has answered", async () => {
    const { module } = await load();
    expect(module.cloudIntentDue(facts())).toBe(true);
    expect(module.cloudIntentDue(facts({ viewer: { hosted: false, canSave: true } }))).toBe(false);
    expect(module.cloudIntentDue(facts({ viewer: { ...owner, canSave: false } }))).toBe(false);
    expect(module.cloudIntentDue(facts({ connected: false }))).toBe(false);
    expect(module.cloudIntentDue(facts({ enginesKnown: false }))).toBe(false);
    expect(module.cloudIntentDue(facts({ onboarding: undefined }))).toBe(false);
  });

  it("asks once: not after it was answered or skipped, nor on a Cloud that has already worked, unless asked for again", async () => {
    const { module } = await load();
    expect(module.cloudIntentDue(facts({ onboarding: record({ hintsSeen: [CLOUD_INTENT_ASKED] }) }))).toBe(false);
    expect(module.cloudIntentDue(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).toBe(false);
    expect(module.cloudIntentDue(facts({ onboarding: record({ hintsSeen: [CLOUD_INTENT_ASKED] }), reopened: true }))).toBe(true);
  });
});

describe("the waiting job", () => {
  it("is sent as a /setup request", async () => {
    const { module } = await load();
    expect(module.setupMessage("  every morning, the news  ")).toBe("/setup every morning, the news");
  });

  it("waits on this device until an engine can run it, and steps the question aside meanwhile", async () => {
    const { module, saved } = await load();
    const snapshot = () => ({ pending: null, reopened: false, dismissed: false, sent: null });
    expect(module.cloudIntentShown(true, snapshot())).toBe(true);
    module.setPendingIntent("  watch my page  ");
    expect(saved.get("omb.cloudIntent.pending")).toBe("watch my page");
    expect(module.cloudIntentShown(true, { ...snapshot(), pending: "watch my page" })).toBe(false);
    module.setPendingIntent(null);
    expect(saved.has("omb.cloudIntent.pending")).toBe(false);
    // A reload finds a job still waiting.
    const again = await load("watch my page");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    function Probe() { return again.module.useCloudIntent().pending; }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("watch my page");
  });

  it("Skip for now steps aside at once; Give it a job asks again", async () => {
    const { module } = await load();
    expect(module.cloudIntentShown(true, { pending: null, reopened: false, dismissed: true, sent: null })).toBe(false);
    expect(module.cloudIntentShown(false, { pending: null, reopened: true, dismissed: false, sent: null })).toBe(true);
    // Edit from the sign-in: asked again even though a job is waiting.
    expect(module.cloudIntentShown(false, { pending: "x", reopened: true, dismissed: false, sent: null })).toBe(true);
  });
});

describe("the job once sent", () => {
  it("is the bot's: it stops waiting in the same step, and the bot is remembered on this device", async () => {
    const { module, saved } = await load("watch my page");
    module.markIntentSent("b2", 1_000_000);
    expect(saved.has("omb.cloudIntent.pending")).toBe(false);
    expect(JSON.parse(saved.get("omb.cloudIntent.sent")!)).toEqual({ botId: "b2", at: 1_000_000 });
  });

  it("is set up by that bot's first routine made after it, not by another bot's or an older one", async () => {
    const { module } = await load();
    const sent = { botId: "b2", at: 10_000_000 };
    const routine = (id: string, botId: string, createdAt: number) => ({ id, botId, createdAt });
    expect(module.jobRoutine([routine("old", "b2", 1_000), routine("other", "b1", 10_500_000)], sent)).toBeUndefined();
    expect(module.jobRoutine([routine("later", "b2", 10_900_000), routine("first", "b2", 10_400_000)], sent)?.id).toBe("first");
    // A minute's grace for the two clocks.
    expect(module.jobRoutine([routine("skew", "b2", 9_970_000)], sent)?.id).toBe("skew");
    // Another device, without this one's record: any routine counts.
    expect(module.jobRoutine([routine("any", "b1", 1)], null)?.id).toBe("any");
  });
});
