import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, markWelcomeFinished, MET_CHIEF_HINT, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { createDesktopPrefs, registerDesktopPrefs } from "../../electron/desktop-prefs.mjs";
import { createUpdatesConsent, registerUpdatesConsent } from "../../electron/updates-consent.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default",
  viewerEmail: undefined as string | null | undefined }));
vi.mock("./Layer", () => ({ Layer: ({ children }: { children: ReactNode }) => children, useIsTopLayer: () => () => true }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useId: () => "test-id",
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/email-gate", () => ({ emailGateDone: () => false }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("./cloud-buy/NightCard", () => ({ NightCard: ({ children }: { children: unknown }) => children }));
// Who MausBot belongs to: unknown (as before the session answers) unless a test says otherwise.
vi.mock("@/lib/default-bot", async original => ({ ...await original<typeof import("@/lib/default-bot")>(), useViewerEmail: () => f.viewerEmail }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }), productName: () => "MausBot" }));
vi.mock("./Avatar", async original => ({ ...await original<typeof import("./Avatar")>(), MausAvatar: () => null }));
vi.mock("./lazy-screens", async original => ({ ...await original<typeof import("./lazy-screens")>(), GrokMoveDialog: () => "THE MOVE DIALOG" }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, GROK_MOVE_NOTICE, launchNotice, localDay, MODELGO_OFFER_NOTICE, PRODUCT_HUNT_NOTICE, STAR_NOTICE, TEAMS_NOTICE, WHATS_NEW_NOTICE } from "@/lib/notices";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY } from "@/lib/simple-mode-prompt";
import { ADVANCED_BACK_KEY } from "@/lib/new-look";
import { api } from "@/state/store";
import { forgetAnnouncementCards, seenKey } from "@/lib/announcements";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const plans = [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const INTRO = "Keep your bots working when this computer is off";
const STAR = "Enjoying MausBot?";
const signedOut: CloudAccountState = { status: "signed-out" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let offer: CloudOffer | null;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let accountListeners: Set<(next: CloudAccountState) => void>;
let now: number;

const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8").replace(/\r\n/g, "\n");
const LOCAL_ORIGIN = "http://127.0.0.1:8799", MY_CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";
type Page = "local" | "cloud" | "server";
type Handler = (event: { page: Page; returnValue?: unknown }, ...args: unknown[]) => unknown;
interface Desktop {
  handlers: Map<string, Handler>; listeners: Map<string, Handler>; saved: { seen?: string[] } | null; offered: boolean;
  /** This computer's own workspace config.json, as main reads it. */
  config: unknown;
}
let desk: Desktop;

// Main's own record for this one desktop, behind its real IPC.
function desktopMachine(): Desktop {
  const machine: Desktop = { handlers: new Map(), listeners: new Map(), saved: null, offered: true,
    config: { onboarding: { completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => void machine.handlers.set(channel, handler as Handler), on: (channel, listener) => void machine.listeners.set(channel, listener as Handler) },
    read: () => machine.saved, write: value => { machine.saved = JSON.parse(JSON.stringify(value)); }, page: event => (event as { page: Page }).page,
    cloudOffered: async () => machine.offered, localConfig: () => machine.config, now: () => now,
  });
  return machine;
}

// The real preload, as this desktop's window loads it for a page; the Cloud account and plan answer from this file's fakes.
function windowOn(origin: string, { click = true } = {}) {
  const page: Page = origin === LOCAL_ORIGIN ? "local" : origin === MY_CLOUD ? "cloud" : "server";
  let ogb: Record<string, unknown> = {};
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL_ORIGIN}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: click } }, TextEncoder,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: Record<string, unknown>) => { ogb = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: (channel: string) => { const event = { page, returnValue: undefined as unknown }; desk.listeners.get(channel)?.(event); return event.returnValue; },
        invoke: async (channel: string, ...args: unknown[]) => desk.handlers.get(channel)?.({ page }, ...args) } }),
  });
  const fakes: Record<string, unknown> = { cloudAccount: bridges.cloud, cloudPlan: bridges.plan, openExternal: vi.fn(async () => true), organization: undefined };
  return { ...ogb, ...Object.fromEntries(Object.entries(fakes).filter(([key]) => key in ogb)) };
}
const showWindow = (origin: string, options?: { click?: boolean }) => {
  vi.stubGlobal("window", { ogb: windowOn(origin, options), addEventListener: vi.fn(), removeEventListener: vi.fn() });
};

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
/** The app opened again: a new window session, so nothing this launch showed holds the next one back. */
const relaunch = () => { session.clear(); return launch(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
/** A bot has answered once, in this launch: what a new install has after its first chat. */
const FIRST_REPLY = [{ tasks: [{ threadId: "first", usage: { turns: 1 } }] }];
let session: Map<string, string>;
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const launchCardsSeen = () => { desk.saved = { seen: [WHATS_NEW_NOTICE] }; storage.set(TEAMS_NOTICE, "1"); storage.set(MODELGO_OFFER_NOTICE, "1"); storage.set(GROK_MOVE_NOTICE, "1"); storage.set(PRODUCT_HUNT_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1"); storage.set(BOAT_OFFER_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
  // The page's announcement cards live beside the component for the session; no test inherits another's.
  forgetAnnouncementCards();
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW; desk = desktopMachine();
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; offer = TRIAL_OFFER;
  session = new Map(); f.viewerEmail = undefined;
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
  f.state = { connected: true, hydrated: true, bots: structuredClone(FIRST_REPLY), groups: [], routines: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  // The popups, the Product Hunt card and Boat's offer start seen: the tests before their own are about the other cards.
  launchCardsSeen();
  accountListeners = new Set();
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn((listener: (next: CloudAccountState) => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); }),
      offer: vi.fn(async () => offer), begin: vi.fn(async () => account),
      signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), noticeSeen: vi.fn(async () => {}) },
  };
  showWindow(LOCAL_ORIGIN);
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the card after the update", () => {
  it("offers the free trial to someone signed out who has used the app before, in the Admin's numbers, with Start free trial and Show me how", async () => {
    returning();
    const html = await launch();
    const words = [INTRO, "Free for 7 days", "Edu Bot Cloud runs your bots for you in the cloud, always on.", "Routines run on time, day and night",
      "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start", "Then from $15/month + tax. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Show me how", "Sign in to your Cloud plan", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const gone of ["launch price", "first 100", "$89", "New features first", "Get Pro", STAR]) expect(html).not.toContain(gone);
    expect(html).not.toContain('aria-modal="true"');
    expect(bridges.cloud.offer).toHaveBeenCalled();
    expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOW)]);
    expect(hints()).toContain(`${CLOUD_INTRO}:day-1`);
    expect(await settle()).toContain(INTRO);
    expect(await launch()).toBe("");
    now = NOW + 3 * 3600_000; expect(await launch()).toBe("");
    now = NOW + DAY; account = free;
    const again = await launch();
    expect(again).toContain(INTRO); expect(again).not.toContain("Sign in to your Cloud plan");
  });

  it("needs a trial: without one it waits (the star may show), and without money-back from the Admin it says none", async () => {
    returning(); offer = { ...PLAIN_OFFER };
    let html = await launch();
    expect(html).not.toContain(INTRO); expect(html).toContain(STAR);
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    offer = null; expect(await relaunch()).not.toContain(INTRO);
    offer = { ...TRIAL_OFFER, refundDays: undefined, creditUsd: undefined };
    html = await relaunch();
    expect(html).toContain(INTRO); expect(html).toContain("Voice and cloud desktops by Boat included");
    expect(html).not.toContain("money-back"); expect(html).not.toContain("Claude credit");
  });

  it("never to someone new this launch, who pays or may pay, on a branded build, or a desktop signed in with an organization", async () => {
    expect(await launch()).toBe("");
    returning();
    for (const state of [paid(), paid({ trial: trial("active") }), { ...free, purchase: { state: "confirming" as const } },
      { status: "reauth-required" as const, lastPlan: { active: true } }, { status: "unavailable" as const }, { status: "connecting" as const }]) {
      account = state; expect(await launch(), JSON.stringify(state)).not.toContain(INTRO);
    }
    account = signedOut; f.brand = "file";
    expect(await launch()).toBe("");
    f.brand = "default";
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    const org = await launch();
    expect(org).not.toContain(INTRO); expect(org).toContain(STAR);
  });

  it("Start free trial opens the Add a Cloud dialog from the card, and the card is done for good", async () => {
    returning(); await launch();
    press("Start free trial"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card" });
    expect(storage.get(CLOUD_INTRO)).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
    expect(render()).toBe("");
    now = NOW + 5 * DAY; storage.clear(); launchCardsSeen(); expect(await launch()).not.toContain(INTRO);
  });

  it("Show me how starts the one-step tip; Not now, the X and Escape end it for good, then say where Add a Cloud lives", async () => {
    returning(); await launch();
    press("Show me how");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "cloudHowTo", open: true });
    expect(storage.get(CLOUD_INTRO)).toBe("1");
    for (const close of ["Not now", "Dismiss for good", "Escape"]) {
      storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); now += DAY;
      expect(await launch(), close).toContain(INTRO);
      if (close === "Escape") {
        const card = tree().find(node => node.type === "aside")!;
        const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        card.props.onKeyDown(event); expect(event.preventDefault).toHaveBeenCalled();
      } else press(close);
      expect(storage.get(CLOUD_INTRO), close).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
      expect(render()).toContain("You can add a Cloud any time from the menu on the left of the app.");
    }
  });

  it("Sign in to your Cloud plan opens the sheet at its own sign-in and only hides the card for now", async () => {
    returning(); await launch();
    press("Sign in to your Cloud plan");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card", signIn: true });
    expect(storage.get(CLOUD_INTRO)).toBeUndefined(); expect(render()).toBe("");
    now = NOW + DAY; expect(await launch()).toContain(INTRO);
  });

  it("shows on at most three days, or one for someone who closed the earlier Pro card", async () => {
    returning();
    for (let day = 0; day < 3; day++) { now = NOW + day * DAY; expect(await relaunch(), `day ${day}`).toContain(INTRO); }
    now = NOW + 3 * DAY;
    const after = await relaunch();
    expect(after).not.toContain(INTRO); expect(after).toContain(STAR);
    storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "pro-introduction-dismissed-v3"];
    now = NOW + 10 * DAY; expect(await relaunch()).toContain(INTRO);
    now = NOW + 11 * DAY; expect(await relaunch()).not.toContain(INTRO);
  });

  it("never after the welcome's Cloud step, which was this desktop's Cloud offer however it was answered", async () => {
    returning(); f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "onboarding-cloud-v1"];
    for (const state of [signedOut, free]) {
      account = state;
      for (let day = 0; day < 3; day++) {
        now = NOW + day * DAY;
        const html = await launch();
        expect(html, `${state.status} day ${day}`).not.toContain(INTRO); expect(html, `${state.status} day ${day}`).toContain(STAR);
      }
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(bridges.cloud.offer, "nothing to load the offer for").not.toHaveBeenCalled();
  });

  it("never over setup, a dialog, the Add a Cloud dialog or its tip, busy work, or an update being offered", async () => {
    returning();
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.appSettingsOpen = true; },
      () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.state.cloudHowTo = true; }, () => { f.updater = { status: "downloaded" }; },
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; }, () => { f.state.connected = false; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).toBe("");
      f.state = saved; f.updater = null;
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(await launch()).toContain(INTRO);
  });
});

describe("the free trial's notice, here and on My Cloud", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    const running = trial("active", { switchTo: { tier: "starter", amount: 1500 } });
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active", credit: { grantedUsd: 5, remainingUsd: 3.2, state: "active" } };
    offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).toContain("Includes $5 of Claude credit: $3.20 left.");
    expect(html).toContain("Prefer Starter at $15?");
    expect(bridges.cloud.offer, "the trial's notice needs nothing from the offer").not.toHaveBeenCalled();
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await launch()).not.toContain("Your free trial");
  });

  it("on My Cloud's own page, only the trial's notice, after its sign-in and setup checklist", async () => {
    viewer = { hosted: false, canSave: true, cloudHome: true };
    showWindow(MY_CLOUD);
    returning();
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    expect(await launch()).toContain("Your free trial has ended");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: false } }];
    expect(await launch()).toBe("");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    snapshot = { status: "none" };
    expect(await launch()).toBe("");
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
    snapshot = new Error("only available in this app's window");
    expect(await launch()).toBe("");
  });
});

describe("the first conversation after meeting the Chief", () => {
  it("holds every corner notice, an account's own too, until the person has written and had a reply", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT];
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toBe("");
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain("Your free trial ends on");
  });

  it("changes nothing for an install whose first run came before: its notices keep their own rules", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toContain("Your free trial ends on");
  });
});

describe("This computer's Cloud sign-in card and the star", () => {
  it("an ended sign-in on a paid plan asks to sign in again; the star comes last and is for good", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach the Cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
    account = { ...free }; offer = { ...PLAIN_OFFER };
    expect(await relaunch()).toContain(STAR);
    press("Not now");
    expect(storage.get(STAR_NOTICE)).toBe("1"); expect(await relaunch()).toBe("");
  });
});

describe("the product-updates question after the update", () => {
  const QUESTION = "Get Edu Bot updates?", POPUP = "Meet the new Edu Bot Cloud";
  const RECEIPT = "R".repeat(43);
  let saved: unknown;
  let accountAnswer: { status: string; textVersion: string } | null;
  let client: Record<string, ReturnType<typeof vi.fn>>;
  /** Main's own consent for this desktop, behind its real IPC: the real record and logic, a fake Cloud client. */
  const wireConsent = () => {
    const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = JSON.parse(JSON.stringify(value)); } });
    const consent = createUpdatesConsent({ prefs, account: () => client as never, available: async () => true, now: () => now });
    registerUpdatesConsent({ ipcMain: { handle: (channel, handler) => void desk.handlers.set(channel, handler as Handler) }, page: event => (event as { page: Page }).page, consent });
  };
  const answer = () => (saved as { updatesConsent?: { status: string } } | null)?.updatesConsent ?? null;
  const type = (value: string) => { const input = tree().find(node => node.type === "input" && node.props.type === "email")!; expect(input).toBeTruthy(); input.props.onChange({ target: { value } }); };

  beforeEach(() => {
    saved = null; accountAnswer = null;
    client = { state: vi.fn(() => account), updatesConsent: vi.fn(async () => ({ cloudContractVersion: 1, consent: accountAnswer })),
      recordUpdatesConsent: vi.fn(async (status: string, textVersion: string) => { accountAnswer = { status, textVersion }; }),
      updatesConsentByEmail: vi.fn(async () => RECEIPT), withdrawUpdatesConsent: vi.fn(async () => {}) };
    wireConsent();
  });

  it("opens without the retired promotion; No thanks is kept and it is never asked again", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    const first = await launch();
    expect(first).toContain(QUESTION); expect(first).not.toContain(POPUP);
    const next = await launch();
    expect(next, "and after a reload in the same launch").toContain(QUESTION); expect(next).not.toContain(POPUP);
    for (const text of ["about new features and tips, about twice a month. You can unsubscribe any time.", "Your email", "Yes, send me updates", "No thanks"])
      expect(next).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="updates-consent-title"', 'type="email"', 'value=""']) expect(next).toContain(part);
    expect(next).not.toContain('type="checkbox"');
    press("No thanks"); await flush();
    expect(render()).toBe("");
    expect(answer()).toMatchObject({ status: "declined" });
    expect(client.updatesConsentByEmail).not.toHaveBeenCalled();
    expect(await launch()).not.toContain(QUESTION);
    wireConsent();
    expect(await launch(), "a restart reads it from the desktop's file").not.toContain(QUESTION);
  });

  it("waits for a new install's first reply and for a launch after the one whose welcome finished, then shows the question", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    f.state.bots = [];
    markWelcomeFinished();
    const first = await launch();
    expect(first, "the welcome just closed and no bot has answered").not.toContain(QUESTION); expect(first).not.toContain(POPUP);
    f.state.bots = structuredClone(FIRST_REPLY);
    const answered = await launch();
    expect(answered, "a bot has answered, but in the launch the welcome finished").not.toContain(QUESTION); expect(answered).not.toContain(POPUP);
    session.clear();
    const later = await launch();
    expect(later).toContain(QUESTION); expect(later).not.toContain(POPUP);
  });

  it("waits while MausBot's first-launch card is due, then follows it in the same launch once it closes", async () => {
    f.viewerEmail = null;
    f.state.bots = [{ ...structuredClone(FIRST_REPLY[0]), id: "maus", defaultBot: {} }];
    expect(await launch(), "the card is due: the question waits for it").not.toContain(QUESTION);
    markLaunchDialog("mausbot"); f.state.bots[0].welcomed = true;
    const after = await launch();
    expect(after, "the card closed in this launch: the question follows it, as it follows the popup").toContain(QUESTION);
    expect(after, "the popup still waits for a later launch").not.toContain(POPUP);
  });

  it("never during onboarding, the tour or Settings; it shows once they are done, before the other cards", async () => {
    returning();
    f.state.welcomeOpen = true; expect(await launch()).toBe("");
    f.state.welcomeOpen = false; f.state.appSettingsOpen = true; expect(await launch()).toBe("");
    f.state.appSettingsOpen = false;
    const html = await launch();
    expect(html).toContain(QUESTION); expect(html).not.toContain(STAR);
  });

  it("signed out: an optional email; Yes sends it with no account and keeps the receipt. Signed in: one tap, on the account", async () => {
    await launch(); expect(await settle()).toContain(QUESTION);
    type("not-an-email"); press("Yes, send me updates"); await flush();
    expect(render()).toContain("Enter a valid email address.");
    expect(client.updatesConsentByEmail).not.toHaveBeenCalled();
    type("person@example.test"); press("Yes, send me updates");
    for (let i = 0; i < 5; i++) await flush();
    expect(client.updatesConsentByEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.test", textVersion: "2026-10-23" }));
    expect(answer()).toMatchObject({ status: "opted_in", email: "person@example.test", receipt: RECEIPT });
    expect(render()).toBe("");

    saved = null; account = free; wireConsent();
    await launch(); const signedIn = await settle();
    expect(signedIn).toContain(QUESTION); expect(signedIn).not.toContain('type="email"');
    press("Yes, send me updates");
    for (let i = 0; i < 5; i++) await flush();
    expect(client.recordUpdatesConsent).toHaveBeenCalledWith("opted_in", "2026-10-23");
    expect(answer()).toMatchObject({ status: "opted_in", account: "a" });
    expect(await launch()).not.toContain(QUESTION);
  });

  it("not on a branded build, a saved server's page, or in a remote client's window; My Cloud's own page asks too", async () => {
    f.brand = "file"; expect(await launch()).not.toContain(QUESTION);
    f.brand = "default";
    viewer = { hosted: true, canSave: true }; showWindow(VPS); expect(await launch()).not.toContain(QUESTION);
    showWindow(LOCAL_ORIGIN); viewer = LOCAL_VIEWER; (window.ogb as Record<string, any>).remoteClient.active = true;
    expect(await launch()).not.toContain(QUESTION);
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).toContain(QUESTION);
    expect(answer()).toBeNull();
  });
});

describe("no Use my Mac popup", () => {
  it("the page never asks main for one, whatever an older main would answer, and the cards go on as before", async () => {
    const asked: unknown[] = [];
    desk.handlers.set("cloud-lending:due", async () => true);
    desk.handlers.set("cloud-lending:ask", (_event: unknown, language: unknown) => { asked.push(language); return Promise.resolve(); });
    returning(); storage.set(CLOUD_INTRO, "1");
    expect(await launch()).toContain(STAR);
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    await launch();
    expect(asked, "on this computer's page and on My Cloud's own page").toEqual([]);
  });
});

describe("the Move from Grok Bot popup", () => {
  const TITLE = "Move from Grok Bot", DIALOG = "THE MOVE DIALOG";
  let modal: boolean;
  const reads = () => vi.mocked(api).mock.calls.map(([path]) => path).filter(path => path === "/api/setup-import/grok");
  const keydown = (key: string) => {
    const handler = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "keydown").at(-1)![1] as (event: unknown) => void;
    handler({ key, preventDefault() {}, stopPropagation() {} });
  };
  const endedForGood = async () => {
    expect(render()).toBe("");
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE); expect(desk.saved?.seen).toContain(GROK_MOVE_NOTICE);
    expect(await launch(), "a reload is the same launch").not.toContain(TITLE);
    expect(await relaunch(), "nor any later one").not.toContain(TITLE);
  };

  beforeEach(() => {
    modal = false;
    storage.delete(GROK_MOVE_NOTICE);
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-grok-move-popup]" ? { querySelectorAll: () => [] } : null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
  });

  it("someone already here sees it at their next launch, a modal with the two marks, and it reads nothing on this computer", async () => {
    returning();
    const html = await launch();
    for (const text of [TITLE, "Bring your Bots here, with their skills, routines and memories.", "Let&#x27;s start", "Not now"]) expect(html).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', "data-grok-move-popup"]) expect(html).toContain(part);
    expect(launchNotice()).toBe(GROK_MOVE_NOTICE);
    expect(launchDialogShown(), "MausBot's card waits for a later launch").toBe("notices");
    expect(await settle()).toContain(TITLE);
    expect(reads(), "showing it looks at neither Downloads nor the Grok Bot app").toEqual([]);
  });

  it("never during onboarding; after a new install's welcome it follows the first messages, while the other cards keep to the first chat's quiet", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    storage.delete(STAR_NOTICE);
    f.state.bots = [{ tasks: [{ threadId: "first" }] }];
    f.state.config.onboarding = { ...EMPTY_ONBOARDING };
    expect(await launch(), "the welcome is due").toBe("");
    f.state.welcomeOpen = true;
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-11-01", version: 1, hintsSeen: [MET_CHIEF_HINT] };
    expect(await launch(), "the welcome is open").toBe("");
    f.state.welcomeOpen = false; markWelcomeFinished();
    expect(await settle(), "its first messages are still arriving").toBe("");
    vi.advanceTimersByTime(6_000);
    const html = await settle();
    expect(html).toContain(TITLE); expect(html).not.toContain(STAR);
    press("Let&#x27;s start"); await flush();
    expect(render()).toContain(DIALOG);
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1");
  });

  it("Not now, the X and Escape end it for good, on this computer and in the workspace", async () => {
    for (const how of ["Not now", "Close", "Escape"] as const) {
      session.clear(); storage.delete(GROK_MOVE_NOTICE); desk = desktopMachine(); desk.saved = { seen: [WHATS_NEW_NOTICE] }; f.state.config.onboarding.hintsSeen = withTourFinished(undefined);
      returning();
      expect(await launch(), how).toContain(TITLE);
      if (how === "Escape") keydown("Escape"); else press(how);
      await flush();
      await endedForGood();
    }
  });

  it("Let's start opens the same dialog, ends the popup for good, and only the dialog looks on this computer", async () => {
    returning();
    await launch();
    press("Let&#x27;s start"); await flush();
    expect(render()).toContain(DIALOG);
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE); expect(desk.saved?.seen).toContain(GROK_MOVE_NOTICE);
    expect(reads()).toEqual([]);
    expect(await relaunch()).not.toContain(TITLE);
  });

  it("never during a bot's turn, a dialog, a call or while a move is starting up; it comes when they end", async () => {
    returning();
    f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }];
    expect(await launch(), "a turn").toBe("");
    returning();
    modal = true;
    expect(await launch(), "another dialog").toBe("");
    modal = false;
    f.state.liveCall = { status: "connected" };
    expect(await launch(), "a call").toBe("");
    f.state.liveCall = null;
    expect(await launch()).toContain(TITLE);
  });

  it("seen on this desktop from another page, it doesn't come back", async () => {
    returning(); desk.saved = { seen: [WHATS_NEW_NOTICE, GROK_MOVE_NOTICE] };
    expect(await launch()).not.toContain(TITLE);
  });

  it("a page newer than its desktop: main ignores the new id, and the workspace and this browser still end it for good", async () => {
    returning();
    desk.handlers.set("desktop-notices:seen", async () => undefined);
    desk.handlers.set("desktop-notices:state", async () => ({ seen: [WHATS_NEW_NOTICE], cloud: false }));
    expect(await launch()).toContain(TITLE);
    press("Not now"); await flush();
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE);
    expect(await relaunch()).not.toContain(TITLE);
    storage.delete(GROK_MOVE_NOTICE);
    expect(await relaunch(), "in another browser, the workspace remembers").not.toContain(TITLE);
  });

  it("stays away from those who can't add a bot and from what isn't ours to promote: a member, a Team Cloud, a branded build", async () => {
    returning();
    viewer = { hosted: true, canSave: false };
    expect(await launch(), "a member").not.toContain(TITLE);
    viewer = LOCAL_VIEWER;
    f.state.config.team = { id: "t", name: "Acme" };
    expect(await relaunch(), "a Team Cloud").not.toContain(TITLE);
    delete f.state.config.team;
    f.brand = "file";
    expect(await relaunch(), "a branded build").not.toContain(TITLE);
  });
});

describe("the Simple mode popup after the update", () => {
  const TITLE = "Try the new Simple mode", ON = "You&#x27;re on Simple mode";
  let modal: boolean;

  beforeEach(() => {
    modal = false;
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
    setAdvancedMode(true);
    storage.delete(SIMPLE_MODE_PROMPT_KEY);
  });

  it("shows once in each browser, claims the launch, and never comes back once it is closed", async () => {
    const html = await launch();
    expect(html).toContain(TITLE);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'role="switch"', 'aria-checked="false"', "Switch any time in Settings → Advanced mode."]) expect(html).toContain(part);
    expect(launchDialogShown()).toBe("notices");
    expect(await settle(), "shown is counted once").toContain(TITLE);
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    session.clear();
    expect(await launch()).not.toContain(TITLE);
  });

  it("changes the mode live from the popup, both ways, while its words stay", async () => {
    await launch();
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("0");
    const on = render();
    expect(on).toContain('aria-checked="true"'); expect(on).toContain(TITLE);
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("1");
    expect(render()).toContain('aria-checked="false"');
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY), "flipping never closes it").toBe(false);
  });

  it("tells someone already on Simple mode so, with the switch on", async () => {
    setAdvancedMode(false);
    const html = await launch();
    expect(html).toContain(ON); expect(html).toContain('aria-checked="true"');
  });

  it("asks on the Cloud's own page and in a plain browser too, not only on this computer's", async () => {
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).toContain(TITLE);
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    viewer = { hosted: true, canSave: true }; f.state.config.cloudHome = false;
    expect(await launch()).toContain(TITLE);
  });

  it("waits during the welcome, the tour, Settings, the quiet first chat, another dialog or a call, and skips the launch its welcome finished in", async () => {
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.appSettingsOpen = true; }, () => { modal = true; },
      () => { f.state.liveCall = { status: "live" }; }, () => { f.state.config.onboarding.completedAt = undefined; },
      () => { f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT]; f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }]; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).not.toContain(TITLE);
      f.state = saved; modal = false;
    }
    markWelcomeFinished();
    expect(await launch(), "the launch the welcome finished in").not.toContain(TITLE);
    session.clear();
    expect(await launch()).toContain(TITLE);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY)).toBe(false);
  });

});

describe("the word that Advanced mode is back, in the Simple mode popup's place", () => {
  const TITLE = "Advanced mode is back", BODY = "Turn it off any time in Settings → Advanced mode.";

  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [] });
    // main.tsx's settleInterfaceMode put this browser back on Advanced mode.
    setAdvancedMode(true);
    storage.set(ADVANCED_BACK_KEY, "due");
  });

  it("shows once, with no switch, even where the Simple mode popup was never closed, and neither comes back", async () => {
    storage.delete(SIMPLE_MODE_PROMPT_KEY);
    const html = await launch();
    expect(html).toContain(TITLE); expect(html).toContain(BODY);
    for (const gone of ['role="switch"', "data-simple-mode-prompt", "Try the new Simple mode"]) expect(html).not.toContain(gone);
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(ADVANCED_BACK_KEY)).toBe("seen");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    session.clear();
    const later = await launch();
    expect(later).not.toContain(TITLE); expect(later).not.toContain("data-simple-mode-prompt");
  });

  it("never says so once the person has switched to Simple before it showed", async () => {
    storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    setAdvancedMode(false);
    expect(await launch()).not.toContain(TITLE);
    expect(storage.get(ADVANCED_BACK_KEY)).toBe("due");
  });

  it("never shows where nothing was put back", async () => {
    storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    for (const back of ["seen", undefined]) {
      if (back) storage.set(ADVANCED_BACK_KEY, back); else storage.delete(ADVANCED_BACK_KEY);
      session.clear();
      expect(await launch(), String(back)).not.toContain(TITLE);
    }
  });
});

describe("bots in two places", () => {
  const GARAGE = { key: "server:https://garage.example.test", name: "Garage server", kind: "server" as const };
  const BODY = "Your bots live in two places, so they can&#x27;t work together. Bring them together on Garage server?";
  let suggest: { key: string; name: string; kind: "cloud" | "server" } | null;
  let accepted: string[], dismissed: string[];
  beforeEach(() => {
    suggest = GARAGE; accepted = []; dismissed = [];
    desk.handlers.set("two-places:state", async () => ({ suggest }));
    desk.handlers.set("two-places:accept", async (_event, key) => { accepted.push(String(key)); suggest = null; return { suggest }; });
    desk.handlers.set("two-places:dismiss", async (_event, key) => { dismissed.push(String(key)); suggest = null; return { suggest }; });
  });

  it("one plain card on this computer's page, before any promotion; bots move there only after the person confirms (#4192)", async () => {
    returning();
    storage.delete(PRODUCT_HUNT_NOTICE);
    const html = await launch();
    expect(html).toContain('data-notice="two-places"');
    expect(html).toContain("Bring your bots together");
    expect(html).toContain(BODY);
    expect(html).not.toContain(STAR);
    press("Bring them together");
    const asking = await settle();
    expect(accepted, "one tap never moves anyone").toEqual([]);
    expect(asking).toContain("Move this computer&#x27;s bots to Garage server?");
    expect(asking, "the undo switch is My Cloud's only").not.toContain("Keep this computer&#x27;s bots on this computer");
    press("Move bots");
    await flush();
    expect(accepted).toEqual([GARAGE.key]);
    expect(await settle()).not.toContain('data-notice="two-places"');
  });

  it("Cancel on the confirm step moves nothing and keeps the card (#4192)", async () => {
    returning();
    suggest = { key: "cloud:mine", name: "My Cloud", kind: "cloud" };
    await launch();
    press("Bring them together");
    const asking = await settle();
    expect(asking).toContain("Move this computer&#x27;s bots to My Cloud?");
    expect(asking, "My Cloud names the way back").toContain("Keep this computer&#x27;s bots on this computer");
    press("Cancel");
    const after = await settle();
    expect(accepted).toEqual([]);
    expect(dismissed).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
    expect(after).toContain("Bring them together");
    expect(tree().find(node => node.props["data-two-places-bring"])?.props.autoFocus, "focus returns to the button Cancel brought back").toBe(true);
  });

  it("Escape on the confirm step works as Cancel and never dismisses the card", async () => {
    returning();
    await launch();
    press("Bring them together");
    await settle();
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree().find(node => node.props.role === "group")!.props.onKeyDown(escape);
    expect(escape.stopPropagation, "the card's own Escape never sees it").toHaveBeenCalled();
    const after = await settle();
    expect(dismissed).toEqual([]);
    expect(accepted).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
  });

  it("a different suggested place starts a fresh card, so a confirm never carries over to it", async () => {
    returning();
    await launch();
    // Children.toArray would re-key, so walk the elements as rendered.
    const find = (value: unknown): Node | undefined => {
      if (Array.isArray(value)) return value.map(find).find(Boolean);
      if (!isValidElement(value)) return undefined;
      const node = value as Node;
      if (node.type === TwoPlacesCard) return node;
      return typeof node.type === "function" ? find((node.type as (props: unknown) => ReactNode)(node.props)) : find(node.props.children);
    };
    f.index = 0; f.effects = [];
    expect(find(AppNotices({ viewer, now: () => now }))?.key).toBe(GARAGE.key);
  });

  it("Not now hands main the place to remember, and the card goes", async () => {
    returning();
    expect(await launch()).toContain(BODY);
    press("Not now");
    await flush();
    expect(dismissed).toEqual([GARAGE.key]);
    expect(await settle()).not.toContain('data-notice="two-places"');
    expect(await launch(), "main remembers it: never asked again").not.toContain('data-notice="two-places"');
  });

  it("never during the welcome or the tour, on a Cloud's or a server's page, or when main suggests nothing", async () => {
    returning();
    f.state.welcomeOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.welcomeOpen = false; f.state.tourOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.tourOpen = false;
    for (const origin of [MY_CLOUD, VPS]) {
      showWindow(origin);
      expect(await launch(), origin).not.toContain('data-notice="two-places"');
    }
    showWindow(LOCAL_ORIGIN);
    suggest = null;
    expect(await launch()).not.toContain('data-notice="two-places"');
  });

  it("is this computer's page's alone: no other page gets the bridge, and none would show it", async () => {
    returning();
    expect(windowOn(LOCAL_ORIGIN).twoPlaces).toBeDefined();
    for (const origin of [MY_CLOUD, VPS]) expect(windowOn(origin).twoPlaces, origin).toBeUndefined();
    const ask = vi.fn(async () => ({ suggest: GARAGE }));
    vi.stubGlobal("window", { ogb: { ...windowOn(MY_CLOUD), twoPlaces: { state: ask, accept: ask, dismiss: ask, onChanged: () => () => {} } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(await launch(), "a Cloud's page handed the bridge anyway").not.toContain('data-notice="two-places"');
  });
});

describe("cards from the announcements file", () => {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "product", label: "New", title: `Title of ${id}`, body: `Body of ${id}.`,
    primary: { label: `Open ${id}`, action: { open_url: `https://example.com/${id}` } }, ends: new Date(NOW + 30 * DAY).toISOString(), ...extra });
  let feed: unknown[];
  beforeEach(() => {
    forgetAnnouncementCards(); feed = [card("phone-app")];
    const config = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => path === "/api/announcements" ? { cards: feed } : config(path, init));
  });

  it("shows the first card for this person as a corner card: its label, title, body and button, and Not now", async () => {
    const shown = await launch();
    for (const text of ["New", "Title of phone-app", "Body of phone-app.", "Open phone-app", "Not now"]) expect(shown).toContain(text);
    expect(shown).toContain('data-notice="announcement"'); expect(shown).not.toContain('aria-modal="true"');
    expect(await settle()).toContain("Title of phone-app");
  });

  it("its button opens the file's address outside the app, as it is, and the card is gone for good on every record", async () => {
    await launch(); press("Open phone-app"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith("https://example.com/phone-app");
    expect(render()).toBe("");
    expect(storage.get(seenKey("phone-app"))).toBe("1"); expect(hints()).toContain(seenKey("phone-app")); expect(desk.saved?.seen).toContain(seenKey("phone-app"));
    expect(await relaunch()).not.toContain("Title of phone-app");
  });

  it("a button for one of the app's places opens it in the app, and only that", async () => {
    feed = [card("keys-tip", { kind: "tip", primary: { label: "Open API keys", action: { open: "api_keys" } }, secondary: { label: "Connect apps", action: { open: "connected_apps" } } })];
    expect(await launch()).not.toContain("Not now");
    press("Connect apps");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
    expect(window.ogb!.openExternal).not.toHaveBeenCalled();
  });

  it("one card a launch: the next waits for the next launch", async () => {
    feed = [card("first-card"), card("second-card")];
    await launch(); press("Not now"); await flush();
    expect(await settle(), "the same page").toBe("");
    expect(await launch(), "the same launch").toBe("");
    expect(await relaunch()).toContain("Title of second-card");
  });

  it("never over a notice to act on: the move popup keeps the corner, and the card follows it once closed", async () => {
    storage.delete(GROK_MOVE_NOTICE); returning();
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-grok-move-popup]" ? { querySelectorAll: () => [] } : null, querySelectorAll: () => [] });
    const grok = await launch();
    expect(grok).toContain("data-grok-move-popup"); expect(grok).not.toContain("Title of phone-app");
    expect(await settle(), "it stays up alone").not.toContain("Title of phone-app");
    press("Not now"); await flush();
    expect(await settle(), "after the move's popup").toContain("Title of phone-app");
  });

  it("a card left up keeps the corner: a card that arrives meanwhile waits for it to close", async () => {
    returning(); storage.delete(STAR_NOTICE); storage.set(CLOUD_INTRO, "1"); feed = [];
    expect(await launch()).toContain("Enjoying MausBot?");
    feed = [card("phone-app")]; forgetAnnouncementCards();
    const still = await settle();
    expect(still, "the star took the launch and is still up").toContain("Enjoying MausBot?"); expect(still).not.toContain("Title of phone-app");
    press("Not now"); await flush();
    expect(await settle()).toContain("Title of phone-app");
  });

  it("not after another remote card in the same launch, even with a third card due", async () => {
    feed = [card("first-card"), card("second-card"), card("third-card")];
    expect(await launch()).toContain("Title of first-card");
    expect(launchNotice()).toBe("announcement");
    press("Not now"); await flush();
    expect(await settle()).toBe("");
    expect(await launch(), "a reload").toBe("");
  });

  it("never in the launch the welcome took, nor over a live call", async () => {
    f.state.liveCall = { status: "active" };
    expect(await launch()).not.toContain("Title of phone-app");
    f.state.liveCall = undefined; session.clear(); markWelcomeFinished();
    expect(await launch()).not.toContain("Title of phone-app");
  });

  it("its words are text: markup in the file shows as written and runs nothing", async () => {
    feed = [card("markup", { body: "<img src=x onerror=alert(1)><b>bold</b>" })];
    const shown = await launch();
    expect(shown).toContain("&lt;img src=x onerror=alert(1)&gt;&lt;b&gt;bold&lt;/b&gt;");
    expect(shown).not.toContain("<b>");
  });

  it("follows the person's language, falling back to English", async () => {
    feed = [card("translated", { title: { en: "English title", de: "Deutscher Titel" } })];
    setLocale("de");
    expect(await launch()).toContain("Deutscher Titel");
  });

  it("skips a card for someone else and a card it cannot read, and shows nothing on a branded build", async () => {
    feed = [card("cloud-only", { audience: { surfaces: ["cloud"] } }), card("future-key", { audience: { country: ["de"] } }), card("broken", { primary: { label: "Go", action: { eval: "x" } } }), card("for-desktop")];
    expect(await launch()).toContain("Title of for-desktop");
    f.brand = "file"; forgetAnnouncementCards(); storage.set(seenKey("for-desktop"), "1"); feed = [card("branded")];
    expect(await relaunch()).not.toContain("Title of branded");
  });

  it("skips sponsor cards and shows a product announcement", async () => {
    feed = [card("sponsor-one", { kind: "sponsor", label: "Sponsor" }), card("product-news")];
    const html = await launch();
    expect(html).toContain("Title of product-news");
    expect(html).not.toContain("Title of sponsor-one");
  });
});

describe("Update MausBot on your phone", () => {
  const TITLE = "Update MausBot on your phone";
  const OLD = { id: "0f8c2a41-1111-4222-8333-444455556666", name: "Ada's iPhone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false };
  const NEW = { id: "5b5b5b5b-1111-4222-8333-444455556666", name: "Work phone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false, e2eAt: 2 };
  const OTHER = { ...OLD, id: "7c7c7c7c-1111-4222-8333-444455556666", name: "Old Android" };
  let devices: unknown[], retired: boolean;
  let companion: ReturnType<typeof vi.fn>, linked: ReturnType<typeof vi.fn>;
  /** This computer's phone link and its account, as Settings → Phone & devices reads them through the same two bridges. */
  const bridgesOn = () => {
    companion = vi.fn(async () => ({ enabled: true, keepAwake: false, port: 1, devices, pairing: null }));
    linked = vi.fn(async () => ({ available: true, status: "ready", ...(retired ? { tunnelRetired: true } : {}) }));
    Object.assign(window.ogb as Record<string, unknown>, { companion: { state: companion }, companionAccount: { state: linked } });
  };
  beforeEach(() => { devices = [OLD, NEW]; retired = true; bridgesOn(); });

  it("shows once this computer's link ended and a paired phone has an older app: the phone, what to do, Open Phone & devices and Not now", async () => {
    const shown = await launch();
    expect(shown).toContain(TITLE); expect(shown).toContain('data-notice="phone-update"');
    for (const text of ["Ada&#x27;s iPhone has an older version of the MausBot app, which can no longer connect to this computer away from your Wi-Fi.",
      "Update the app on that phone, then open it once on the same Wi-Fi as this computer. If that doesn&#x27;t reconnect it, pair it again.",
      "Open Phone &amp; devices", "Not now"]) expect(shown).toContain(text);
    expect(shown).not.toContain("Work phone");
    expect(launchNotice()).toBe("phone-app-update");
  });

  it("Open Phone & devices opens pairing in Settings, and the card is done for that phone", async () => {
    await launch();
    tree().find(node => node.type === "button" && node.props.children === "Open Phone & devices")!.props.onClick(); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "phone", phonePairing: true });
    expect(hints()).toContain("phone-app-update:0f8c2a41");
    expect(render()).toBe("");
    expect(await relaunch()).not.toContain(TITLE);
  });

  it("after Not now it stays away, until another phone with an older app is paired: then once more, for that phone", async () => {
    await launch(); press("Not now"); await flush();
    expect(render()).toBe(""); expect(await relaunch()).not.toContain(TITLE);
    devices = [OLD, OTHER]; bridgesOn();
    expect(await relaunch()).toContain("Old Android has an older version");
    press("Not now"); await flush();
    expect(await relaunch()).not.toContain(TITLE);
  });

  it("names how many phones when more than one has an older app", async () => {
    devices = [OLD, OTHER]; bridgesOn();
    expect(await launch()).toContain("2 of your phones have an older version of the MausBot app");
  });

  it("never when no paired phone has an older app, nor when this computer's link was not ended", async () => {
    devices = [NEW]; bridgesOn();
    expect(await launch(), "every phone updated and paired again").not.toContain(TITLE);
    expect(linked, "the account is asked only for a phone with an older app").not.toHaveBeenCalled();
    devices = []; bridgesOn();
    expect(await relaunch(), "no phone").not.toContain(TITLE);
    devices = [OLD]; retired = false; bridgesOn();
    expect(await relaunch(), "the link was not ended").not.toContain(TITLE);
    linked.mockRejectedValue(new Error("only on the local page")); retired = true;
    expect(await relaunch(), "an account it can't read").not.toContain(TITLE);
  });

  it("only on this computer's own page of the desktop app, never on My Cloud or a server's page", async () => {
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true; showWindow(MY_CLOUD); bridgesOn();
    expect(await relaunch(), "My Cloud").not.toContain(TITLE);
    viewer = { hosted: true, canSave: true }; f.state.config.cloudHome = false; showWindow(VPS); bridgesOn();
    expect(await relaunch(), "a server's page").not.toContain(TITLE);
    expect(companion).not.toHaveBeenCalled();
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(await relaunch(), "a plain browser").not.toContain(TITLE);
  });

  it("shows on a branded build too, as Settings → Phone & devices explains it there", async () => {
    f.brand = "file";
    expect(await launch()).toContain(TITLE);
  });

  it("waits while it can't tell yet, and over a live call", async () => {
    let answer = (_value: unknown) => {};
    companion.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    storage.delete(MODELGO_OFFER_NOTICE);
    expect(await launch(), "nothing lower shows meanwhile").toBe("");
    answer({ enabled: true, devices, pairing: null }); await flush();
    expect(await settle()).toContain(TITLE);
    session.clear(); bridgesOn(); f.state.liveCall = { status: "active" };
    expect(await launch(), "a live call").toBe("");
  });
});
