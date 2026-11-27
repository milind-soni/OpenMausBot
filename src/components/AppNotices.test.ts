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
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("./cloud-buy/NightCard", () => ({ NightCard: ({ children }: { children: unknown }) => children }));
vi.mock("./whats-new/TeamPicture", () => ({ TeamPicture: () => null }));
// Who MausBot belongs to: unknown (as before the session answers) unless a test says otherwise.
vi.mock("@/lib/default-bot", async original => ({ ...await original<typeof import("@/lib/default-bot")>(), useViewerEmail: () => f.viewerEmail }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }), productName: () => "MausBot" }));
vi.mock("./Avatar", async original => ({ ...await original<typeof import("./Avatar")>(), MausAvatar: () => null, BotAvatar: () => null }));
vi.mock("./lazy-screens", async original => ({ ...await original<typeof import("./lazy-screens")>(), GrokMoveDialog: () => "THE MOVE DIALOG" }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, EARLIER_WHATS_NEW_NOTICE, GROK_MOVE_NOTICE, launchNotice, localDay, MODELGO_OFFER_NOTICE, PREVIOUS_WHATS_NEW_NOTICE, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, STAR_NOTICE, TEAMS_NOTICE, WHATS_NEW_NOTICE } from "@/lib/notices";
import { BOAT_OFFER, boatClaimMailto } from "@/lib/boat-offer";
import { track } from "@/lib/analytics";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY } from "@/lib/simple-mode-prompt";
import { ADVANCED_BACK_KEY } from "@/lib/new-look";
import { api } from "@/state/store";
import { forgetAnnouncementCards, seenKey } from "@/lib/announcements";
import { CLOUD_WELCOME_DONE } from "../../shared/cloud-hints";
import { createPlacesTogether, installPlacesTogether } from "../../electron/places-together.mjs";
import { resetPlacesTogetherForTest } from "@/lib/places-together";

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
const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
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
const launchCardsSeen = () => { desk.saved = { seen: [WHATS_NEW_NOTICE] }; storage.set(WHATS_NEW_NOTICE, "1"); storage.set(TEAMS_NOTICE, "1"); storage.set(MODELGO_OFFER_NOTICE, "1"); storage.set(GROK_MOVE_NOTICE, "1"); storage.set(PRODUCT_HUNT_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1"); storage.set(BOAT_OFFER_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];
/** What's new's slides on screen, in order (every slide is drawn; only the one on screen is live). */
const slidesOf = (html: string) => [...html.matchAll(/data-whats-new-slide="(\w+)"/g)].map(match => match[1]);

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
  vi.stubGlobal("document", { documentElement: { dataset: {} }, activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the card after the update", () => {
  it("offers the free trial to someone signed out who has used the app before, in the Admin's numbers, with Start free trial and Show me how", async () => {
    returning();
    const html = await launch();
    const words = [INTRO, "Free for 7 days", "MausBot Cloud runs your bots for you in the cloud, always on.", "Routines run on time, day and night",
      "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start", "Then from $15/month + tax. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Show me how", "Sign in to your Cloud plan", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const gone of ["launch price", "first 100", "$89", "New features first", "Get Pro", STAR]) expect(html).not.toContain(gone);
    expect(html).not.toContain('aria-modal="true"');
    expect(bridges.cloud.offer).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "signed_out" });
    expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOW)]);
    expect(hints()).toContain(`${CLOUD_INTRO}:day-1`);
    expect(await settle()).toContain(INTRO);
    expect(await launch()).toBe("");
    now = NOW + 3 * 3600_000; expect(await launch()).toBe("");
    now = NOW + DAY; account = free;
    const again = await launch();
    expect(again).toContain(INTRO); expect(again).not.toContain("Sign in to your Cloud plan");
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "free" });
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
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "start" });
    expect(storage.get(CLOUD_INTRO)).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
    expect(render()).toBe("");
    now = NOW + 5 * DAY; storage.clear(); launchCardsSeen(); expect(await launch()).not.toContain(INTRO);
  });

  it("Show me how starts the one-step tip; Not now, the X and Escape end it for good, then say where Add a Cloud lives", async () => {
    returning(); await launch();
    press("Show me how");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "cloudHowTo", open: true });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "howto" });
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
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "not_now" });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "close" });
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
    expect(track).not.toHaveBeenCalledWith("cloud_card_shown", expect.anything());
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

describe("the Product Hunt launch card", () => {
  const PH = "live on Product Hunt";
  const fresh = () => { storage.delete(PRODUCT_HUNT_NOTICE); };

  it("waits for a new install's first reply, so it never lands on the first chat", async () => {
    fresh(); f.state.bots = [];
    expect(await launch()).not.toContain(PH);
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain(PH);
  });

  it("comes first, for everyone (new or not, any plan), and the upvote opens the launch and ends it for good", async () => {
    fresh(); account = paid({ machine: ready });
    const html = await launch();
    expect(html).toContain(PH); expect(html).toContain("Upvote on Product Hunt");
    expect(html).not.toContain(STAR); expect(html).not.toContain("Your always-on bots are in the Cloud");
    press("Upvote on Product Hunt"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith(PRODUCT_HUNT_URL);
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "upvote" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1"); expect(hints()).toContain(PRODUCT_HUNT_NOTICE);
    expect(await launch()).not.toContain(PH);
  });

  it("Not now, the X and Escape end it for good too", async () => {
    fresh();
    expect(await launch()).toContain(PH);
    press("Not now");
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "not_now" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1");
    expect(await launch()).not.toContain(PH);
  });

  it("never while the bots move to My Cloud, nor in the first minutes after; the star and the Cloud offers wait too", async () => {
    fresh(); returning(); storage.delete(STAR_NOTICE);
    const line = (move: unknown) => desk.handlers.set("cloud-send:notice", () => ({ ready: true, bots: [], move }));
    for (const move of [{ phase: "copy", chats: { done: 1, total: 5 } }, { phase: "wait" }, { phase: "finishing" }, { phase: "copy", failing: { error: null } }, { phase: "home-again" }]) {
      line(move);
      const html = await launch();
      expect(html, JSON.stringify(move)).not.toContain(PH); expect(html, JSON.stringify(move)).not.toContain(STAR);
    }
    line({ phase: "done", at: NOW - 60_000, phone: false, held: [] });
    expect(await launch(), "a minute after: still quiet").not.toContain(PH);
    line(undefined);
    expect(await settle(), "the done line closed a minute after: still quiet").not.toContain(PH);
    line({ phase: "done", at: NOW - 6 * 60_000, phone: false, held: [] });
    expect(await launch(), "some minutes after: the card shows").toContain(PH);
    line(undefined);
    expect(await launch(), "no move at all").toContain(PH);
    desk.handlers.set("cloud-send:notice", () => { throw new Error("cloud-send:notice is only available in this app's window"); });
    expect(await launch(), "a page main tells nothing").toContain(PH);
    desk.handlers.set("cloud-send:notice", () => new Promise(() => {}));
    expect(await launch(), "until main says whether a move goes, nothing shows").not.toContain(PH);
  });

  it("never on a branded build or an organization's desktop, never after the launch window, never over setup or an update", async () => {
    fresh(); f.brand = "file";
    expect(await launch()).not.toContain(PH);
    f.brand = "default"; now = PRODUCT_HUNT_UNTIL;
    expect(await launch()).not.toContain(PH);
    now = NOW; f.updater = { status: "available", version: "9.9.9" };
    expect(await launch()).not.toContain(PH);
  });
});

describe("Boat's credit offer", () => {
  const TITLE = "$50 of Boat credit for you";
  const BODY = "Boat runs the cloud computers behind MausBot. Buy Boat's $100 plan or bigger, then tell Boat that MausBot sent you, and they'll add $50 in credits to your Boat account.";
  const YOURSELF = "You claim it yourself: it isn't automatic.";
  const CLAIM = "I bought it: claim my $50";
  const html = (text: string) => text.replace(/'/g, "&#x27;");
  // No Cloud trial to offer, as for every plan but Team: the Cloud's own card after the update steps aside.
  const fresh = () => { storage.delete(BOAT_OFFER_NOTICE); returning(); offer = { ...PLAIN_OFFER }; };
  const boatEvents = () => vi.mocked(track).mock.calls.filter(([name]) => name === "boat_offer").map(([, props]) => props);
  const escape = () => tree().find(node => node.type === "aside")!.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  const endedForGood = async () => {
    expect(render()).toBe("");
    expect(storage.get(BOAT_OFFER_NOTICE)).toBe("1"); expect(hints()).toContain(BOAT_OFFER_NOTICE); expect(desk.saved?.seen).toContain(BOAT_OFFER_NOTICE);
    expect(await launch()).not.toContain(TITLE);
  };
  afterEach(() => { BOAT_OFFER.until = null; });

  it("never reaches a Team Cloud's member", async () => {
    fresh(); storage.delete(STAR_NOTICE);
    f.state.config.team = { id: "team-acme", name: "Acme" };
    viewer = { hosted: false, canSave: false };
    expect(await launch()).not.toContain(html(TITLE));
    delete f.state.config.team; viewer = LOCAL_VIEWER;
    expect(await relaunch(), "off a team as before").toContain(html(TITLE));
  });

  it("shows once to someone who used the app before this launch: what Boat gives, that they claim it themselves, Get Boat, the claim and Not now", async () => {
    fresh(); storage.delete(STAR_NOTICE);
    const shown = await launch();
    const words = [TITLE, BODY, YOURSELF, "Get Boat", CLAIM, "Not now"].map(html);
    for (const text of words) expect(shown).toContain(text);
    for (let i = 1; i < words.length; i++) expect(shown.indexOf(words[i - 1]!), words[i]).toBeLessThan(shown.indexOf(words[i]!));
    expect(shown).not.toContain(STAR); expect(shown).not.toContain('aria-modal="true"');
    expect(await settle()).toContain(html(TITLE));
    expect(boatEvents()).toEqual([{ action: "shown", place: "card" }]);
  });

  it("never on a first launch: not before the bots load, on a new install's first chat, in the launch its welcome or MausBot's card took", async () => {
    fresh(); storage.delete(STAR_NOTICE);
    f.state.bots = [];
    expect(await launch(), "nothing said yet").not.toContain(html(TITLE));
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch(), "the first reply came in this launch").not.toContain(html(TITLE));
    returning(); f.state.hydrated = false;
    expect(await launch(), "until the bots load nothing shows, not even the star after it").toBe("");
    f.state.hydrated = true; markWelcomeFinished();
    expect(await launch(), "the launch its welcome finished in").not.toContain(html(TITLE));
    session.clear(); markLaunchDialog("mausbot");
    expect(await launch(), "the launch MausBot's first card took").not.toContain(html(TITLE));
    session.clear();
    expect(await launch()).toContain(html(TITLE));
  });

  it("never during onboarding or the tour, nor while a bot or a room is working: it waits for an idle moment, and steps aside for a turn", async () => {
    fresh();
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.config.onboarding.completedAt = undefined; },
      () => { f.state.bots[0].busy = true; }, () => { f.state.bots[0].tasks[0].busy = true; },
      () => { f.state.groups = [{ working: true }]; }, () => { f.state.groups = [{ busyBotId: "b" }]; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).not.toContain(html(TITLE));
      f.state = saved;
    }
    expect(boatEvents()).toEqual([]);
    expect(await launch()).toContain(html(TITLE));
    f.state.bots[0].busy = true;
    expect(await settle(), "a turn starts while it is up").toBe("");
    f.state.bots[0].busy = false;
    expect(await settle(), "back once the turn ends, still not dismissed").toContain(html(TITLE));
    expect(storage.get(BOAT_OFFER_NOTICE)).toBeUndefined();
    expect(boatEvents()).toEqual([{ action: "shown", place: "card" }]);
  });

  it("Get Boat opens boat.dev in the browser and ends it for good", async () => {
    fresh(); await launch();
    press("Get Boat"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://boat.dev");
    expect(boatEvents()).toContainEqual({ action: "get_boat", place: "card" });
    await endedForGood();
  });

  it("shows Boat's address for manual opening and keeps the offer available if the browser fails", async () => {
    fresh(); await launch();
    vi.mocked(window.ogb!.openExternal!).mockRejectedValueOnce(new Error("no browser"));
    press("Get Boat"); await flush();
    const after = render();
    expect(after).toMatch(/role="alert"[^>]*>[^<]*<span[^>]*>https:\/\/boat\.dev<\/span>/);
    expect(storage.get(BOAT_OFFER_NOTICE)).toBeUndefined();
    press("Get Boat"); await flush();
    await endedForGood();
  });

  it("the claim opens an email to Boat's billing address with Boat's subject and body for the person to send, and ends it for good; nothing is sent for them", async () => {
    fresh(); await launch();
    vi.mocked(api).mockClear();
    press(CLAIM); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith(boatClaimMailto());
    const draft = new URL(vi.mocked(window.ogb!.openExternal!).mock.calls[0]![0]);
    expect(`${draft.protocol}${draft.pathname}`).toBe("mailto:support@ascii.dev");
    expect(draft.searchParams.get("subject")).toBe("MausBot introduced me: $50 Boat credit");
    expect(draft.searchParams.get("body")!.replace(/\r\n/g, "\n")).toBe("Hi Boat team,\n\nMausBot introduced me to Boat. I'm on the $___ plan.\nMy Boat account email: ___\n\nThanks!");
    expect(vi.mocked(api).mock.calls.map(([path]) => path), "only the dismissal is saved").toEqual(["/api/config"]);
    expect(boatEvents()).toContainEqual({ action: "claim", place: "card" });
    await endedForGood();
  });

  it("an email app that won't open leaves it up and names the address to write to", async () => {
    fresh(); await launch();
    vi.mocked(window.ogb!.openExternal!).mockRejectedValueOnce(new Error("no mail app"));
    press(CLAIM); await flush();
    const after = render();
    expect(after).toContain(html("Couldn't open your email app. Write to support@ascii.dev instead."));
    expect(after).toContain(html(TITLE)); expect(storage.get(BOAT_OFFER_NOTICE)).toBeUndefined();
  });

  it("Not now, the X and Escape end it for good too", async () => {
    for (const end of [() => press("Not now"), () => press("Dismiss for good"), escape]) {
      fresh(); desk = desktopMachine(); desk.saved = { seen: [WHATS_NEW_NOTICE] }; f.state.config.onboarding.hintsSeen = withTourFinished(undefined);
      expect(await launch()).toContain(html(TITLE));
      end(); await flush();
      await endedForGood();
    }
    expect(boatEvents().map((props) => props?.action)).toEqual(["shown", "not_now", "shown", "close", "shown", "close"]);
  });

  it("closed on This computer's page, it stays closed on My Cloud's page in the same desktop; a desktop that never showed it shows it there", async () => {
    fresh(); await launch(); press("Not now"); await flush();
    storage.clear(); storage.set(PRODUCT_HUNT_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).not.toContain(html(TITLE));
    desk = desktopMachine(); desk.saved = { seen: [WHATS_NEW_NOTICE] };
    expect(await launch()).toContain(html(TITLE));
  });

  it("shows in a plain browser too, where the claim goes to the browser's own mail app", async () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { href: "https://bots.example.test/" } });
    viewer = { hosted: true, canSave: true }; fresh();
    expect(await launch()).toContain(html(TITLE));
    press(CLAIM); await flush();
    expect(window.location.href).toBe(boatClaimMailto());
    expect(storage.get(BOAT_OFFER_NOTICE)).toBe("1"); expect(render()).toBe("");
  });

  it("never on a branded build or an organization's desktop, and never from its end date on", async () => {
    fresh(); f.brand = "file";
    expect(await launch()).not.toContain(html(TITLE));
    f.brand = "default"; BOAT_OFFER.until = NOW + DAY;
    expect(await launch(), "before its end date").toContain(html(TITLE));
    now = NOW + DAY;
    expect(await launch(), "from its end date").not.toContain(html(TITLE));
    BOAT_OFFER.until = NOW - 1; now = NOW;
    expect(await launch(), "an end date already gone switches it off").not.toContain(html(TITLE));
    BOAT_OFFER.until = null;
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    expect(await launch()).not.toContain(html(TITLE));
  });

  it("comes after a trial's notice, before the star, and waits while the bots move to My Cloud", async () => {
    fresh(); storage.delete(STAR_NOTICE);
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    const first = await launch();
    expect(first).toContain("Your free trial ends on"); expect(first).not.toContain(html(TITLE));
    snapshot = { ...snapshot, notice: undefined };
    const line = (move: unknown) => desk.handlers.set("cloud-send:notice", () => ({ ready: true, bots: [], move }));
    line({ phase: "copy", chats: { done: 1, total: 5 } });
    expect(await launch(), "while the bots move").not.toContain(html(TITLE));
    line(undefined);
    expect(await relaunch()).toContain(html(TITLE));
    press("Not now"); await flush();
    expect(await relaunch()).toContain(STAR);
  });
});

describe("What's new after the update", () => {
  const PRO = "Meet the new MausBot Cloud", TEAM = "Shared bots for your whole team", APPS = "Your apps have a home", PUBLISH = "Publish your bots";
  const ID = WHATS_NEW_NOTICE;
  const BOAT = "$50 of Boat credit for you";
  let modal: boolean;
  const steps = () => vi.mocked(track).mock.calls.filter(([event]) => event === "whats_new").map(([, props]) => props as Record<string, unknown>);
  const step = (action: string, slide: string, audience = "no_plan", signedIn = false) => ({ action, slide, audience, signed_in: signedIn, campaign: ID });
  const seenOnDesktop = () => desk.saved?.seen ?? [];
  const on = (html: string) => /data-whats-new="(\w+)"/.exec(html)?.[1] ?? null;
  /** Next, with the slide's own effects run as the page runs them. */
  const next = async (times = 1) => { for (let i = 0; i < times; i++) { press("Next"); render(); f.effects.forEach(effect => effect()); await flush(); } };
  const fresh = () => { desk = desktopMachine(); storage.delete(ID); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); };
  const keptForGood = async () => {
    expect(render()).toBe("");
    expect(storage.get(ID)).toBe("1"); expect(hints()).toContain(ID); expect(seenOnDesktop()).toContain(ID);
    expect(on(await relaunch())).toBeNull();
  };
  const TITLE = { id: "whats-new-pro-title" }, DIALOG = { contains: (node: unknown) => node === TITLE };
  const keydown = (key: string) => {
    const handler = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "keydown").at(-1)![1] as (event: unknown) => void;
    const event = { key, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handler(event);
    return event;
  };
  const tierPlan = (tier: string, extra: Partial<CloudAccountState> = {}) =>
    paid({ entitlement: { plan: "pro", tier, status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
  const teamOffer: CloudOffer = { ...PLAIN_OFFER, plans: [...PLAIN_OFFER.plans, { tier: "team", label: "Team", amount: 4000, trialDays: 3 }] };

  beforeEach(() => {
    fresh(); modal = false; offer = teamOffer;
    vi.stubGlobal("document", { documentElement: { dataset: {} }, activeElement: TITLE, body: null, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-whats-new]" ? DIALOG : null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
  });

  it("no Cloud plan: once, before every other card, a modal with Apps, Publish, then the new Cloud and Team in the Admin's numbers; Get Pro opens Add a Cloud with its tag", async () => {
    returning(); storage.delete(STAR_NOTICE);
    const html = await launch();
    expect(on(html)).toBe("apps");
    expect(slidesOf(html)).toEqual(["apps", "publish", "pro", "team"]);
    for (const text of [APPS, "Open apps", PUBLISH, PRO, TEAM, "Pro · $49/month + tax · 14-day money-back", "Free for 3 days, then $40/month + tax", "Get Pro", "See the new Cloud", "Start a Team", "Next", "Not now"])
      expect(html).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="whats-new-apps-title"']) expect(html).toContain(part);
    for (const other of [STAR, INTRO]) expect(html).not.toContain(other);
    expect(steps()).toEqual([step("seen", "apps")]);
    expect(await settle()).toContain(PRO);
    expect(steps(), "seen once while it is up").toHaveLength(1);
    expect(seenOnDesktop()).toEqual([]);
    expect(launchNotice(), "it takes the launch").toBe(ID);

    press("Get Pro"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_whats_new_pro" });
    expect(steps().at(-1)).toEqual(step("get_pro", "pro"));
    await keptForGood();
  });

  it("Next walks Apps, Publish, the new Cloud and Team; Back goes back; each step counted", async () => {
    account = free;
    await launch();
    await next(2);
    expect(on(render())).toBe("pro");
    press("Next");
    expect(on(render())).toBe("team");
    f.effects.forEach(effect => effect()); await flush();
    press("Back");
    expect(on(render())).toBe("pro");
    const at = (action: string, slide: string) => step(action, slide, "no_plan", true);
    expect(steps()).toEqual([at("seen", "apps"), at("next", "apps"), at("seen", "publish"), at("next", "publish"), at("seen", "pro"), at("next", "pro"), at("seen", "team"), at("back", "team")]);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(seenOnDesktop()).toEqual([]);
  });

  it("See the new Cloud and Start a Team open the Cloud website with their slide's tag, and end it for good", async () => {
    await launch(); await next(2);
    press("See the new Cloud"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/cloud?src=app_whats_new_pro");
    expect(steps().at(-1)).toEqual(step("see_cloud", "pro"));
    await keptForGood();
    fresh(); vi.mocked(window.ogb!.openExternal!).mockClear();
    await relaunch(); await next(3);
    press("Start a Team"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/pro/buy?plan=team&src=app_whats_new_team");
    expect(steps().at(-1)).toEqual(step("start_team", "team"));
    await keptForGood();
  });

  it("a Cloud plan of one's own, in no team: what is new on their Cloud and Team, never the new Cloud's sale", async () => {
    for (const state of [paid(), tierPlan("starter"), tierPlan("personal"), tierPlan("max"), paid({ trial: trial("active") })]) {
      vi.clearAllMocks(); fresh(); account = state;
      const html = await relaunch();
      expect(on(html), JSON.stringify(state.entitlement)).toBe("apps");
      expect(slidesOf(html)).toEqual(["apps", "publish", "cloudNews", "team"]);
      expect(html).not.toContain(PRO); expect(html).not.toContain("Get Pro");
      expect(steps()).toEqual([step("seen", "apps", "own_plan", true)]);
    }
    press("Start a Team"); await flush();
    expect(f.dispatch, "the app's own Add a Cloud, which lists the Team plan").toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_whats_new_team" });
    expect(window.ogb?.openExternal).not.toHaveBeenCalled();
    await keptForGood();
  });

  it("no plan slides for anyone in a team, nor while a payment is linked or needs attention or a checkout is open: a team's news for whom is in one, Team on the website where it is news", async () => {
    returning();
    const team = { id: "t1", name: "Design Studio", role: "member" as const, machine: null };
    const inTeam: CloudAccountState[] = [paid({ teams: [team] }), { ...free, teams: [{ ...team, role: "owner" }] }, tierPlan("team"), tierPlan("business")];
    const buying: CloudAccountState[] = [{ ...free, purchase: { state: "confirming" as const } }, { ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 } },
      { ...free, checkout: { plan: "pro", startedAt: NOW } }];
    for (const [cases, shown] of [[inTeam, ["apps", "publish", "cloudNews", "teamNews"]], [buying, ["apps", "publish", "team"]]] as const) {
      for (const state of cases) {
        fresh(); account = state;
        const html = await relaunch();
        expect(slidesOf(html), JSON.stringify(state)).toEqual(shown);
        expect(html).not.toContain(PRO);
      }
    }
    expect(steps().filter(props => props.slide === "pro")).toEqual([]);
  });

  it("a plan slide the Admin doesn't sell is left out; offline, Team at its listed price; Apps and Publish stay", async () => {
    returning();
    offer = PLAIN_OFFER;
    const proOnly = await relaunch();
    expect(slidesOf(proOnly)).toEqual(["apps", "publish", "pro"]); expect(proOnly).not.toContain(TEAM);
    fresh(); account = paid();
    expect(slidesOf(await relaunch()), "a plan of one's own and no Team plan sold").toEqual(["apps", "publish", "cloudNews"]);
    fresh(); account = signedOut; offer = null;
    const offline = await relaunch();
    expect(slidesOf(offline)).toEqual(["apps", "publish", "team"]); expect(offline).toContain("$40 a month for 2 people, $20 for each extra person.");
    fresh(); account = { status: "unavailable" }; offer = teamOffer;
    expect(slidesOf(await relaunch())).toEqual(["apps", "publish", "team"]);
    fresh(); account = signedOut;
    expect(slidesOf(await relaunch()), "back online").toEqual(["apps", "publish", "pro", "team"]);
  });

  it("one promo a launch: What's new first; Boat's credit offer waits for the next launch, a reload in this one included", async () => {
    returning(); storage.delete(BOAT_OFFER_NOTICE); storage.set(CLOUD_INTRO, "1"); desk.saved = null;
    const first = await launch();
    expect(on(first)).toBe("apps"); expect(first).not.toContain(BOAT);
    press("Not now"); await flush();
    expect(render(), "nothing else after it in this launch").toBe("");
    expect(await launch(), "a reload is the same launch").toBe("");
    const next = await relaunch();
    expect(on(next)).toBeNull(); expect(next).toContain(BOAT);
    expect(launchNotice()).toBe(BOAT_OFFER_NOTICE);
    expect(steps().map(props => props.action)).toEqual(["seen", "not_now"]);
  });

  it("a new install sees it once onboarding is done and a bot has answered, the welcome's own launch included, never in the launch MausBot's card took", async () => {
    f.state.config.onboarding = { ...EMPTY_ONBOARDING };
    expect(on(await launch()), "onboarding not done").toBeNull();
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-10-16", version: 1, hintsSeen: [] };
    f.state.welcomeOpen = true;
    expect(on(await launch()), "the welcome").toBeNull();
    f.state.welcomeOpen = false; f.state.tourOpen = true;
    expect(on(await launch()), "the tour").toBeNull();
    f.state.tourOpen = false; f.state.bots = [{ tasks: [{ threadId: "first" }] }]; markWelcomeFinished();
    expect(on(await launch()), "the first chat, before its first reply").toBeNull();
    expect(launchNotice()).toBeNull();
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(on(await settle()), "the first reply came, in the launch the welcome finished in").toBe("apps");
    session.clear(); f.values = []; desk = desktopMachine(); storage.delete(ID); f.state.config.onboarding.hintsSeen = [];
    markLaunchDialog("mausbot");
    expect(on(await launch()), "the launch MausBot's first card took").toBeNull();
    expect(on(await relaunch())).toBe("apps");
  });

  it("claims the launch for the popups, so MausBot's card waits for a later one", async () => {
    await launch();
    expect(launchDialogShown()).toBe("notices");
  });

  it("never during a bot's turn, a room's work, another dialog, a call, Settings, adding a Cloud or an update; it waits and comes back", async () => {
    returning();
    const waits: Array<() => void> = [
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; }, () => { f.state.groups = [{ working: true }]; },
      () => { modal = true; }, () => { f.state.liveCall = { status: "live" }; }, () => { f.state.appSettingsOpen = true; },
      () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.updater = { status: "downloaded" }; },
      () => { account = { status: "signed-out", message: "restoring" }; }, () => { account = { status: "connecting" }; },
      () => { bridges.cloud.offer.mockImplementation(() => new Promise(() => {})); },
      () => { desk.handlers.set("desktop-notices:state", () => new Promise(() => {})); },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await relaunch(), wait.toString()).toBe("");
      f.state = saved; f.updater = null; account = signedOut; modal = false; bridges.cloud.offer.mockImplementation(async () => offer); desk = desktopMachine();
    }
    expect(steps()).toEqual([]); expect(seenOnDesktop()).toEqual([]);
    expect(on(await relaunch())).toBe("apps");
    f.state.bots[0].busy = true;
    expect(await settle(), "a turn starts while it is up").toBe("");
    f.state.bots[0].busy = false;
    expect(on(await settle()), "back once the turn ends").toBe("apps");
  });

  it("Not now, the X, Escape and a click outside end it for good on this computer and in the workspace", async () => {
    for (const how of ["Not now", "Close", "Escape", "outside"] as const) {
      fresh();
      expect(on(await relaunch()), how).toBe("apps");
      if (how === "Escape") expect(keydown("Escape").preventDefault, how).toHaveBeenCalled();
      else if (how === "outside") {
        const backdrop = tree().find(node => typeof node.props.onMouseDown === "function")!;
        backdrop.props.onMouseDown({ target: {}, currentTarget: backdrop });
        expect(on(render()), "a press inside the dialog").toBe("apps");
        backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
      } else press(how);
      await flush();
      await keptForGood();
    }
    expect(steps().filter(props => props.action !== "seen").map(props => props.action)).toEqual(["not_now", "close", "close", "close"]);
  });

  it("closed on another port or in another browser on this workspace, it stays closed; the desktop learns an earlier close", async () => {
    for (const keep of [() => storage.set(ID, "1"), () => { f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), ID]; }, () => { desk.saved = { seen: [ID] }; }]) {
      fresh(); keep();
      expect(on(await relaunch())).toBeNull();
      await flush(); expect(seenOnDesktop()).toEqual([ID]);
    }
    expect(steps()).toEqual([]);
  });

  it("a first run on this computer leaves it for a later launch: everyone who installs sees it once", async () => {
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "onboarding-cloud-v1"];
    expect(on(await relaunch())).toBe("apps");
  });

  it("a new campaign id shows it once more to someone who closed an earlier one, the Teams popup and the sponsor's card included", async () => {
    const earlier = ["cloud-pro-update-2026-10", "whats-new-2026-10", EARLIER_WHATS_NEW_NOTICE, PREVIOUS_WHATS_NEW_NOTICE, TEAMS_NOTICE, MODELGO_OFFER_NOTICE];
    fresh(); for (const id of earlier) storage.set(id, "1"); desk.saved = { seen: earlier.filter(id => id.endsWith("11") || id.endsWith("11b")) };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), ...earlier];
    const html = await relaunch();
    expect(ID).toBe("whats-new-2026-11c");
    expect(slidesOf(html)).toEqual(["apps", "publish", "pro", "team"]);
    press("Not now"); await flush();
    await keptForGood();
    for (const id of [PREVIOUS_WHATS_NEW_NOTICE, EARLIER_WHATS_NEW_NOTICE, TEAMS_NOTICE, MODELGO_OFFER_NOTICE]) expect(seenOnDesktop(), id).toContain(id);
  });

  it("on every page but a branded build's: the plan slides only on this computer's page of a desktop that sells the Cloud and no organization runs", async () => {
    (window.ogb as Record<string, any>).remoteClient.active = true;
    const remote = await relaunch();
    expect(slidesOf(remote), "a remote client's window").toEqual(["apps", "publish", "team"]);
    expect(remote, "it installs no app").toContain("Save any page a bot makes as an app and open it there any time.");
    fresh(); showWindow(LOCAL_ORIGIN); f.brand = "file";
    expect(on(await relaunch()), "a branded build").toBeNull();
    fresh(); f.brand = "default"; desk.offered = false;
    expect(slidesOf(await relaunch()), "a desktop that sells no Cloud").toEqual(["apps", "publish", "team"]);
    fresh(); desk.offered = true;
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    expect(slidesOf(await relaunch()), "an organization's desktop").toEqual(["apps", "publish"]);
    fresh(); f.state.config.managedPolicy = { organizationName: "Acme", companyModelsOnly: true, allowedEngines: "all" };
    expect(slidesOf(await relaunch()), "one that also refuses the sponsor: the same").toEqual(["apps", "publish"]);
    fresh(); delete f.state.config.managedPolicy;
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    const cloud = await relaunch();
    expect(slidesOf(cloud), "My Cloud's page: a Cloud they have").toEqual(["apps", "publish", "cloudNews", "team"]);
    expect(cloud, "its apps are listed under its own heading").toContain("under “In this Cloud”");
    fresh(); f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; viewer = { hosted: true, canSave: true }; showWindow(VPS);
    expect(slidesOf(await relaunch()), "a saved server's page").toEqual(["apps", "publish", "team"]);
    expect(steps().filter(props => props.slide === "pro")).toEqual([]);
  });
});

describe("the product-updates question after the update", () => {
  const QUESTION = "Get MausBot updates?", POPUP = "Meet the new MausBot Cloud";
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

  it("comes after What's new, never with it, and right after it closes; No thanks is kept and it is never asked again", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    const first = await launch();
    expect(first).toContain(POPUP); expect(first).not.toContain(QUESTION);
    press("Not now"); await flush();
    expect(render(), "right after it closes").toContain(QUESTION);
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

  it("waits for a new install's first reply and for a launch after the one whose welcome finished, then keeps its place after What's new", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    f.state.bots = [];
    markWelcomeFinished();
    const first = await launch();
    expect(first, "the welcome just closed and no bot has answered").not.toContain(QUESTION); expect(first).not.toContain(POPUP);
    f.state.bots = structuredClone(FIRST_REPLY);
    const answered = await launch();
    expect(answered, "a bot has answered: What's new, in the launch the welcome finished").toContain(POPUP); expect(answered).not.toContain(QUESTION);
    press("Not now"); await flush();
    expect(render(), "the question waits for a later launch").toBe("");
    const later = await relaunch();
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
  const TITLE = "Move from Grok Bot", WHATS_NEW = "Meet the new MausBot Cloud", DIALOG = "THE MOVE DIALOG";
  let modal: boolean;
  const events = () => vi.mocked(track).mock.calls.filter(([name]) => name === "grok_move_popup").map(([, props]) => (props as { action: string }).action);
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
    expect(events()).toEqual(["shown"]);
    expect(launchNotice()).toBe(GROK_MOVE_NOTICE);
    expect(launchDialogShown(), "MausBot's card waits for a later launch").toBe("notices");
    expect(await settle()).toContain(TITLE);
    expect(events(), "shown is counted once").toHaveLength(1);
    expect(reads(), "showing it looks at neither Downloads nor the Grok Bot app").toEqual([]);
  });

  it("goes first in the queue, one a launch: What's new, then the rest, wait for later launches", async () => {
    returning(); desk.saved = null; storage.delete(SIMPLE_MODE_PROMPT_KEY); storage.delete(BOAT_OFFER_NOTICE); storage.delete(STAR_NOTICE);
    const first = await launch();
    expect(first).toContain(TITLE);
    for (const other of ["data-simple-mode-prompt", WHATS_NEW, STAR]) expect(first).not.toContain(other);
    press("Not now"); await flush();
    expect(render(), "nothing else after it in this launch").toBe("");
    expect(await launch(), "a reload is the same launch").toBe("");
    const second = await relaunch();
    expect(second).toContain("data-simple-mode-prompt"); expect(second).not.toContain(TITLE);
    expect(launchNotice()).not.toBe(GROK_MOVE_NOTICE);
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
    expect(events()).toEqual([]);
    vi.advanceTimersByTime(6_000);
    const html = await settle();
    expect(html).toContain(TITLE); expect(html).not.toContain(STAR);
    press("Let&#x27;s start"); await flush();
    expect(render()).toContain(DIALOG);
    expect(events()).toEqual(["shown", "start"]);
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
    expect(events().filter(action => action !== "shown")).toEqual(["not_now", "close", "close"]);
  });

  it("Let's start opens the same dialog, ends the popup for good, and only the dialog looks on this computer", async () => {
    returning();
    await launch();
    press("Let&#x27;s start"); await flush();
    expect(render()).toContain(DIALOG);
    expect(events()).toEqual(["shown", "start"]);
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
  const TITLE = "Try the new Simple mode", ON = "You&#x27;re on Simple mode", POPUP = "Meet the new MausBot Cloud";
  let modal: boolean;
  const prompts = () => vi.mocked(track).mock.calls.filter(([event]) => event === "simple_mode_prompt").map(([, props]) => props);

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
    expect(prompts()).toEqual([{ action: "shown", mode: "advanced" }]);
    expect(launchDialogShown()).toBe("notices");
    expect(await settle(), "shown is counted once").toContain(TITLE);
    expect(prompts()).toHaveLength(1);
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    expect(prompts()).toEqual([{ action: "shown", mode: "advanced" }, { action: "closed", mode: "advanced" }]);
    session.clear();
    expect(await launch()).not.toContain(TITLE);
    expect(prompts()).toHaveLength(2);
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
    expect(prompts().slice(1)).toEqual([{ action: "toggled", mode: "simple" }, { action: "toggled", mode: "advanced" }]);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY), "flipping never closes it").toBe(false);
  });

  it("tells someone already on Simple mode so, with the switch on", async () => {
    setAdvancedMode(false);
    const html = await launch();
    expect(html).toContain(ON); expect(html).toContain('aria-checked="true"');
    expect(prompts()).toEqual([{ action: "shown", mode: "simple" }]);
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
    expect(prompts()).toEqual([]);
    markWelcomeFinished();
    expect(await launch(), "the launch the welcome finished in").not.toContain(TITLE);
    session.clear();
    expect(await launch()).toContain(TITLE);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY)).toBe(false);
  });

  it("is one popup at a time: What's new comes first, and it waits for a later launch", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    const first = await launch();
    expect(first).toContain(POPUP); expect(first).not.toContain(TITLE);
    press("Not now"); await flush();
    expect(render()).toBe("");
    session.clear();
    const later = await launch();
    expect(later).toContain(TITLE); expect(later).not.toContain(POPUP);
  });
});

describe("the word that Advanced mode is back, in the Simple mode popup's place", () => {
  const TITLE = "Advanced mode is back", BODY = "Turn it off any time in Settings → Advanced mode.";
  const events = () => vi.mocked(track).mock.calls.filter(([event]) => event === "advanced_back_notice").map(([, props]) => props);

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
    expect(events()).toEqual([{ action: "shown" }]);
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(ADVANCED_BACK_KEY)).toBe("seen");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    expect(events()).toEqual([{ action: "shown" }, { action: "closed" }]);
    session.clear();
    const later = await launch();
    expect(later).not.toContain(TITLE); expect(later).not.toContain("data-simple-mode-prompt");
  });

  it("never says so once the person has switched to Simple before it showed", async () => {
    storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    setAdvancedMode(false);
    expect(await launch()).not.toContain(TITLE);
    expect(events()).toEqual([]);
    expect(storage.get(ADVANCED_BACK_KEY)).toBe("due");
  });

  it("never shows where nothing was put back", async () => {
    storage.set(SIMPLE_MODE_PROMPT_KEY, "1");
    for (const back of ["seen", undefined]) {
      if (back) storage.set(ADVANCED_BACK_KEY, back); else storage.delete(ADVANCED_BACK_KEY);
      session.clear();
      expect(await launch(), String(back)).not.toContain(TITLE);
    }
    expect(events()).toEqual([]);
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
    expect(asking, "only My Cloud is sure to keep using this computer").not.toContain("when you type on it");
    press("Move bots");
    await flush();
    expect(accepted).toEqual([GARAGE.key]);
    expect(track).toHaveBeenCalledWith("two_places_card", { action: "bring", kind: "server" });
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
    expect(asking, "the move keeps this computer in use, unless lending is paused").toContain("Bots on My Cloud still use this computer when you type on it, unless you pause that in the OpenMausBot icon&#x27;s menu.");
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

describe("What's new for everyone once more: Apps, Publish your bots, then the Cloud and Team", () => {
  const APPS = "Your apps have a home", PUBLISH = "Publish your bots", TEAMS = "MausBot is better with your team", CORNER = 'data-notice="modelgo-offer"';
  const SPONSOR = "ModelGo is now in MausBot";
  const OLD = [PREVIOUS_WHATS_NEW_NOTICE, EARLIER_WHATS_NEW_NOTICE, TEAMS_NOTICE, MODELGO_OFFER_NOTICE];
  const due = () => { storage.delete(WHATS_NEW_NOTICE); desk = desktopMachine(); f.state.config.onboarding.hintsSeen = hints().filter(id => id !== WHATS_NEW_NOTICE); };
  const sponsor = () => vi.mocked(track).mock.calls.filter(([name]) => name === "modelgo_offer").map(([, props]) => props);
  const gone = async () => {
    expect(render()).toBe("");
    for (const id of [WHATS_NEW_NOTICE, ...OLD]) {
      expect(storage.get(id), id).toBe("1"); expect(hints(), id).toContain(id); expect(desk.saved?.seen, id).toContain(id);
    }
    const next = await relaunch();
    for (const text of [APPS, TEAMS, CORNER]) expect(next, "never again, nor the old Teams popup or corner card").not.toContain(text);
  };
  beforeEach(() => {
    due();
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
  });

  it("someone who closed every earlier What's new, the Teams popup and the sponsor's card sees it once; closing it is for good, on every record", async () => {
    for (const id of OLD) storage.set(id, "1");
    desk.saved = { seen: [...OLD] }; f.state.config.onboarding.hintsSeen = [...hints(), ...OLD];
    const html = await launch();
    expect(slidesOf(html), "the Admin's offer here sells no Team plan").toEqual(["apps", "publish", "pro"]);
    for (const part of ['role="dialog"', 'aria-modal="true"', "items-center justify-center"]) expect(html, "a centred modal").toContain(part);
    expect(html).not.toContain(CORNER);
    expect(launchNotice()).toBe(WHATS_NEW_NOTICE);
    press("Not now"); await flush();
    await gone();
  });

  it("someone who saw none of them: What's new, and never the Teams popup or the corner card after it", async () => {
    for (const id of OLD) storage.delete(id);
    const html = await launch();
    expect(html).toContain(APPS); expect(html).not.toContain(TEAMS); expect(html).not.toContain(CORNER);
    press("Close"); await flush();
    expect(render(), "nothing follows in this launch").toBe("");
    await gone();
  });

  it("Apps names the screen and its section as the app does; Open apps opens Published apps and ends it for good", async () => {
    const html = await launch();
    expect(html).toContain("The apps your bots build now live in “Published apps”, under “On this computer”. Save any page a bot makes as an app, open it in its own window and install it on your computer.");
    press("Open apps"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "showPublishedApps" });
    expect(vi.mocked(track)).toHaveBeenCalledWith("whats_new", expect.objectContaining({ action: "open_apps", slide: "apps", campaign: WHATS_NEW_NOTICE }));
    await gone();
  });

  it("Publish your bots names the bot's menu item and the card's button, and asks nothing of a bot: no button of its own", async () => {
    const html = await launch();
    expect(html).toContain(PUBLISH);
    expect(html).toContain("Share a bot as a template others can add to their own MausBot. Choose “Publish” in the bot&#x27;s ⋯ menu, then “Publish to community”.");
    expect(vi.mocked(api).mock.calls.filter(([path]) => String(path).includes("/messages")), "nothing sent to a bot").toEqual([]);
  });

  it("no sponsor's slide in it: not for anyone, and nothing counted on modelgo_offer", async () => {
    for (const setup of [() => {}, () => { f.state.config.managedPolicy = { organizationName: "Acme", companyModelsOnly: false, allowedEngines: ["modelgo"] }; },
      () => { f.state.config.team = { id: "team-acme", name: "Acme" }; viewer = { hosted: false, canSave: true }; }]) {
      due(); setup();
      const html = await relaunch();
      expect(html).toContain(APPS); expect(html).not.toContain(SPONSOR); expect(html).not.toContain("Get a ModelGo key");
    }
    expect(sponsor()).toEqual([]);
  });

  it("on every page but a branded build's, Apps and Publish for everyone, a Team Cloud's member and an organization that refuses the sponsor included", async () => {
    f.brand = "file";
    expect(await launch(), "white-label").toBe("");
    f.brand = "default";
    f.state.config.managedPolicy = { organizationName: "Acme", companyModelsOnly: false, allowedEngines: ["claudeAgent"] };
    expect(slidesOf(await relaunch())).toEqual(["apps", "publish", "pro"]);
    delete f.state.config.managedPolicy;
    due(); showWindow(MY_CLOUD); snapshot = { status: "none" };
    viewer = { hosted: true, canSave: false, cloudHome: true, teamRole: "member" };
    f.state.config = { ...f.state.config, cloudHome: true, team: { id: "team-acme", name: "Acme" } };
    f.state.config.onboarding.hintsSeen = [...hints(), "cloud-setup-hidden", CLOUD_WELCOME_DONE];
    const member = await relaunch();
    expect(slidesOf(member), "a Team Cloud's member: what is new, never a button that sells").toEqual(["apps", "publish", "cloudNews", "teamNews"]);
    for (const sale of ["Get Pro", "Start a Team", "Invite your team", "See the new Cloud"]) expect(member).not.toContain(sale);
  });

  for (const metChief of [false, true]) {
    it(`a new install: never in the welcome or before the first reply, then once in the welcome's own launch${metChief ? " (after meeting the Chief)" : ""}`, async () => {
      f.state.bots = [];
      f.state.config.onboarding = { ...EMPTY_ONBOARDING };
      expect(await launch(), "the welcome is due").not.toContain(APPS);
      f.state.welcomeOpen = true;
      f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-11-01", version: 1, hintsSeen: [...withTourFinished(undefined), ...(metChief ? [MET_CHIEF_HINT] : [])] };
      expect(await settle(), "the welcome is open").not.toContain(APPS);
      f.state.welcomeOpen = false; markWelcomeFinished();
      expect(await settle(), "the welcome just finished, nothing said yet").not.toContain(APPS);
      f.state.bots = [{ tasks: [{ threadId: "first" }] }];
      expect(await settle(), "the first chat, before its first reply").not.toContain(APPS);
      expect(launchNotice()).toBeNull();
      f.state.bots = structuredClone(FIRST_REPLY);
      expect(await settle(), "the first reply came").toContain(APPS);
      expect(launchNotice()).toBe(WHATS_NEW_NOTICE);
      press("Not now"); await flush();
      expect(await launch(), "a reload").toBe("");
      expect(await relaunch(), "a later launch").not.toContain(APPS);
    });
  }

  it("before a new install's first reply it holds nothing back: a trial's notice still shows", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active", credit: { grantedUsd: 5, remainingUsd: 5, state: "active" } };
    f.state.bots = [{ tasks: [{ threadId: "first" }] }]; markWelcomeFinished();
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).not.toContain(APPS);
  });

  it("a launch the move popup took leaves it for the next launch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    storage.delete(GROK_MOVE_NOTICE);
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-grok-move-popup]" ? { querySelectorAll: () => [] } : null, querySelectorAll: () => [] });
    f.state.bots = [{ tasks: [{ threadId: "first" }] }];
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-11-01", version: 1, hintsSeen: [...withTourFinished(undefined), MET_CHIEF_HINT] };
    markWelcomeFinished();
    expect(await launch(), "its first messages are still arriving").toBe("");
    vi.advanceTimersByTime(6_000);
    const grok = await settle();
    expect(grok).toContain("data-grok-move-popup"); expect(grok).not.toContain(APPS);
    press("Not now"); await flush();
    f.state.bots = structuredClone(FIRST_REPLY);
    const after = await settle();
    expect(after, "not in this launch, nor the old corner card").not.toContain(APPS); expect(after).not.toContain(CORNER);
    expect(await relaunch(), "the next launch").toContain(APPS);
  });

  it("never in the launch MausBot's first-launch card took", async () => {
    f.viewerEmail = null;
    f.state.bots = [{ ...structuredClone(FIRST_REPLY[0]), id: "maus", defaultBot: {} }];
    expect(await launch(), "the card is due").not.toContain(APPS);
    markLaunchDialog("mausbot"); f.state.bots[0].welcomed = true;
    expect(await settle(), "the card closed in this launch").not.toContain(APPS);
    f.state.bots[0].welcomed = true;
    expect(await relaunch(), "the next launch").toContain(APPS);
  });

  it("never over a live call or a move, and waits for the bots to load", async () => {
    f.state.liveCall = { status: "active" };
    expect(await launch(), "a live call").not.toContain(APPS);
    f.state.liveCall = undefined; f.state.hydrated = false;
    expect(await relaunch(), "until the bots load").not.toContain(APPS);
    f.state.hydrated = true;
    expect(await relaunch()).toContain(APPS);
  });
});

describe("cards from the announcements file", () => {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "product", label: "New", title: `Title of ${id}`, body: `Body of ${id}.`,
    primary: { label: `Open ${id}`, action: { open_url: `https://example.com/${id}` } }, ends: new Date(NOW + 30 * DAY).toISOString(), ...extra });
  let feed: unknown[];
  const events = () => vi.mocked(track).mock.calls.filter(([name]) => name === "announcement").map(([, props]) => props);
  beforeEach(() => {
    forgetAnnouncementCards(); feed = [card("phone-app")];
    const config = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => path === "/api/announcements" ? { cards: feed } : config(path, init));
  });

  it("shows the first card for this person as a corner card: its label, title, body and button, and Not now", async () => {
    const shown = await launch();
    for (const text of ["New", "Title of phone-app", "Body of phone-app.", "Open phone-app", "Not now"]) expect(shown).toContain(text);
    expect(shown).toContain('data-notice="announcement"'); expect(shown).not.toContain('aria-modal="true"');
    expect(events()).toEqual([{ id: "phone-app", kind: "product", action: "shown" }]);
    expect(await settle()).toContain("Title of phone-app");
    expect(events(), "one shown event, however often it draws").toHaveLength(1);
  });

  it("its button opens the file's address outside the app, as it is, and the card is gone for good on every record", async () => {
    await launch(); press("Open phone-app"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith("https://example.com/phone-app");
    expect(events().at(-1)).toEqual({ id: "phone-app", kind: "product", action: "primary" });
    expect(render()).toBe("");
    expect(storage.get(seenKey("phone-app"))).toBe("1"); expect(hints()).toContain(seenKey("phone-app")); expect(desk.saved?.seen).toContain(seenKey("phone-app"));
    expect(await relaunch()).not.toContain("Title of phone-app");
  });

  it("a button for one of the app's places opens it in the app, and only that", async () => {
    feed = [card("keys-tip", { kind: "tip", primary: { label: "Open API keys", action: { open: "api_keys" } }, secondary: { label: "Connect apps", action: { open: "connected_apps" } } })];
    expect(await launch()).not.toContain("Not now");
    press("Connect apps");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
    expect(events().at(-1)).toEqual({ id: "keys-tip", kind: "tip", action: "secondary" });
    expect(window.ogb!.openExternal).not.toHaveBeenCalled();
  });

  it("one card a launch: the next waits for the next launch", async () => {
    feed = [card("first-card"), card("second-card")];
    await launch(); press("Not now"); await flush();
    expect(events().at(-1)).toEqual({ id: "first-card", kind: "product", action: "close" });
    expect(await settle(), "the same page").toBe("");
    expect(await launch(), "the same launch").toBe("");
    expect(await relaunch()).toContain("Title of second-card");
  });

  it("follows a closed What's new in the same launch, then no other remote card that launch", async () => {
    feed = [card("first-card"), card("second-card")];
    returning(); desk.saved = null; storage.delete(WHATS_NEW_NOTICE); storage.set(CLOUD_INTRO, "1");
    const popup = await launch();
    expect(popup).toContain("Meet the new MausBot Cloud"); expect(popup, "never two at once").not.toContain("Title of first-card");
    expect(events()).toEqual([]);
    press("Not now"); await flush();
    const after = await settle();
    expect(after, "right after What's new closes").toContain("Title of first-card"); expect(after).not.toContain("Meet the new MausBot Cloud");
    expect(launchNotice(), "What's new keeps the launch").toBe(WHATS_NEW_NOTICE);
    expect(await launch(), "a reload in the same launch").toContain("Title of first-card");
    press("Not now"); await flush();
    expect(await settle(), "one remote card a launch").toBe("");
    expect(await launch(), "nor after a reload").toBe("");
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

  describe("a sponsor's card", () => {
    const sponsor = (id: string) => card(id, { kind: "sponsor", label: "Sponsor" });

    it("one a week: a second sponsor waits while a product card may show", async () => {
      feed = [sponsor("sponsor-one"), sponsor("sponsor-two"), card("product-news")];
      expect(await launch()).toContain("Title of sponsor-one");
      press("Not now"); await flush();
      expect(await relaunch()).toContain("Title of product-news");
      press("Not now"); await flush();
      expect(await relaunch()).toBe("");
      now += 7 * DAY;
      expect(await relaunch()).toContain("Title of sponsor-two");
    });

    it("never where an organization restricts providers, nor to a Team Cloud's members who are not its owner or an admin", async () => {
      feed = [sponsor("sponsor-one"), card("product-news")];
      f.state.config.managedPolicy = { organizationName: "Acme", companyModelsOnly: false, allowedEngines: ["claudeAgent"] };
      expect(await launch()).toContain("Title of product-news");
      f.state.config.managedPolicy = undefined; storage.set(seenKey("product-news"), "1");
      viewer = { hosted: true, canSave: false, cloudHome: true }; f.state.config.cloudHome = true; f.state.config.team = { id: "t", name: "Team" };
      f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(VPS);
      expect(await relaunch(), "a member").toBe("");
      viewer = { hosted: true, canSave: true, cloudHome: true };
      expect(await relaunch(), "the team's owner or an admin").toContain("Title of sponsor-one");
    });
  });
});

describe("Update MausBot on your phone", () => {
  const TITLE = "Update MausBot on your phone", WHATS_NEW = "Your apps have a home";
  const OLD = { id: "0f8c2a41-1111-4222-8333-444455556666", name: "Ada's iPhone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false };
  const NEW = { id: "5b5b5b5b-1111-4222-8333-444455556666", name: "Work phone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false, e2eAt: 2 };
  const OTHER = { ...OLD, id: "7c7c7c7c-1111-4222-8333-444455556666", name: "Old Android" };
  let devices: unknown[], retired: boolean;
  let companion: ReturnType<typeof vi.fn>, linked: ReturnType<typeof vi.fn>;
  /** This computer's phone link and its account, as Settings → Devices reads them through the same two bridges. */
  const bridgesOn = () => {
    companion = vi.fn(async () => ({ enabled: true, keepAwake: false, port: 1, devices, pairing: null }));
    linked = vi.fn(async () => ({ available: true, status: "ready", ...(retired ? { tunnelRetired: true } : {}) }));
    Object.assign(window.ogb as Record<string, unknown>, { companion: { state: companion }, companionAccount: { state: linked } });
  };
  beforeEach(() => { devices = [OLD, NEW]; retired = true; bridgesOn(); });

  it("shows once this computer's link ended and a paired phone has an older app: the phone, what to do, Open Devices and Not now", async () => {
    const shown = await launch();
    expect(shown).toContain(TITLE); expect(shown).toContain('data-notice="phone-update"');
    for (const text of ["Ada&#x27;s iPhone has an older version of the MausBot app, which can no longer connect to this computer away from your Wi-Fi.",
      "Update the app on that phone, then open it once on the same Wi-Fi as this computer. If that doesn&#x27;t reconnect it, pair it again.",
      "Open Devices", "Not now"]) expect(shown).toContain(text);
    expect(shown).not.toContain("Work phone");
    expect(launchNotice()).toBe("phone-app-update");
  });

  it("Open Devices opens pairing in Settings, and the card is done for that phone", async () => {
    await launch();
    tree().find(node => node.type === "button" && node.props.children === "Open Devices")!.props.onClick(); await flush();
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

  it("shows on a branded build too, as Settings → Devices explains it there", async () => {
    f.brand = "file";
    expect(await launch()).toContain(TITLE);
  });

  it("is a notice to act on: ahead of What's new, which waits for a later launch, and behind the Grok Bot popup", async () => {
    storage.delete(WHATS_NEW_NOTICE); desk = desktopMachine();
    const html = await launch();
    expect(html).toContain(TITLE); expect(html).not.toContain(WHATS_NEW);
    press("Not now"); await flush();
    expect(await settle(), "What's new is no follower").toBe("");
    expect(await relaunch(), "the next launch").toContain(WHATS_NEW);
    storage.delete(GROK_MOVE_NOTICE); session.clear(); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); storage.delete("phone-app-update:0f8c2a41");
    const first = await launch();
    expect(first, "the Grok Bot popup goes first").not.toContain(TITLE);
    expect(launchNotice()).toBe(GROK_MOVE_NOTICE);
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

describe("the Teams What's new", () => {
  const TITLE = "MausBot is better with your team";
  const POINTS = ["One shared bot for everyone: set it up once, everyone uses it.", "Team files and templates everyone&#x27;s bots can use.",
    "Private chats stay private, even from admins.", "$40 a month for 2 people, $20 for each extra person."];
  const TEAM = { id: "team-acme", name: "Acme", cloudPage: "https://admin.openmausbot.com/cloud" };
  const steps = () => vi.mocked(track).mock.calls.filter(([event, props]) => event === "whats_new" && (props as { slide: string }).slide === "teams")
    .map(([, props]) => (props as { action: string }).action);
  let firstScreen: boolean;
  const keptForGood = async () => {
    expect(render()).toBe("");
    expect(storage.get(TEAMS_NOTICE)).toBe("1");
    expect(await launch(), "a reload is the same launch").not.toContain(TITLE);
    expect(await relaunch(), "nor any later one").not.toContain(TITLE);
  };
  const onTeamCloud = (role: "owner" | "admin" | "member", page: "desktop" | "browser") => {
    if (page === "desktop") { showWindow(MY_CLOUD); (window as unknown as { open: unknown }).open = vi.fn(); }
    else vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), open: vi.fn() });
    viewer = { hosted: true, canSave: role !== "member", cloudHome: true, teamRole: role };
    f.state.config = { ...f.state.config, cloudHome: true, team: TEAM };
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/me/welcome") return { welcome: { hints: JSON.parse(String((init as RequestInit).body)).hints } };
      if (path === "/api/config" && !init) return { ...f.state.config, onboarding: { ...f.state.config.onboarding, hintsSeen: [...hints(), TEAMS_NOTICE] } };
      throw new Error(`a member cannot write ${path}`);
    });
  };
  const wrote = (path: string) => vi.mocked(api).mock.calls.filter(([called, init]) => called === path && (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  beforeEach(() => {
    storage.delete(TEAMS_NOTICE); firstScreen = false;
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null,
      querySelectorAll: (selector: string) => firstScreen && selector.includes("[data-team-welcome]") ? [{ closest: () => null, checkVisibility: () => true }] : [] });
  });

  it("is for whom What's new has nothing: a Team Cloud's member gets Got it, and nothing to sell, ahead of every other notice", async () => {
    onTeamCloud("member", "browser");
    const html = await launch();
    expect(html).toContain(TITLE); expect(html).toContain("Got it");
    for (const gone of ["Invite your team", "Start a team", "Not now", "data-whats-new"]) expect(html).not.toContain(gone);
    for (const text of POINTS) expect(html).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'data-teams-popup="got-it"']) expect(html).toContain(part);
    expect(launchNotice(), "it takes the launch").toBe(TEAMS_NOTICE);
    press("Got it"); await flush();
    expect(steps()).toContain("seen"); expect(steps().filter(step => step !== "seen")).toEqual(["got_it"]);
    expect(vi.mocked(track)).toHaveBeenCalledWith("whats_new", { action: "seen", slide: "teams", audience: "team_member", campaign: TEAMS_NOTICE });
    expect(wrote("/api/me/welcome")).toEqual([{ hints: [TEAMS_NOTICE] }]);
    await keptForGood();
  });

  it("everyone else gets What's new in its place, never this popup: this computer, a plan of one's own, a browser", async () => {
    storage.delete(WHATS_NEW_NOTICE); desk = desktopMachine();
    for (const setup of [() => {}, () => { account = paid(); }, () => {
      vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), open: vi.fn() });
      viewer = { hosted: true, canSave: true, cloudHome: true };
      f.state.config = { ...f.state.config, cloudHome: true, onboarding: { ...f.state.config.onboarding, hintsSeen: [...hints(), CLOUD_WELCOME_DONE] } };
    }]) {
      setup();
      const html = await relaunch();
      expect(html).toContain("data-whats-new"); expect(html).not.toContain(TITLE);
      expect(steps()).toEqual([]);
    }
  });

  it("a Team Cloud's admin gets What's new with Invite your team after what is new on the Cloud, kept in their own record, never the team's; this popup never follows", async () => {
    storage.delete(WHATS_NEW_NOTICE); desk = desktopMachine();
    onTeamCloud("admin", "desktop");
    const html = await launch();
    expect(slidesOf(html)).toEqual(["apps", "publish", "cloudNews", "team"]);
    expect(html).toContain("Invite your team"); expect(html).not.toContain("Start a Team"); expect(html).not.toContain(TITLE);
    for (let i = 0; i < 3; i++) { press("Next"); render(); f.effects.forEach(effect => effect()); await flush(); }
    press("Invite your team"); await flush();
    expect(window.open, "a Cloud's page opens links as a browser does").toHaveBeenCalledWith("https://admin.openmausbot.com/cloud/team/team-acme/people?do=invite", "_blank", "noopener,noreferrer");
    expect(vi.mocked(track)).toHaveBeenCalledWith("whats_new", expect.objectContaining({ action: "invite", slide: "team", audience: "team_admin", campaign: WHATS_NEW_NOTICE }));
    expect(wrote("/api/me/welcome")).toEqual([{ hints: [WHATS_NEW_NOTICE, PREVIOUS_WHATS_NEW_NOTICE, EARLIER_WHATS_NEW_NOTICE, TEAMS_NOTICE, MODELGO_OFFER_NOTICE] }]);
    expect(wrote("/api/config"), "never the team's record").toEqual([]);
    expect(desk.saved?.seen).toEqual(expect.arrayContaining([WHATS_NEW_NOTICE, TEAMS_NOTICE]));
    expect(render()).toBe("");
    const next = await relaunch();
    expect(next).not.toContain(TITLE); expect(next).not.toContain("data-whats-new");
  });

  it("never on a branded build, nor a desktop an organization runs", async () => {
    onTeamCloud("member", "browser");
    f.brand = "file";
    expect(await launch()).not.toContain(TITLE);
    f.brand = "default";
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), open: vi.fn(),
      ogb: { organization: { state: async () => ({ status: "signed-in", organization: { name: "Acme" } }), onState: () => () => {} } } });
    expect(await relaunch()).not.toContain(TITLE);
    expect(steps()).toEqual([]);
  });

  it("never during onboarding: not with the welcome or the tour open, before a first reply, over a first run's own screens or in the launch the welcome finished; then once", async () => {
    onTeamCloud("member", "browser");
    f.state.tourOpen = true;
    expect(await launch(), "the tour").not.toContain(TITLE);
    f.state.tourOpen = false; f.state.welcomeOpen = true;
    expect(await launch(), "the welcome").not.toContain(TITLE);
    f.state.welcomeOpen = false; f.state.bots = [{ tasks: [{ threadId: "first" }] }];
    expect(await launch(), "before a first reply").not.toContain(TITLE);
    f.state.bots = structuredClone(FIRST_REPLY); firstScreen = true;
    expect(await launch(), "a team's welcome to a new member").not.toContain(TITLE);
    firstScreen = false; markWelcomeFinished();
    expect(await launch(), "the launch the welcome finished in").not.toContain(TITLE);
    expect(steps()).toEqual([]);
    expect(await relaunch(), "the next launch").toContain(TITLE);
  });
});

describe("bots together by default", () => {
  let saved: unknown, reads: string[], lent: boolean, lends: boolean[];
  const install = (workspace = "computer:/data") => {
    const together = createPlacesTogether({
      pref: { read: () => { if (saved === undefined) throw Object.assign(new Error("none"), { code: "ENOENT" }); return saved; }, write: (value: unknown) => { saved = JSON.parse(JSON.stringify(value)); } },
      cloud: () => ({ origin: MY_CLOUD, account: "a", asleep: false }), computer: () => workspace,
      powerChecked: async () => { reads.push("admin"); return true; },
      local: async (route: string) => { reads.push(`computer ${route}`); return new Response(JSON.stringify({ bots: [] })); },
      cloudFetch: async (url: string) => { reads.push(`cloud ${url}`); return new Response(JSON.stringify({ bots: [] })); },
      shown: () => "computer", focused: () => true, openPlace: () => undefined, send: () => {}, changed: () => {}, now: () => now,
      commands: { on: () => lent, set: (on: boolean) => { lends.push(on); lent = on; } }, turnedOn: () => { lends.push(true); lent = true; },
      setTimer: () => ({}) as never, clearTimer: () => {},
    });
    installPlacesTogether({ ipcMain: { handle: (channel: string, handler: Handler) => void desk.handlers.set(channel, handler) } as never,
      asking: (event: unknown) => { const page = (event as { page: Page }).page; return page === "server" ? null : page; }, together });
    return together;
  };
  beforeEach(() => { saved = undefined; reads = []; lent = false; lends = []; resetPlacesTogetherForTest(); });
  afterEach(() => resetPlacesTogetherForTest());

  const CORNER = 'data-notice="together-default"', SLIDE = 'data-whats-new-slide="together"';
  const team = { id: "t1", name: "Design Studio", role: "member" as const, machine: null };
  /** This What's new not seen yet on this desktop. */
  const whatsNewUnseen = () => { desk = desktopMachine(); storage.delete(WHATS_NEW_NOTICE); };
  const onScreen = (html: string) => /data-whats-new="(\w+)"/.exec(html)?.[1] ?? null;
  /** Next until the notice's slide is on screen, each slide's effects run as the page runs them. */
  const toTogether = async () => {
    for (let i = 0; i < 6 && onScreen(render()) !== "together"; i++) { press("Next"); render(); f.effects.forEach(effect => effect()); await flush(); }
    expect(onScreen(render())).toBe("together");
  };

  it("the update's own launch: one carousel, the notice's slide last; opening it tells main nothing, reaching that slide turns the default on", async () => {
    returning(); whatsNewUnseen(); account = paid({ teams: [team] });
    const together = install();
    const html = await launch();
    expect(slidesOf(html)).toEqual(["apps", "publish", "cloudNews", "teamNews", "together"]);
    expect(onScreen(html)).toBe("apps");
    expect(html).toContain('aria-modal="true"');
    expect(html).not.toContain(CORNER);
    expect(html).toContain("Your bots are in one list now");
    expect(html).toContain("Let your Clouds&#x27; bots run commands on this computer");
    expect(html).toContain("What&#x27;s new in MausBot Cloud");
    expect(html).toContain("What&#x27;s new for your team");
    expect(html, "nothing sold to someone with a plan and a team").not.toContain("Get Pro");
    expect(html).not.toContain("Start a Team");
    expect(together.on(), "open on its first slide: the notice is not shown, so main turns nothing on").toBe(false);
    expect(await settle()).toContain(SLIDE);
    expect(together.on(), "still nothing while the person stays on the first slides").toBe(false);
    await toTogether();
    expect(together.on(), "shown: the default is on, as the corner notice's drawing turns it").toBe(true);
    expect(lends, "the default never lends commands").toEqual([]);
    expect(reads.filter(read => !read.startsWith("computer")), "no read of My Cloud at the start").toEqual([]);
    expect(await settle(), "kept on screen though main no longer calls the notice due").toContain(SLIDE);
    press("Got it");
    expect(await settle()).not.toContain(CORNER);
    resetPlacesTogetherForTest();
    const next = await relaunch();
    expect(next, "the slide was the notice: never in the corner after").not.toContain(CORNER);
    expect(next).not.toContain(SLIDE);
    expect(together.on(), "and it stays on").toBe(true);
  });

  it("closed before the notice's slide: main is never told, the carousel never comes back, and the corner notice shows it on a later launch", async () => {
    returning(); whatsNewUnseen(); storage.set(CLOUD_INTRO, "1"); account = paid({ teams: [team] });
    const together = install();
    expect(slidesOf(await launch())).toContain("together");
    press("Next"); render(); f.effects.forEach(effect => effect()); await flush();
    press("Close"); await flush();
    expect(await settle(), "nothing else in this launch").toBe("");
    expect(together.on(), "the notice was never on screen").toBe(false);
    resetPlacesTogetherForTest();
    const next = await relaunch();
    expect(next, "What's new is seen: it never comes back for the notice").not.toContain("data-whats-new");
    expect(next).toContain(CORNER);
    expect(together.on(), "the corner notice, drawn, turns the default on").toBe(true);
  });

  it("My Cloud as home: the slide keeps its line that this computer's bots now run while the app is open, though main stops saying it once shown", async () => {
    returning(); whatsNewUnseen(); account = paid({ teams: [team] });
    install("profile:default");
    const html = await launch();
    expect(html).toContain(SLIDE);
    expect(html).toContain("data-together-notice-background");
    await toTogether();
    // Main tells the page it changed (here: the window is focused, which asks again): the notice is no longer due.
    for (const [type, listener] of vi.mocked(window.addEventListener).mock.calls) if (type === "focus") (listener as () => void)();
    await flush();
    expect(desk.handlers.get("places-together:state")!({ page: "local" }), "main no longer says it").not.toHaveProperty("profileHome");
    expect(await settle()).toContain("This computer&#x27;s bots and their routines now run while the app is open.");
  });

  it("no Cloud plan of the kind sold here: the selling Cloud and Team slides, unchanged, before the notice's", async () => {
    returning(); whatsNewUnseen(); account = signedOut;
    offer = { ...PLAIN_OFFER, plans: [...PLAIN_OFFER.plans, { tier: "team", label: "Team", amount: 4000, trialDays: 3 }] };
    install();
    const html = await launch();
    expect(slidesOf(html)).toEqual(["apps", "publish", "pro", "team", "together"]);
    expect(html).toContain("Meet the new MausBot Cloud");
    expect(html).toContain("Start a Team");
  });

  it("someone who already saw this What's new never gets the carousel again for the notice: the corner notice, as before", async () => {
    returning(); storage.set(CLOUD_INTRO, "1"); account = paid({ teams: [team] });
    install();
    const html = await launch();
    expect(html).not.toContain("data-whats-new");
    expect(html).toContain(CORNER);
  });

  it("whose corner notice was already drawn: never the slide; the corner notice as before until it is closed", async () => {
    returning(); storage.set(CLOUD_INTRO, "1"); account = paid({ teams: [team] });
    saved = { v: 1, noticed: { a: NOW - DAY } };
    const together = install();
    expect(together.on(), "drawn on 0.1.182: on already").toBe(true);
    const html = await launch();
    expect(html).not.toContain(SLIDE);
    expect(html).not.toContain("data-whats-new");
    expect(html).toContain(CORNER);
    whatsNewUnseen(); install(); resetPlacesTogetherForTest();
    const unseen = await relaunch();
    expect(slidesOf(unseen), "What's new for a plan and a team, without the notice's slide").toEqual(["apps", "publish", "cloudNews", "teamNews"]);
  });

  it("fresh install: What's new does not show in its first chat's launch, so the corner notice does, and the slide never follows", async () => {
    whatsNewUnseen(); account = paid({ teams: [team] }); storage.set(CLOUD_INTRO, "1");
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    install();
    const html = await launch();
    expect(html).not.toContain("data-whats-new");
    expect(html).toContain(CORNER);
    press("Got it");
    f.state.bots = structuredClone(FIRST_REPLY);
    resetPlacesTogetherForTest();
    const next = await relaunch();
    expect(next).not.toContain(SLIDE);
    expect(next).not.toContain(CORNER);
  });

  it("no suggestion to move bots to My Cloud goes ahead of it: not while it is due, nor while main has not said whether it is", async () => {
    returning(); whatsNewUnseen(); storage.set(CLOUD_INTRO, "1"); storage.set(PRODUCT_HUNT_NOTICE, "1");
    desk.handlers.set("two-places:state", async () => ({ suggest: { key: "cloud:mine", name: "My Cloud", kind: "cloud" } }));
    desk.handlers.set("places-together:state", () => new Promise(() => {}));
    const waiting = await launch();
    expect(waiting, "main has not said yet").not.toContain('data-notice="two-places"');
    expect(waiting, "nor What's new, which may carry the notice").not.toContain("data-whats-new");
    resetPlacesTogetherForTest();
    install();
    const due = await launch();
    expect(due).not.toContain('data-notice="two-places"');
    expect(due).toContain(SLIDE);
  });

  it("not eligible: never the slide nor the corner notice for a person who chose either way, on My Cloud's page, and no slide on a branded build's", async () => {
    returning();
    saved = { v: 1, on: false };
    install();
    for (const html of [await launch()]) { expect(html).not.toContain(CORNER); expect(html).not.toContain(SLIDE); }
    saved = { v: 1, on: true };
    resetPlacesTogetherForTest();
    install();
    for (const html of [await launch()]) { expect(html).not.toContain(CORNER); expect(html).not.toContain(SLIDE); }
    saved = undefined;
    resetPlacesTogetherForTest();
    install();
    showWindow(MY_CLOUD);
    for (const html of [await launch()]) { expect(html).not.toContain(CORNER); expect(html).not.toContain(SLIDE); }
    showWindow(LOCAL_ORIGIN); f.brand = "file";
    resetPlacesTogetherForTest();
    install();
    const branded = await relaunch();
    expect(branded).not.toContain(SLIDE);
    expect(branded, "a branded build has no What's new: the corner notice, as before").toContain(CORNER);
  });
});
