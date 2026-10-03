import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { withTourFinished, withTourReset } from "@/lib/guided-tour";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { AppNotices } from "./AppNotices";
import { ProSettingsCard } from "./ProIntroduction";
import { buyOfferAllowed, cloudPlanView } from "@/lib/cloud-plan";
import { PRO_NOTICE, STAR_NOTICE } from "@/lib/notices";
import { api } from "@/state/store";

/** The earlier cards' dismissal ids, in browser storage and the workspace hint record. */
const EARLIER_DISMISSALS = ["pro-introduction-dismissed", "pro-introduction-dismissed-v2"];
const PLANS = "https://mausbot.com/pro#plans";
const GITHUB = "https://github.com/milind-soni/OpenMausBot";
const PRO_TITLE = "Your 24/7 working team";
const STAR_TITLE = "Enjoying OpenMausBot?";

let storage: Map<string, string>;
let push: (value: CloudAccountState) => void;
let openExternal: ReturnType<typeof vi.fn>;
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices)); };
/** The notice as a fresh launch sees it: the account snapshot kept, everything else re-read. */
const relaunch = () => { f.values = [f.values[0]]; return render(); };
const signedOut = { status: "signed-out" } as const;
/** A conversation from an earlier launch that has had a reply: someone who has used the app. */
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const seenPro = () => { f.state.config.onboarding.hintsSeen.push(PRO_NOTICE); };
const putHint = (id: string) => ({ method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [...f.state.config.onboarding.hintsSeen, id] } }) });
beforeEach(async () => {
  vi.clearAllMocks(); storage = new Map(); f.index = 0; f.values = []; f.updater = null; f.dispatch = vi.fn();
  f.state = { connected: true, bots: [], groups: [], config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  openExternal = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("window", { ogb: { openExternal, cloudAccount: { state: () => Promise.resolve(signedOut), onState: (cb: typeof push) => { push = cb; return () => {}; } } } });
  render(); f.effects.forEach(effect => effect()); await Promise.resolve();
});
afterEach(() => vi.unstubAllGlobals());

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; onDismiss?: () => void; onSignIn?: () => void }>;
/** Every element the notice draws, with its own components expanded (hooks are mocked). */
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const notice = () => { f.index = 0; f.effects = []; return AppNotices({}); };
const button = (label: string) => nodes(notice()).find(node => node.type === "button" && renderToStaticMarkup(node).includes(label));
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// ── the Pro card ───────────────────────────────────────────────────────

it("says the owner's words, in order, without enrolling, charging or refreshing an account", () => {
  const html = render();
  const words = [PRO_TITLE, "Move your bots to OpenMausBot Cloud and they keep working when your laptop is closed.",
    "Always on: chats, routines and replies run in the cloud", "Cloud computers your bots can use, with a live desktop you can watch",
    "Scheduled tasks, voice and your phone included", "Priority support on Pro and Max",
    "Personal $29 · Pro $49 · Max $99 a month", "Prices are plus applicable tax, shown at checkout.",
    "Get your 24/7 working team", "Not now", "Local stays free. Model usage is separate."];
  for (const text of words) expect(html).toContain(text);
  for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]), words[i]).toBeLessThanOrEqual(html.indexOf(words[i]));
  // One way on, and no launch-price wording.
  for (const gone of ["See all plans", "first 100", "launch price", "$89", "Get Pro", "Don’t show again", "/month"]) expect(html).not.toContain(gone);
  for (const markup of ["<s>", "<s ", "<del", "<strike", "line-through"]) expect(html).not.toContain(markup);
  expect(html).not.toContain(STAR_TITLE);
  expect(api).not.toHaveBeenCalled(); expect(openExternal).not.toHaveBeenCalled();
  expect(html).not.toContain('aria-modal="true"');
});
it("its button opens the plans at mausbot.com/pro#plans, then the card is gone for good", async () => {
  button("Get your 24/7 working team")!.props.onClick!(); await flush();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(PLANS);
  expect(storage.get(PRO_NOTICE)).toBe("1");
  expect(api).toHaveBeenCalledWith("/api/config", putHint(PRO_NOTICE));
  expect(render()).toBe("");
});
it("a browser that does not open keeps the card and says so", async () => {
  openExternal.mockRejectedValueOnce(new Error("no browser"));
  button("Get your 24/7 working team")!.props.onClick!(); await flush();
  expect(storage.get(PRO_NOTICE)).toBeUndefined();
  expect(render()).toContain("Could not open your browser. Please try again.");
});
it("shows once more to everyone who dismissed an earlier card, then stays dismissed", async () => {
  for (const id of EARLIER_DISMISSALS) { storage.set(id, "1"); f.state.config.onboarding.hintsSeen.push(id); }
  expect(relaunch()).toContain(PRO_TITLE);
  button("Not now")!.props.onClick!(); await flush();
  expect(storage.get(PRO_NOTICE)).toBe("1");
  expect(api).toHaveBeenCalledWith("/api/config", putHint(PRO_NOTICE));
  expect(render()).toBe("");
  expect(relaunch()).toBe("");
  // Browser storage gone and only the earlier workspace hints left: it would show again...
  storage.clear();
  expect(relaunch()).toContain(PRO_TITLE);
  // ...so the workspace record carries this dismissal too.
  seenPro();
  expect(relaunch()).toBe("");
});
it("the X and Escape dismiss it for good too", async () => {
  const card = nodes(notice()).find(node => node.type === "aside")! as ReactElement<{ onKeyDown: (event: unknown) => void }>;
  const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
  card.props.onKeyDown(event); await flush();
  expect(event.preventDefault).toHaveBeenCalled();
  expect(storage.get(PRO_NOTICE)).toBe("1");
  storage.clear(); expect(relaunch()).toContain(PRO_TITLE);
  nodes(notice()).find(node => node.type === "button" && (node.props as { "aria-label"?: string })["aria-label"] === "Dismiss for good")!.props.onClick!();
  expect(storage.get(PRO_NOTICE)).toBe("1"); expect(render()).toBe("");
});
it("honours a workspace dismissal after browser storage is cleared and a tour is replayed", () => {
  seenPro();
  expect(withTourReset(f.state.config.onboarding)).toContain(PRO_NOTICE);
  expect(render()).toBe("");
});
it("never offers a plan to anyone who pays, may pay, or whose state is unknown", () => {
  const plan = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 }, ...extra });
  const paid = (tier?: string, status: "active" | "inactive" = "active") => ({ plan: "pro" as const, ...(tier ? { tier } : {}), status, expiresAt: status === "active" ? 1_900_000_000_000 : null, version: 2 });
  const nobodyToSell: Array<CloudAccountState | null> = [
    null, { status: "signed-out", message: "restoring" }, { status: "connecting" },
    plan({ entitlement: paid("max") }), plan({ entitlement: paid("personal"), checking: true }), plan({ entitlement: paid("pro", "inactive") }),
    plan({ machine: { status: "payment-problem", origin: "https://home.fly.dev" } }), plan({ machine: { status: "stopped" } }),
    plan({ purchase: { state: "confirming", tier: "personal" } }), plan({ purchase: { state: "held" } }),
    { status: "unavailable", lastPlan: { tier: "max", active: true } }, { status: "unavailable" },
    { status: "reauth-required", message: "expired", lastPlan: { active: true } }, { status: "reauth-required" },
  ];
  const offered = (state: CloudAccountState | null) => buyOfferAllowed(cloudPlanView(state));
  for (const state of nobodyToSell) expect(offered(state), JSON.stringify(state)).toBe(false);
  expect(offered(signedOut)).toBe(true);
  expect(offered(plan())).toBe(true);
  for (const state of nobodyToSell.slice(1) as CloudAccountState[]) { push(state); expect(render(), JSON.stringify(state)).not.toContain(PRO_TITLE); }
  // A payer who has used the app before gets the star instead, never the Pro card.
  returning();
  for (const state of nobodyToSell.slice(3) as CloudAccountState[]) {
    push(state); const html = relaunch();
    expect(html, JSON.stringify(state)).not.toContain(PRO_TITLE); expect(html, JSON.stringify(state)).toContain(STAR_TITLE);
  }
  push(plan()); expect(relaunch()).toContain(PRO_TITLE);
});
it("signed out, it leads with signing in for someone who already has a plan; Sign in hides it for now, not for good", async () => {
  const html = render();
  expect(html).toContain("Already have a Cloud plan?");
  expect(html.indexOf("Already have a Cloud plan?")).toBeLessThan(html.indexOf("Get your 24/7 working team"));
  button(">Sign in<")!.props.onClick!();
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true });
  expect(storage.get(PRO_NOTICE)).toBeUndefined(); expect(api).not.toHaveBeenCalled();
  expect(render()).toBe("");
  expect(relaunch()).toContain(PRO_TITLE);
  push({ status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } });
  const free = render(); expect(free).toContain(PRO_TITLE); expect(free).not.toContain("Already have a Cloud plan?");
});

// ── the GitHub star ────────────────────────────────────────────────────

it("asks for a star once, after the Pro card, to someone who has used the app before", async () => {
  returning(); seenPro();
  const html = relaunch();
  for (const text of [STAR_TITLE, "A star on GitHub helps more people find it.", "Star on GitHub", "Not now"]) expect(html).toContain(text);
  expect(html).not.toContain(PRO_TITLE);
  button("Star on GitHub")!.props.onClick!(); await flush();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(GITHUB);
  expect(storage.get(STAR_NOTICE)).toBe("1");
  expect(api).toHaveBeenCalledWith("/api/config", putHint(STAR_NOTICE));
  expect(render()).toBe("");
  expect(relaunch()).toBe("");
  storage.clear(); f.state.config.onboarding.hintsSeen.push(STAR_NOTICE);
  expect(relaunch()).toBe("");
});
it("Not now dismisses the star for good too", async () => {
  returning(); seenPro(); relaunch();
  button("Not now")!.props.onClick!(); await flush();
  expect(openExternal).not.toHaveBeenCalled();
  expect(storage.get(STAR_NOTICE)).toBe("1");
  expect(api).toHaveBeenCalledWith("/api/config", putHint(STAR_NOTICE));
  expect(relaunch()).toBe("");
});
it("one notice at a time, and one per launch: the star waits for the launch after the Pro card", async () => {
  returning();
  const first = relaunch();
  expect(first).toContain(PRO_TITLE); expect(first).not.toContain(STAR_TITLE);
  button("Not now")!.props.onClick!(); await flush();
  expect(render()).toBe("");
  const next = relaunch();
  expect(next).toContain(STAR_TITLE); expect(next).not.toContain(PRO_TITLE);
});
it("the star waits while the plan is not known yet, so it never shows before the Pro card", () => {
  returning();
  f.values = []; expect(render()).toBe(""); // no account snapshot yet
  push({ status: "connecting" } as CloudAccountState); expect(render()).toBe("");
  push(signedOut); expect(render()).toContain(PRO_TITLE);
});
it("not to someone brand new: only after a conversation from an earlier launch has had a reply", () => {
  seenPro();
  expect(relaunch()).toBe("");
  f.state.bots = [{ tasks: [{ threadId: "t", createdAt: Date.now() + 60_000, usage: { turns: 4 } }] }];
  expect(relaunch()).toBe("");
  f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1 }, { threadId: "u", createdAt: 1, usage: { turns: 0 } }] }];
  expect(relaunch()).toBe("");
  returning(); expect(relaunch()).toContain(STAR_TITLE);
});
it("never during first run, the welcome flow or the guided tour", () => {
  returning(); seenPro();
  for (const key of ["welcomeOpen", "tourOpen"]) { f.state[key] = true; expect(relaunch(), key).toBe(""); f.state[key] = false; }
  const done = f.state.config.onboarding;
  f.state.config.onboarding = { ...done, hintsSeen: [PRO_NOTICE] }; // tour finished welcome, tour steps still ahead
  expect(relaunch()).toBe("");
  f.state.config.onboarding = { ...EMPTY_ONBOARDING, hintsSeen: [PRO_NOTICE] }; // welcome flow still due
  expect(relaunch()).toBe("");
  f.state.config.onboarding = done; expect(relaunch()).toContain(STAR_TITLE);
});

// ── shared quiet rules ─────────────────────────────────────────────────

const both = [["Pro", () => {}, PRO_TITLE], ["star", () => { returning(); seenPro(); }, STAR_TITLE]] as const;
it.each(both)("the %s notice is desktop-app only: never in a browser, on a remote page or for a Cloud guest", (_name, setup, title) => {
  setup(); expect(relaunch()).toContain(title);
  vi.stubGlobal("window", { ogb: undefined }); expect(relaunch()).toBe("");
  vi.stubGlobal("window", { ogb: { openExternal, remoteClient: { active: true }, cloudAccount: { state: () => Promise.resolve(signedOut), onState: () => () => {} } } });
  expect(relaunch()).toBe("");
});
it.each(both)("the %s notice does not interrupt dialogs, panels or setup", (_name, setup, title) => {
  setup();
  for (const key of ["appSettingsOpen", "settingsOpen", "newBotOpen", "pluginsOpen", "triggersOpen", "shortcutsOpen", "welcomeOpen", "tourOpen"]) {
    f.state[key] = true; expect(relaunch(), key).toBe(""); f.state[key] = false;
  }
  f.index = 0; f.effects = []; expect(renderToStaticMarkup(createElement(AppNotices, { quiet: true }))).toBe("");
  expect(relaunch()).toContain(title);
});
it.each(both)("the %s notice waits for the connection, busy threads and updates", (_name, setup, title) => {
  setup();
  f.state.connected = false; expect(relaunch()).toBe(""); f.state.connected = true;
  const bots = f.state.bots;
  f.state.bots = [...bots, { busy: true }]; expect(relaunch()).toBe("");
  f.state.bots = [...bots, { tasks: [{ busy: true }] }]; expect(relaunch()).toBe("");
  f.state.bots = bots; f.state.groups = [{ working: true }]; expect(relaunch()).toBe(""); f.state.groups = [];
  f.updater = { status: "available" }; expect(relaunch()).toBe(""); f.updater = null;
  expect(relaunch()).toContain(title);
});

// ── Settings ───────────────────────────────────────────────────────────

const settingsCard = (state: CloudAccountState) => { f.values = [state]; f.index = 0; return renderToStaticMarkup(createElement(ProSettingsCard)); };
it("Settings offers the same title, summary and button, whatever the introduction's dismissal", () => {
  seenPro(); storage.set(PRO_NOTICE, "1");
  const html = settingsCard(signedOut);
  for (const text of [PRO_TITLE, "Move your bots to OpenMausBot Cloud and they keep working when your laptop is closed.",
    "OMB Cloud plans from $29/month, plus applicable tax.", "Already have a Cloud plan?", "Get your 24/7 working team"]) expect(html).toContain(text);
  for (const gone of ["See all plans", "Get Pro", "first 100"]) expect(html).not.toContain(gone);
});
it("in Settings, someone with a plan sees that plan and the way to it, never an offer", () => {
  const plan = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 }, ...extra });
  const paid = (tier?: string, status: "active" | "inactive" = "active") => ({ plan: "pro" as const, ...(tier ? { tier } : {}), status, expiresAt: status === "active" ? 1_900_000_000_000 : null, version: 2 });
  for (const [state, text] of [
    [plan({ entitlement: paid("max") }), "Max active · verified by OMB Cloud"],
    [plan({ entitlement: paid("pro", "inactive") }), "Pro · not active right now"],
    [plan({ purchase: { state: "confirming", tier: "personal" } }), "Personal · payment received"],
    [{ status: "unavailable", lastPlan: { tier: "personal", active: true } }, "Personal · checking with OMB Cloud…"],
    [{ status: "reauth-required", message: "expired", lastPlan: { tier: "max", active: true } }, "Sign in again to use your Cloud on this computer"],
  ] as const) {
    const html = settingsCard(state as CloudAccountState);
    expect(html).toContain(text); expect(html).toContain("OMB Cloud settings");
    expect(html).not.toContain("Get your 24/7 working team"); expect(html).not.toContain("$29");
  }
  for (const state of [{ status: "unavailable" }, { status: "connecting" }, { status: "signed-out", message: "restoring" }] as CloudAccountState[]) expect(settingsCard(state)).toBe("");
  f.values = [plan({ entitlement: paid("max") })]; f.index = 0;
  let tree: ReactNode; function Capture() { tree = ProSettingsCard(); return tree; } renderToStaticMarkup(createElement(Capture));
  nodes(tree).find(node => node.type === "button" && node.props.children === "OMB Cloud settings")!.props.onClick!();
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
});
