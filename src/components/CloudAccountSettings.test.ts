import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], platform: "darwin" as DesktopCapabilities["host"]["platform"] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: f.platform } }, ready: true }) }));
import { CloudAccountSettings, CloudPlanOnCloud, cloudLinkAction, cloudPlanLabel } from "./CloudAccountSettings";
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
function render(props?: { linkRequest?: number; cloudHome?: boolean; onConnectPhone?: () => void }) { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudAccountSettings(props); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)); return { html, nodes: nodes(tree) }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const click = (label: string) => { const button = render().nodes.find(node => node.type === "button" && node.props.children === label); expect(button).toBeTruthy(); button!.props.onClick!(); };
let bridge: CloudAccountBridge, push: (state: CloudAccountState) => void;
const free: CloudAccountState = { status: "connected", account: { id: "fixture", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } };
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; f.platform = "darwin"; push = () => {};
  bridge = { state: vi.fn().mockResolvedValue({ status: "signed-out" }), begin: vi.fn().mockResolvedValue({ status: "connecting" }),
    signInAgain: vi.fn().mockResolvedValue({ status: "connecting" }),
    reopen: vi.fn().mockResolvedValue({ status: "connecting" }), cancel: vi.fn().mockResolvedValue({ status: "signed-out" }),
    refresh: vi.fn().mockResolvedValue(free), signOut: vi.fn().mockResolvedValue({ status: "signed-out" }), openDashboard: vi.fn().mockResolvedValue(free),
    connectHome: vi.fn().mockResolvedValue(free), connectHomeForPhone: vi.fn().mockResolvedValue(free), onState: vi.fn(callback => { push = callback; return () => {}; }) };
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge } }); vi.stubGlobal("fetch", vi.fn()); setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });
async function ready(state: CloudAccountState = { status: "signed-out" }) { vi.mocked(bridge.state).mockResolvedValueOnce(state); render(); const cleanup = f.effects[0](); await flush(); return cleanup; }
it("loads optional account state without enrollment/network and delegates sign-in without arguments", async () => {
  await ready(); expect(bridge.begin).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(render().html).toContain("Free local use"); expect(render().html).toContain("separate from organization sign-in");
  click("Sign in to OMB Cloud"); await flush(); expect(bridge.begin).toHaveBeenCalledExactlyOnceWith();
});
it("checkout opens the dashboard but only a verified native update displays Pro; unavailable/revoked states remove it", async () => {
  await ready(free); click("Choose a Cloud plan in your browser"); await flush(); expect(bridge.openDashboard).toHaveBeenCalledExactlyOnceWith();
  expect(render().html).not.toContain("Pro active");
  push({ ...free, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 } }); expect(render().html).toContain("Pro active");
  push({ status: "unavailable" }); expect(render().html).not.toContain("Pro active");
  push({ status: "reauth-required" }); expect(render().html).not.toContain("Pro active");
});
it("names the verified tier; no tier is today's Pro, and a tier newer than the app reads Cloud", async () => {
  await ready(free);
  for (const [tier, text] of [[undefined, "Pro active"], ["personal", "Personal active"], ["pro", "Pro active"], ["max", "Max active"], ["team", "Cloud active"], ["constructor", "Cloud active"]] as const) {
    push({ ...free, entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: 1_900_000_000_000, version: 3 } });
    expect(render().html).toContain(`${text} · verified by OMB Cloud`); expect(render().html).toContain("Manage Cloud subscription");
  }
  // A lapsed plan is not "Free account", and nobody is asked to choose a plan again.
  push({ ...free, entitlement: { plan: "pro", tier: "max", status: "inactive", expiresAt: null, version: 4 } });
  expect(render().html).toContain("Max · not active right now"); expect(render().html).not.toContain("Max active");
  expect(render().html).not.toContain("Free account"); expect(render().html).not.toContain("Choose a Cloud plan");
  expect(cloudPlanLabel()).toBe("Pro"); expect(cloudPlanLabel("toString")).toBe("Cloud");
});
it("sign-out requires confirmation and preserves local and organization wording", async () => {
  await ready(free); click("Sign out of OMB Cloud"); expect(bridge.signOut).not.toHaveBeenCalled();
  expect(render().html).toContain("does not cancel your subscription"); click("Keep signed in"); expect(bridge.signOut).not.toHaveBeenCalled();
  click("Sign out of OMB Cloud"); click("Sign out of OMB Cloud"); await flush(); expect(bridge.signOut).toHaveBeenCalledExactlyOnceWith();
  expect(render().html).toContain("Sign in to OMB Cloud"); expect(fetch).not.toHaveBeenCalled();
});
it("never accesses account bridge from remote companion pages", async () => {
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge, remoteClient: { active: true } } }); render(); f.effects[0](); await flush();
  expect(bridge.state).not.toHaveBeenCalled(); expect(bridge.onState).not.toHaveBeenCalled(); expect(render().html).toContain("local desktop app");
});
it("a late initial snapshot cannot replace a newer revoked state", async () => {
  let resolve!: (state: CloudAccountState) => void; vi.mocked(bridge.state).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(); f.effects[0](); push({ status: "reauth-required" }); resolve(free); await flush(); expect(render().html).toContain("no longer signed in to OMB Cloud");
});

const all = (html: string, texts: string[]) => texts.forEach(text => expect(html).toContain(text));
const none = (html: string, texts: string[]) => texts.forEach(text => expect(html).not.toContain(text));
const BUY = ["Choose a Cloud plan", "Get Pro", "Free account"];
const ALARM = ["cannot currently be verified", "unavailable until", "expired or was revoked"];
const button = (label: string) => render().nodes.find(node => node.type === "button" && node.props.children === label);

it("a failed re-check keeps the plan, Cloud and Connect, and only says it is checking", async () => {
  const machine = { status: "ready" as const, origin: "https://home-7f3k2.fly.dev" };
  await ready({ ...free, entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1_900_000_000_000, version: 3 }, machine, checking: true });
  const { html } = render();
  all(html, ["Max active · verified by OMB Cloud", "Checking with OMB Cloud…", "Connect to my Cloud", "Manage Cloud subscription"]);
  none(html, [...BUY, ...ALARM]);
});
it("OMB Cloud out of reach: the plan last verified stays named, calmly, with no offer to buy", async () => {
  await ready({ status: "unavailable", message: "unreachable", account: { id: "fixture", email: "person@example.test" }, lastPlan: { tier: "personal", active: true } });
  let html = render().html;
  all(html, ["Personal · checking with OMB Cloud…", "be reached right now, so this app", "Nothing has changed with your plan", "Manage Cloud subscription"]);
  none(html, [...BUY, ...ALARM]);
  // With no plan known, still no offer: only the dashboard.
  push({ status: "unavailable", message: "unreachable", account: { id: "fixture", email: "person@example.test" } });
  html = render().html; expect(html).toContain("Open your Cloud dashboard"); none(html, [...BUY, ...ALARM]);
});
// Clearing the saved sign-in failed: Sign out again is the retry, on every
// platform, so the message names that button and no keychain.
it("a saved sign-in that couldn't be cleared names the Sign out button on the card", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    f.values = []; f.platform = platform;
    await ready({ status: "unavailable", message: "signout-storage-failed" });
    const { html } = render();
    all(html, ["could not be read or cleared", "Choose Sign out of OMB Cloud, then sign in again."]);
    none(html, ["keychain"]);
    expect(button("Sign out of OMB Cloud")).toBeTruthy();
  }
});
// A saved sign-in that may only be locked is kept and read again by itself.
// Signing out there would delete it before the app reads it, and could not
// revoke it on the Cloud. Where a keychain can be locked, unlocking it is the
// one step; Windows has nothing to unlock.
const statusText = () => render().nodes.filter(node => node.type === "p" && (node.props as { role?: string }).role === "status")
  .map(node => Children.toArray(node.props.children).filter(child => typeof child === "string").join("")).join(" ");
it("a saved sign-in that may only be locked says the app tries again, with this computer's one step, never Sign out", async () => {
  for (const [platform, step] of [["darwin", "Unlock your keychain"], ["linux", "Unlock your system keyring"], ["win32", "nothing you need to do"]] as const) {
    f.values = []; f.platform = platform;
    await ready({ status: "unavailable", message: "restore-failed" });
    const message = statusText();
    expect(message, platform).toContain("tries again by itself");
    expect(message, platform).toContain(step);
    expect(message, platform).not.toMatch(/sign out|sign in again/i);
    if (platform === "win32") expect(message).not.toMatch(/keychain|keyring|unlock/i);
  }
});
it("a sign-in that ended asks to sign in again, keeps the plan, and offers nothing to buy", async () => {
  await ready({ status: "reauth-required", message: "expired", account: { id: "fixture", email: "person@example.test" }, lastPlan: { tier: "max", active: true } });
  const { html } = render();
  all(html, ["Max plan", "Your sign-in on this computer has ended", "Your plan is not affected", "Sign in again"]);
  none(html, [...BUY, ...ALARM, "Manage Cloud subscription"]);
  expect(button("Refresh")).toBeUndefined();
  button("Sign in again")!.props.onClick!(); await flush();
  expect(bridge.signInAgain).toHaveBeenCalledExactlyOnceWith(); expect(bridge.signOut).not.toHaveBeenCalled(); expect(bridge.begin).not.toHaveBeenCalled();
  push({ status: "reauth-required", message: "access-ended", account: { id: "fixture", email: "person@example.test" } });
  all(render().html, ["no longer signed in to OMB Cloud", "Sign in again"]); none(render().html, BUY);
});
it("a payment problem or a stopped Cloud is never 'Free account' with a plan to choose", async () => {
  const origin = "https://home-7f3k2.fly.dev";
  await ready({ ...free, machine: { status: "payment-problem", origin } });
  let html = render().html;
  all(html, ["OMB Cloud · not active right now", "problem with your payment", "Update payment in your browser"]); none(html, BUY);
  push({ ...free, machine: { status: "stopped", origin } });
  html = render().html; all(html, ["Subscribe again in your Cloud dashboard", "Open your Cloud dashboard"]); none(html, BUY);
  // The Cloud's card says why; the account card does not say it twice.
  expect(html).not.toContain("shows why and how to fix it");
  push({ ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 4 } });
  all(render().html, ["Pro · not active right now", "shows why and how to fix it"]);
});
it("a payment being linked says so, with its date, and asks nobody to pay again", async () => {
  await ready({ ...free, purchase: { state: "confirming", tier: "personal", paidAt: Date.UTC(2026, 9, 2, 12) } });
  const html = render().html;
  all(html, ["Personal · payment received", "Received Oct 2, 2026", "no need to pay again", "Open your Cloud dashboard"]); none(html, BUY);
  push({ ...free, purchase: { state: "held" } });
  all(render().html, ["OMB Cloud · payment received", "linking your payment"]); none(render().html, BUY);
});
it("a free account may choose a plan, and is told what to do if it bought with another email", async () => {
  await ready(free);
  all(render().html, ["Free account", "Choose a Cloud plan in your browser", "Bought a plan with a different email?"]);
  button("Sign out and use that email")!.props.onClick!();
  expect(render().html).toContain("does not cancel your subscription"); expect(bridge.signOut).not.toHaveBeenCalled();
});
it("shows the sign-in code plainly, with how long it works", async () => {
  await ready({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: Date.UTC(2026, 9, 2, 12, 15) } });
  const html = render().html;
  all(html, ["Check that your browser shows this code:", "ABCDE-FGHJK", "The code works until"]);
  expect(html).not.toContain("<details"); expect(html).not.toContain("Security details");
  push({ status: "signed-out", message: "enrollment-expired" });
  all(render().html, ["The sign-in code expired", "Sign in to OMB Cloud"]);
});
it("while a saved sign-in is read, nothing is offered and the Cloud link waits", async () => {
  await ready({ status: "signed-out", message: "restoring" });
  const html = render().html;
  expect(html).toContain("Loading Cloud account"); none(html, ["Sign in to OMB Cloud", "could not be completed"]);
  expect(cloudLinkAction({ status: "signed-out", message: "restoring" }, { arrived: true, connected: false })).toBeNull();
  render({ linkRequest: 1 }); f.effects[1](); await flush(); expect(bridge.begin).not.toHaveBeenCalled();
});
it("a saved sign-in that could not be read was removed: one line says so, and Sign in is the next step", async () => {
  await ready({ status: "signed-out", message: "restore-removed" });
  const html = render().html;
  expect(html).toContain("Cloud sign-in couldn&#x27;t be read, so it was removed. Sign in again.");
  none(html, ["could not be completed", "Unlock your system keychain"]);
  expect(button("Sign in to OMB Cloud")).toBeTruthy();
});
it("setting up shows the Cloud page's steps, a slow setup and a failed setup's next try", async () => {
  const paid = { ...free, entitlement: { plan: "pro" as const, status: "active" as const, expiresAt: 1_900_000_000_000, version: 2 } };
  // Paid, and the Admin does not list the Cloud yet: it is being set up.
  await ready(paid);
  expect(render().html).toContain('data-cloud-home="provisioning"');
  push({ ...paid, machine: { status: "provisioning", setup: { step: "starting" } } });
  let html = render().html;
  all(html, ['data-cloud-setup="starting"', "Reserving your machine", "Preparing storage", "Starting your Cloud", "Checking it", 'aria-current="step"']);
  expect(html.indexOf('aria-current="step"')).toBeGreaterThan(html.indexOf("Preparing storage"));
  push({ ...paid, machine: { status: "provisioning", setup: { step: "starting", slow: true } } });
  expect(render().html).toContain("taking longer than usual");
  push({ ...paid, machine: { status: "failed", retryAt: Date.UTC(2026, 9, 2, 12, 30) } });
  html = render().html; all(html, ["Nothing was lost", "tried again automatically at"]);
});
it("on the person's own Cloud, Settings shows the plan read only, with Manage and Switch to this computer", async () => {
  const plan = { state: vi.fn().mockResolvedValue({ status: "paid", tier: "max" }), manage: vi.fn().mockResolvedValue(undefined), useThisComputer: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("window", { ogb: { cloudPlan: plan } });
  const settings = render({ cloudHome: true }).html; expect(settings).not.toContain("local desktop app");
  // Any other server open in this window (a VPS, a hosted workspace) has no plan of this person's to show.
  expect(render().html).toContain("local desktop app"); expect(render().html).not.toContain("Manage in your browser");
  const view = () => { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudPlanOnCloud({ bridge: plan }); return tree; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) }; };
  view(); f.effects[0](); await flush();
  all(view().html, ["Max active · verified by OMB Cloud", "Manage in your browser", "Switch to this computer"]); none(view().html, BUY);
  view().nodes.find(node => node.type === "button" && node.props.children === "Manage in your browser")!.props.onClick!();
  view().nodes.find(node => node.type === "button" && node.props.children === "Switch to this computer")!.props.onClick!();
  await flush(); expect(plan.manage).toHaveBeenCalledExactlyOnceWith(); expect(plan.useThisComputer).toHaveBeenCalledExactlyOnceWith();
  plan.state.mockResolvedValueOnce({ status: "checking", tier: "pro" }); f.values = []; view(); f.effects[0](); await flush();
  expect(view().html).toContain("Pro · checking with OMB Cloud…");
  // This computer's sign-in ended: the plan stays named, with the one next step, and nothing to buy.
  plan.state.mockResolvedValueOnce({ status: "signin", tier: "max" }); f.values = []; view(); f.effects[0](); await flush();
  all(view().html, ["Max plan", "This computer needs to sign in to OMB Cloud again", "Switch to this computer"]); none(view().html, [...BUY, "Could not complete"]);
  // This app cannot vouch for this Cloud: where the plan is managed, and nothing that would fail.
  plan.state.mockRejectedValueOnce(new Error("cloud-plan:state is only available in this app's window")); f.values = []; view(); f.effects[0](); await flush();
  const refused = view();
  expect(refused.html).toContain("Your plan is managed in the OpenMausBot app on your computer.");
  expect(refused.nodes.some(node => node.type === "button")).toBe(false);
  none(refused.html, ["Could not complete", 'role="alert"', "Loading"]);
});

const pro: CloudAccountState = { ...free, entitlement: { plan: "pro", status: "active", expiresAt: 1_900_000_000_000, version: 2 } };
const origin = "https://home-7f3k2.fly.dev";
it("stays exactly as before when the account has no Cloud machine", async () => {
  await ready(free);
  expect(render().html).not.toContain("Your Cloud");
  expect(render().html).not.toContain("Connect to my Cloud");
  push(pro); expect(render().html).not.toContain("Connect to my Cloud");
});
it.each([
  ["provisioning", "Setting up your Cloud", false],
  ["ready", "Your Cloud is ready", true],
  ["stopped", "Your Cloud is stopped", false],
  ["payment-problem", "problem with your payment", false],
  ["failed", "could not be set up yet", false],
] as const)("shows the %s machine state plainly", async (status, text, connectable) => {
  await ready({ ...pro, machine: { status, ...(status === "provisioning" ? {} : { origin }) } });
  const html = render().html;
  expect(html).toContain(`data-cloud-home="${status}"`);
  expect(html).toContain(text);
  expect(html.includes("Connect to my Cloud")).toBe(connectable);
  expect(html).not.toContain("Could not complete this Cloud action");
});
it("promises no included AI: the person signs in with their own account there", async () => {
  await ready({ ...pro, machine: { status: "ready", origin } });
  const html = render().html;
  expect(html).toContain("sign in there with your own Claude or ChatGPT account, or an API key");
  expect(html).not.toMatch(/included/i);
});
it("connects with one click, sending nothing from the page", async () => {
  await ready({ ...pro, machine: { status: "ready", origin } });
  click("Connect to my Cloud"); await flush();
  expect(bridge.connectHome).toHaveBeenCalledExactlyOnceWith();
});
it("reports a failed connection as its own message", async () => {
  vi.mocked(bridge.connectHome).mockRejectedValueOnce(new Error("offline"));
  const state = { ...pro, machine: { status: "ready" as const, origin } };
  vi.mocked(bridge.state).mockResolvedValue(state);
  await ready(state);
  click("Connect to my Cloud"); await flush();
  expect(render().html).toContain("Could not connect to your Cloud");
  expect(render().html).not.toContain("Could not complete this Cloud action");
});

// openmausbot://cloud: React re-runs the link effect (the second one) after
// each render; these helpers do the same for a link-opened and a normal view.
const linked = (linkRequest = 1) => { render({ linkRequest }); f.effects[1](); };
const visit = () => { render(); f.effects[1](); };
const readyCloud: CloudAccountState = { ...pro, machine: { status: "ready", origin } };
it("opened by the Cloud link while signed out, starts the existing device sign-in once", async () => {
  await ready();
  linked(); await flush();
  expect(bridge.begin).toHaveBeenCalledExactlyOnceWith();
  expect(render().html).toContain("approve this computer in your browser");
  linked(); push({ status: "signed-out", message: "enrollment-ended" }); linked(); await flush();
  expect(bridge.begin).toHaveBeenCalledOnce();
  expect(bridge.connectHome).not.toHaveBeenCalled();
});
it("opened by the Cloud link while signed in and Ready, connects with no click", async () => {
  await ready(readyCloud);
  linked(); await flush();
  expect(bridge.connectHome).toHaveBeenCalledExactlyOnceWith();
  expect(bridge.begin).not.toHaveBeenCalled();
  push(readyCloud); linked(); await flush();
  expect(bridge.connectHome).toHaveBeenCalledOnce();
});
it("connects when the sign-in the link started completes and the Cloud becomes Ready", async () => {
  await ready();
  linked(); await flush();
  push({ ...pro, machine: { status: "provisioning" } }); linked(); await flush();
  expect(render().html).toContain("Setting up your Cloud");
  expect(bridge.connectHome).not.toHaveBeenCalled();
  push(readyCloud); linked(); await flush();
  expect(bridge.connectHome).toHaveBeenCalledExactlyOnceWith();
  expect(bridge.begin).toHaveBeenCalledOnce();
});
it("only shows the status of a Cloud that is not Ready, and a later sign-out starts nothing", async () => {
  await ready({ ...pro, machine: { status: "stopped", origin } });
  linked(); await flush();
  for (const machine of [{ status: "payment-problem", origin }, { status: "failed", origin }, { status: "provisioning" }] as const) {
    push({ ...pro, machine }); linked(); await flush();
    expect(render().html).toContain(`data-cloud-home="${machine.status}"`);
  }
  push({ status: "signed-out" }); linked(); await flush();
  expect(render().html).toContain("Sign in to OMB Cloud");
  expect(bridge.connectHome).not.toHaveBeenCalled();
  expect(bridge.begin).not.toHaveBeenCalled();
});
it("a normal visit never signs in or connects by itself", async () => {
  await ready();
  visit(); await flush();
  expect(bridge.begin).not.toHaveBeenCalled();
  push(readyCloud); visit(); await flush();
  expect(bridge.connectHome).not.toHaveBeenCalled();
  expect(render().html).toContain("Connect to my Cloud");
});
it("a failed automatic connection waits for the next link; a normal visit in between stops it", async () => {
  vi.mocked(bridge.connectHome).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(bridge.state).mockResolvedValue(readyCloud);
  await ready(readyCloud);
  linked(1); await flush();
  expect(render().html).toContain("Could not connect to your Cloud");
  push(readyCloud); linked(1); await flush();
  expect(bridge.connectHome).toHaveBeenCalledOnce();
  visit(); push(readyCloud); visit(); await flush();
  expect(bridge.connectHome).toHaveBeenCalledOnce();
  linked(1); await flush();
  expect(bridge.connectHome).toHaveBeenCalledTimes(2);
});
it("decides from the first snapshot after the link, and connects to a Ready Cloud once", () => {
  const arrived = { arrived: true, connected: false }, later = { arrived: false, connected: false };
  expect(cloudLinkAction({ status: "signed-out" }, arrived)).toBe("sign-in");
  expect(cloudLinkAction({ status: "signed-out", message: "enrollment-ended" }, later)).toBeNull();
  expect(cloudLinkAction(readyCloud, arrived)).toBe("connect");
  expect(cloudLinkAction(readyCloud, later)).toBe("connect");
  expect(cloudLinkAction(readyCloud, { arrived: false, connected: true })).toBeNull();
  for (const state of [{ status: "connecting" }, { status: "reauth-required" }, { status: "unavailable" }, free, pro,
    { ...pro, machine: { status: "provisioning" } }, { status: "unavailable", machine: { status: "ready", origin } }] as CloudAccountState[]) {
    expect(cloudLinkAction(state, arrived)).toBeNull();
  }
});

// "Use your Cloud on your phone": a paid plan's phone app on the Cloud.
const PHONE = "Use your Cloud on your phone";
const STEPS = ["Server menu → My Cloud", "choose Connect your phone"];
it("a paid plan with a Ready Cloud opens it on its phone pairing with one click, sending nothing from the page", async () => {
  await ready(readyCloud);
  const html = render().html;
  expect(html).toContain('data-cloud-phone="open"'); none(html, STEPS);
  click(PHONE); await flush();
  expect(bridge.connectHomeForPhone).toHaveBeenCalledExactlyOnceWith();
  expect(bridge.connectHome).not.toHaveBeenCalled();
});
it("before the Cloud is Ready, explains the two steps instead of offering a switch that cannot work", async () => {
  for (const machine of [{ status: "provisioning" }, { status: "stopped", origin }, { status: "payment-problem", origin }, { status: "failed", origin }] as const) {
    f.values = []; await ready({ ...pro, machine });
    const html = render().html;
    expect(html).toContain('data-cloud-phone="steps"'); all(html, ["is not ready yet", ...STEPS]);
    expect(button(PHONE)).toBeUndefined();
  }
  // a paid plan whose Cloud the Admin has not listed yet is being set up
  f.values = []; await ready(pro);
  expect(render().html).toContain('data-cloud-phone="steps"');
});
it("a switch that failed says so, with the two steps, and can be tried again", async () => {
  vi.mocked(bridge.connectHomeForPhone).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(bridge.state).mockResolvedValue(readyCloud);
  await ready(readyCloud);
  click(PHONE); await flush();
  const html = render().html;
  all(html, ["Could not open your Cloud.", "You can also do it in two steps", ...STEPS]);
  expect(html).not.toContain("Could not complete this Cloud action");
  click(PHONE); await flush();
  expect(bridge.connectHomeForPhone).toHaveBeenCalledTimes(2);
  expect(render().html).not.toContain("Could not open your Cloud.");
});
it("is not offered without a paid plan", async () => {
  await ready(free); expect(render().html).not.toContain(PHONE);
  push({ ...pro, entitlement: { plan: "pro", status: "inactive", expiresAt: null, version: 4 }, machine: { status: "stopped", origin } });
  expect(render().html).not.toContain(PHONE);
  push({ status: "signed-out" }); expect(render().html).not.toContain(PHONE);
});
it("on the Cloud itself, opens this Cloud's phone pairing directly; never where this app cannot vouch for it", async () => {
  const plan = { state: vi.fn().mockResolvedValue({ status: "paid", tier: "pro" }), manage: vi.fn(), useThisComputer: vi.fn() };
  const onConnectPhone = vi.fn();
  const view = (props: { onConnectPhone?: () => void }) => { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudPlanOnCloud({ bridge: plan, ...props }); return tree; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) }; };
  // nothing to offer before this app has vouched for this Cloud
  expect(view({ onConnectPhone }).html).not.toContain(PHONE);
  f.effects[0](); await flush();
  view({ onConnectPhone }).nodes.find(node => node.type === "button" && node.props.children === PHONE)!.props.onClick!();
  expect(onConnectPhone).toHaveBeenCalledOnce();
  expect(plan.manage).not.toHaveBeenCalled();
  // CloudAccountSettings hands it on, on the person's own Cloud
  vi.stubGlobal("window", { ogb: { cloudPlan: plan } });
  const [card] = render({ cloudHome: true, onConnectPhone }).nodes as unknown as Array<ReactElement<{ onConnectPhone?: () => void }>>;
  expect(card!.type).toBe(CloudPlanOnCloud); expect(card!.props.onConnectPhone).toBe(onConnectPhone);
  expect(view({}).html).not.toContain(PHONE);
  plan.state.mockRejectedValueOnce(new Error("cloud-plan:state is only available in this app's window")); f.values = []; view({ onConnectPhone }); f.effects[0](); await flush();
  expect(view({ onConnectPhone }).nodes.some(node => node.type === "button")).toBe(false);
});

it("once the Cloud is ready, offers Copy this computer here for the Cloud itself", async () => {
  const move = { state: vi.fn().mockResolvedValue({ phase: "idle", local: null, cloud: null, suggest: false, destination: { id: "cloud", name: "My Cloud", origin, kind: "cloud" }, blocked: null }),
    start: vi.fn(), cancel: vi.fn(), restorePrevious: vi.fn(), dismiss: vi.fn(), onState: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge, cloudMove: move } });
  vi.mocked(bridge.state).mockResolvedValue(readyCloud);
  await ready(readyCloud);
  render();
  for (const effect of f.effects) effect();
  await flush();
  expect(move.state.mock.calls).toContainEqual(["cloud"]);
  expect(render().html).toContain("Copy this computer&#x27;s bots and chats");
});
