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
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
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
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, launchNotice, localDay, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, STAR_NOTICE, WHATS_NEW_NOTICE } from "@/lib/notices";
import { BOAT_OFFER, boatClaimMailto } from "@/lib/boat-offer";
import { track } from "@/lib/analytics";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY } from "@/lib/simple-mode-prompt";
import { api } from "@/state/store";

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
const launchCardsSeen = () => { desk.saved = { seen: [WHATS_NEW_NOTICE] }; storage.set(PRODUCT_HUNT_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1"); storage.set(BOAT_OFFER_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
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
      expect(render()).toContain("You can add a Cloud any time from the menu at the top of the sidebar.");
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
  const PRO = "Meet the new MausBot Cloud", TEAM = "Shared bots for your whole team";
  const ID = WHATS_NEW_NOTICE;
  const BOAT = "$50 of Boat credit for you";
  let modal: boolean;
  const steps = () => vi.mocked(track).mock.calls.filter(([event]) => event === "whats_new").map(([, props]) => props as Record<string, unknown>);
  const step = (action: string, slide: string, audience = "no_plan", signedIn = false) => ({ action, slide, audience, signed_in: signedIn, campaign: ID });
  const seenOnDesktop = () => desk.saved?.seen ?? [];
  const on = (html: string) => /data-whats-new="(pro|team)"/.exec(html)?.[1] ?? null;
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
  const teamOffer: CloudOffer = { ...PLAIN_OFFER, plans: [...PLAIN_OFFER.plans, { tier: "team", label: "Team", amount: 16900, trialDays: 3 }] };

  beforeEach(() => {
    fresh(); modal = false; offer = teamOffer;
    vi.stubGlobal("document", { activeElement: TITLE, body: null, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-whats-new]" ? DIALOG : null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
  });

  it("no Cloud plan: once, before every other card, a modal with the new Cloud then Team in the Admin's numbers; Get Pro opens Add a Cloud with its tag", async () => {
    returning(); storage.delete(STAR_NOTICE);
    const html = await launch();
    expect(on(html)).toBe("pro");
    for (const text of [PRO, TEAM, "Pro · $49/month + tax · 14-day money-back", "Free for 3 days, then $169/month + tax", "Get Pro", "See the new Cloud", "Start a Team", "Next", "Not now"])
      expect(html).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="whats-new-pro-title"']) expect(html).toContain(part);
    for (const other of [STAR, INTRO]) expect(html).not.toContain(other);
    expect(steps()).toEqual([step("seen", "pro")]);
    expect(await settle()).toContain(PRO);
    expect(steps(), "seen once while it is up").toHaveLength(1);
    expect(seenOnDesktop()).toEqual([]);
    expect(launchNotice(), "it takes the launch").toBe(ID);

    press("Get Pro"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_whats_new_pro" });
    expect(steps().at(-1)).toEqual(step("get_pro", "pro"));
    await keptForGood();
  });

  it("Next shows the Team slide, Back the new Cloud again, each step counted", async () => {
    account = free;
    await launch();
    press("Next");
    expect(on(render())).toBe("team");
    f.effects.forEach(effect => effect()); await flush();
    press("Back");
    expect(on(render())).toBe("pro");
    expect(steps()).toEqual([step("seen", "pro", "no_plan", true), step("next", "pro", "no_plan", true), step("seen", "team", "no_plan", true), step("back", "team", "no_plan", true)]);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(seenOnDesktop()).toEqual([]);
  });

  it("See the new Cloud and Start a Team open the Cloud website with their slide's tag, and end it for good", async () => {
    await launch();
    press("See the new Cloud"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/cloud?src=app_whats_new_pro");
    expect(steps().at(-1)).toEqual(step("see_cloud", "pro"));
    await keptForGood();
    fresh(); vi.mocked(window.ogb!.openExternal!).mockClear();
    await relaunch(); press("Next");
    press("Start a Team"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/pro/buy?plan=team&src=app_whats_new_team");
    expect(steps().at(-1)).toEqual(step("start_team", "team"));
    await keptForGood();
  });

  it("a Cloud plan of one's own, in no team: the Team slide alone", async () => {
    for (const state of [paid(), tierPlan("starter"), tierPlan("personal"), tierPlan("max"), paid({ trial: trial("active") })]) {
      vi.clearAllMocks(); fresh(); account = state;
      const html = await relaunch();
      expect(on(html), JSON.stringify(state.entitlement)).toBe("team");
      expect(html).not.toContain(PRO); expect(html).not.toContain("Next"); expect(html).not.toContain("Get Pro");
      expect(steps()).toEqual([step("seen", "team", "own_plan", true)]);
    }
    press("Start a Team"); await flush();
    expect(f.dispatch, "the app's own Add a Cloud, which lists the Team plan").toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_whats_new_team" });
    expect(window.ogb?.openExternal).not.toHaveBeenCalled();
    await keptForGood();
  });

  it("nothing for anyone in a team, owner or member, nor while a payment is linked or needs attention or a checkout is open; the cards after it show", async () => {
    returning(); storage.delete(STAR_NOTICE);
    const team = { id: "t1", name: "Design Studio", role: "member" as const, machine: null };
    const cases: CloudAccountState[] = [paid({ teams: [team] }), { ...free, teams: [{ ...team, role: "owner" }] }, tierPlan("team"), tierPlan("business"),
      { ...free, purchase: { state: "confirming" as const } }, { ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 } },
      { ...free, checkout: { plan: "pro", startedAt: NOW } }];
    for (const state of cases) {
      account = state;
      const html = await relaunch();
      expect(on(html), JSON.stringify(state)).toBeNull();
    }
    expect(steps()).toEqual([]); expect(seenOnDesktop()).toEqual([]);
  });

  it("a slide the Admin doesn't sell is left out; neither sold, or the Cloud unreachable, waits for a later launch and lets the other cards show", async () => {
    returning(); storage.delete(STAR_NOTICE);
    offer = PLAIN_OFFER;
    const proOnly = await relaunch();
    expect(on(proOnly)).toBe("pro"); expect(proOnly).not.toContain(TEAM); expect(proOnly).not.toContain(">Next<");
    account = paid();
    const nothing = await relaunch();
    expect(on(nothing)).toBeNull(); expect(nothing).toContain(STAR);
    account = signedOut; offer = null;
    const offline = await relaunch();
    expect(on(offline)).toBeNull(); expect(offline).toContain(STAR);
    account = { status: "unavailable" }; offer = teamOffer;
    expect(on(await relaunch())).toBeNull();
    expect(seenOnDesktop()).toEqual([]);
    account = signedOut; storage.delete(STAR_NOTICE); f.state.config.onboarding.hintsSeen = withTourFinished(undefined);
    expect(on(await relaunch()), "back online, a later launch").toBe("pro");
  });

  it("one promo a launch: What's new first; Boat's credit offer waits for the next launch, a reload in this one included", async () => {
    returning(); storage.delete(BOAT_OFFER_NOTICE); storage.set(CLOUD_INTRO, "1"); desk.saved = null;
    const first = await launch();
    expect(on(first)).toBe("pro"); expect(first).not.toContain(BOAT);
    press("Not now"); await flush();
    expect(render(), "nothing else after it in this launch").toBe("");
    expect(await launch(), "a reload is the same launch").toBe("");
    const next = await relaunch();
    expect(on(next)).toBeNull(); expect(next).toContain(BOAT);
    expect(launchNotice()).toBe(BOAT_OFFER_NOTICE);
    expect(steps().map(props => props.action)).toEqual(["seen", "not_now"]);
  });

  it("a new install sees it once onboarding is done and a bot has answered, in a later launch than the welcome's, after MausBot's card", async () => {
    f.state.config.onboarding = { ...EMPTY_ONBOARDING };
    expect(on(await launch()), "onboarding not done").toBeNull();
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-10-16", version: 1, hintsSeen: [] };
    f.state.welcomeOpen = true;
    expect(on(await launch()), "the welcome").toBeNull();
    f.state.welcomeOpen = false; f.state.tourOpen = true;
    expect(on(await launch()), "the tour").toBeNull();
    f.state.tourOpen = false; f.state.bots = [{ tasks: [{ threadId: "first" }] }];
    expect(on(await launch()), "the first chat, before its first reply").toBeNull();
    f.state.bots = structuredClone(FIRST_REPLY); markWelcomeFinished();
    expect(on(await launch()), "the launch the welcome finished in").toBeNull();
    session.clear(); markLaunchDialog("mausbot");
    expect(on(await launch()), "the launch MausBot's first card took").toBeNull();
    expect(on(await relaunch())).toBe("pro");
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
    expect(on(await relaunch())).toBe("pro");
    f.state.bots[0].busy = true;
    expect(await settle(), "a turn starts while it is up").toBe("");
    f.state.bots[0].busy = false;
    expect(on(await settle()), "back once the turn ends").toBe("pro");
  });

  it("Not now, the X, Escape and a click outside end it for good on this computer and in the workspace", async () => {
    for (const how of ["Not now", "Close", "Escape", "outside"] as const) {
      fresh();
      expect(on(await relaunch()), how).toBe("pro");
      if (how === "Escape") expect(keydown("Escape").preventDefault, how).toHaveBeenCalled();
      else if (how === "outside") {
        const backdrop = tree().find(node => typeof node.props.onMouseDown === "function")!;
        backdrop.props.onMouseDown({ target: {}, currentTarget: backdrop });
        expect(on(render()), "a press inside the dialog").toBe("pro");
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
    expect(on(await relaunch())).toBe("pro");
  });

  it("a new campaign id shows it once more to someone who closed an earlier one", async () => {
    for (const earlier of ["cloud-pro-update-2026-10", "whats-new-2026-10"]) {
      fresh(); storage.set(earlier, "1"); desk.saved = { seen: [earlier] }; f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), earlier];
      expect(on(await relaunch()), earlier).toBe("pro");
    }
  });

  it("never in a remote client's window, on My Cloud's or a saved server's page, on a branded build, a desktop an organization runs, or one that sells no Cloud", async () => {
    (window.ogb as Record<string, any>).remoteClient.active = true;
    expect(on(await relaunch())).toBeNull();
    showWindow(LOCAL_ORIGIN); f.brand = "file";
    expect(on(await relaunch())).toBeNull();
    f.brand = "default"; desk.offered = false;
    expect(on(await relaunch())).toBeNull();
    desk.offered = true;
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    expect(on(await relaunch())).toBeNull();
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(on(await relaunch())).toBeNull();
    viewer = { hosted: true, canSave: true }; showWindow(VPS);
    expect(on(await relaunch())).toBeNull();
    expect(steps()).toEqual([]); expect(seenOnDesktop()).toEqual([]);
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
    expect(answered, "a bot has answered, but in the launch the welcome finished").not.toContain(QUESTION); expect(answered).not.toContain(POPUP);
    session.clear();
    const later = await launch();
    expect(later).toContain(POPUP); expect(later).not.toContain(QUESTION);
    press("Not now"); await flush();
    expect(render(), "right after the popup closes, as #3379 orders it").toContain(QUESTION);
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
    for (const part of ['role="dialog"', 'aria-modal="true"', 'role="switch"', 'aria-checked="false"', "Switch any time in Settings → General."]) expect(html).toContain(part);
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

  it("is one popup at a time: it comes before What's new, which waits for a later launch", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    const first = await launch();
    expect(first).toContain(TITLE); expect(first).not.toContain(POPUP);
    press("Done"); await flush();
    expect(render()).toBe("");
    session.clear();
    const later = await launch();
    expect(later).toContain(POPUP); expect(later).not.toContain(TITLE);
  });
});

describe("bots in two places", () => {
  const GARAGE = { key: "server:https://garage.example.test", name: "Garage server", kind: "server" as const };
  const BODY = "Your bots live in two places, so they can&#x27;t work together. Bring them together on Garage server?";
  let suggest: typeof GARAGE | null;
  let accepted: string[], dismissed: string[];
  beforeEach(() => {
    suggest = GARAGE; accepted = []; dismissed = [];
    desk.handlers.set("two-places:state", async () => ({ suggest }));
    desk.handlers.set("two-places:accept", async (_event, key) => { accepted.push(String(key)); suggest = null; return { suggest }; });
    desk.handlers.set("two-places:dismiss", async (_event, key) => { dismissed.push(String(key)); suggest = null; return { suggest }; });
  });

  it("one plain card on this computer's page, before any promotion; its one tap asks main to bring them together there", async () => {
    returning();
    storage.delete(PRODUCT_HUNT_NOTICE);
    const html = await launch();
    expect(html).toContain('data-notice="two-places"');
    expect(html).toContain("Bring your bots together");
    expect(html).toContain(BODY);
    expect(html).not.toContain(STAR);
    press("Bring them together");
    await flush();
    expect(accepted).toEqual([GARAGE.key]);
    expect(track).toHaveBeenCalledWith("two_places_card", { action: "bring", kind: "server" });
    expect(await settle()).not.toContain('data-notice="two-places"');
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
