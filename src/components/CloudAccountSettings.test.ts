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
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { bots: [{ name: "Ember" }] }, dispatch: vi.fn() }) }));
import { CloudAccountSettings, CloudPlanOnCloud, cloudLinkAction, cloudPlanLabel } from "./CloudAccountSettings";
import { CloudLending } from "./CloudLending";
import { LentComputersCard } from "./LentComputers";
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
function render(props?: { linkRequest?: number; cloudHome?: boolean; onConnectPhone?: () => void; onAddCloud?: () => void; onSignIn?: () => void }) { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudAccountSettings(props); return tree; }
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
  click("Sign in to your Cloud plan"); await flush(); expect(bridge.begin).toHaveBeenCalledExactlyOnceWith();
});
it("a free account starts in the Add a Cloud dialog, but only a verified native update displays Pro; unavailable/revoked states remove it", async () => {
  const onAddCloud = vi.fn();
  await ready(free); render({ onAddCloud }).nodes.find(node => node.type === "button" && node.props.children === "Add a Cloud")!.props.onClick!();
  expect(onAddCloud).toHaveBeenCalledOnce(); expect(bridge.openDashboard).not.toHaveBeenCalled();
  expect(render().html).not.toContain("Pro active");
  push({ ...free, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 } }); expect(render().html).toContain("Pro active");
  push({ status: "unavailable" }); expect(render().html).not.toContain("Pro active");
  push({ status: "reauth-required" }); expect(render().html).not.toContain("Pro active");
});
it("names the verified tier; no tier is today's Pro, and a tier newer than the app reads Cloud", async () => {
  await ready(free);
  for (const [tier, text] of [[undefined, "Pro active"], ["personal", "Personal active"], ["pro", "Pro active"], ["max", "Max active"], ["team", "Cloud active"], ["constructor", "Cloud active"]] as const) {
    push({ ...free, entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: 1_900_000_000_000, version: 3 } });
    expect(render().html).toContain(`${text} · verified by MausBot Cloud`); expect(render().html).toContain("Manage Cloud subscription");
  }
  push({ ...free, entitlement: { plan: "pro", tier: "max", status: "inactive", expiresAt: null, version: 4 } });
  expect(render().html).toContain("Max · not active right now"); expect(render().html).not.toContain("Max active");
  expect(render().html).not.toContain("No plan yet"); expect(render().html).not.toContain("Add a Cloud");
  expect(cloudPlanLabel()).toBe("Pro"); expect(cloudPlanLabel("toString")).toBe("Cloud");
});
it("sign-out requires confirmation and preserves local and organization wording", async () => {
  await ready(free); click("Sign out of MausBot Cloud"); expect(bridge.signOut).not.toHaveBeenCalled();
  expect(render().html).toContain("does not cancel your subscription"); click("Keep signed in"); expect(bridge.signOut).not.toHaveBeenCalled();
  click("Sign out of MausBot Cloud"); click("Sign out of MausBot Cloud"); await flush(); expect(bridge.signOut).toHaveBeenCalledExactlyOnceWith();
  expect(render().html).toContain("Sign in to your Cloud plan"); expect(fetch).not.toHaveBeenCalled();
});
it("never accesses account bridge from remote companion pages", async () => {
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge, remoteClient: { active: true } } }); render(); f.effects[0](); await flush();
  expect(bridge.state).not.toHaveBeenCalled(); expect(bridge.onState).not.toHaveBeenCalled(); expect(render().html).toContain("local desktop app");
});
it("a late initial snapshot cannot replace a newer revoked state", async () => {
  let resolve!: (state: CloudAccountState) => void; vi.mocked(bridge.state).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(); f.effects[0](); push({ status: "reauth-required" }); resolve(free); await flush(); expect(render().html).toContain("no longer signed in to MausBot Cloud");
});

const all = (html: string, texts: string[]) => texts.forEach(text => expect(html).toContain(text));
const none = (html: string, texts: string[]) => texts.forEach(text => expect(html).not.toContain(text));
const BUY = ["Start free trial", "Add a Cloud", "Get Pro", "No plan yet"];
const ALARM = ["cannot currently be verified", "unavailable until", "expired or was revoked"];
const button = (label: string) => render().nodes.find(node => node.type === "button" && node.props.children === label);

it("a failed re-check keeps the plan, Cloud and Connect, and only says it is checking", async () => {
  const machine = { status: "ready" as const, origin: "https://home-7f3k2.fly.dev" };
  await ready({ ...free, entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1_900_000_000_000, version: 3 }, machine, checking: true });
  const { html } = render();
  all(html, ["Max active · verified by MausBot Cloud", "Checking with MausBot Cloud…", "Open the Cloud", "Manage Cloud subscription"]);
  none(html, [...BUY, ...ALARM]);
});
it("OMB Cloud out of reach: the plan last verified stays named, calmly, with no offer to buy", async () => {
  await ready({ status: "unavailable", message: "unreachable", account: { id: "fixture", email: "person@example.test" }, lastPlan: { tier: "personal", active: true } });
  let html = render().html;
  all(html, ["Personal · checking with MausBot Cloud…", "be reached right now, so this app", "Nothing has changed with your plan", "Manage Cloud subscription"]);
  none(html, [...BUY, ...ALARM]);
  push({ status: "unavailable", message: "unreachable", account: { id: "fixture", email: "person@example.test" } });
  html = render().html; expect(html).toContain("Open your Plan page"); none(html, [...BUY, ...ALARM]);
});
it("a saved sign-in that couldn't be cleared names the Sign out button on the card", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    f.values = []; f.platform = platform;
    await ready({ status: "unavailable", message: "signout-storage-failed" });
    const { html } = render();
    all(html, ["could not be read or cleared", "Choose Sign out of MausBot Cloud, then sign in again."]);
    none(html, ["keychain"]);
    expect(button("Sign out of MausBot Cloud")).toBeTruthy();
  }
});
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
  all(render().html, ["no longer signed in to MausBot Cloud", "Sign in again"]); none(render().html, BUY);
});
it("a payment problem or a stopped Cloud is never 'Free account' with a plan to choose", async () => {
  const origin = "https://home-7f3k2.fly.dev";
  await ready({ ...free, machine: { status: "payment-problem", origin } });
  let html = render().html;
  all(html, ["MausBot Cloud · not active right now", "problem with your payment", "Update payment in your browser"]); none(html, BUY);
  push({ ...free, machine: { status: "stopped", origin } });
  html = render().html; all(html, ["Subscribe again on your Plan page", "Open your Plan page"]); none(html, BUY);
  expect(html).not.toContain("shows why and how to fix it");
  push({ ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 4 } });
  all(render().html, ["Pro · not active right now", "shows why and how to fix it"]);
});
it("a payment being linked says so, with its date, and asks nobody to pay again", async () => {
  await ready({ ...free, purchase: { state: "confirming", tier: "personal", paidAt: Date.UTC(2026, 9, 2, 12) } });
  const html = render().html;
  all(html, ["Personal · payment received", "Received Oct 2, 2026", "no need to pay again", "Open your Plan page"]); none(html, BUY);
  push({ ...free, purchase: { state: "held" } });
  all(render().html, ["MausBot Cloud · payment received", "linking your payment"]); none(render().html, BUY);
});
it("a free account may add a Cloud, and is told what to do if it bought with another email", async () => {
  await ready(free);
  all(render({ onAddCloud: vi.fn() }).html, ["No plan yet", ">Add a Cloud<", "Bought a plan with a different email?"]);
  none(render({ onAddCloud: vi.fn() }).html, ["Choose a Cloud plan", "Free account", "a checkout return alone"]);
  button("Sign out and use that email")!.props.onClick!();
  expect(render().html).toContain("does not cancel your subscription"); expect(bridge.signOut).not.toHaveBeenCalled();
});
it("shows the sign-in code plainly, with how long it works", async () => {
  await ready({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: Date.UTC(2026, 9, 2, 12, 15) } });
  const html = render().html;
  all(html, ["Check that your browser shows this code:", "ABCDE-FGHJK", "The code works until"]);
  expect(html).not.toContain("<details"); expect(html).not.toContain("Security details");
  push({ status: "signed-out", message: "enrollment-expired" });
  all(render().html, ["The sign-in code expired. Choose Sign in to your Cloud plan to get a new one.", ">Sign in to your Cloud plan<"]);
});
it("while a saved sign-in is read, nothing is offered and the Cloud link waits", async () => {
  await ready({ status: "signed-out", message: "restoring" });
  const html = render().html;
  expect(html).toContain("Loading Cloud account"); none(html, ["Sign in to your Cloud plan", "could not be completed", ...BUY]);
  expect(cloudLinkAction({ status: "signed-out", message: "restoring" }, { arrived: true, connected: false })).toBeNull();
  render({ linkRequest: 1 }); f.effects[1](); await flush(); expect(bridge.begin).not.toHaveBeenCalled();
});
it("a saved sign-in that could not be read was removed: one line says so, and Sign in is the next step", async () => {
  await ready({ status: "signed-out", message: "restore-removed" });
  const html = render().html;
  expect(html).toContain("Cloud sign-in couldn&#x27;t be read, so it was removed. Sign in again.");
  none(html, ["could not be completed", "Unlock your system keychain"]);
  expect(button("Sign in to your Cloud plan")).toBeTruthy();
  none(render({ onAddCloud: vi.fn() }).html, BUY);
});
it("a saved sign-in that can't be read right now says the app tries again by itself, and asks for no sign-out", async () => {
  await ready({ status: "unavailable", message: "restore-failed" });
  const html = render().html;
  expect(html).toContain("This computer couldn&#x27;t open its saved Cloud sign-in. Unlock your keychain, and the app tries again by itself.");
  none(html, ["could not be read or cleared", "sign out again", "Sign out of MausBot Cloud, then"]);
});
it("a sign-out that could not clear the saved sign-in still asks for it", async () => {
  await ready({ status: "unavailable", message: "signout-storage-failed" });
  const html = render().html;
  expect(html).toContain("could not be read or cleared");
  none(html, ["tries again by itself"]);
});
it("setting up shows the Cloud page's steps, a slow setup and a failed setup's next try", async () => {
  const paid = { ...free, entitlement: { plan: "pro" as const, status: "active" as const, expiresAt: 1_900_000_000_000, version: 2 } };
  await ready(paid);
  expect(render().html).toContain('data-cloud-home="provisioning"');
  push({ ...paid, machine: { status: "provisioning", setup: { step: "starting" } } });
  let html = render().html;
  all(html, ['data-cloud-setup="starting"', "Reserving your machine", "Preparing storage", "Starting the Cloud", "Checking it", 'aria-current="step"']);
  expect(html.indexOf('aria-current="step"')).toBeGreaterThan(html.indexOf("Preparing storage"));
  push({ ...paid, machine: { status: "provisioning", setup: { step: "starting", slow: true } } });
  expect(render().html).toContain("taking longer than usual");
  push({ ...paid, machine: { status: "failed", retryAt: Date.UTC(2026, 9, 2, 12, 30) } });
  html = render().html; all(html, ["Nothing was lost", "tried again automatically at"]);
});
it("on the person's own Cloud, Settings shows the plan read only, with Manage, and Sign in again once this computer's sign-in ended", async () => {
  const plan = { state: vi.fn().mockResolvedValue({ status: "paid", tier: "max" }), manage: vi.fn().mockResolvedValue(undefined), signIn: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("window", { ogb: { cloudPlan: plan } });
  const settings = render({ cloudHome: true }).html; expect(settings).not.toContain("local desktop app");
  expect(render().html).toContain("local desktop app"); expect(render().html).not.toContain("Manage in your browser");
  const view = () => { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudPlanOnCloud({ bridge: plan }); return tree; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) }; };
  view(); f.effects[0](); await flush();
  all(view().html, ["Max active · verified by MausBot Cloud", "Manage in your browser"]); none(view().html, [...BUY, "Switch to this computer", "Sign in again"]);
  view().nodes.find(node => node.type === "button" && node.props.children === "Manage in your browser")!.props.onClick!();
  await flush(); expect(plan.manage).toHaveBeenCalledExactlyOnceWith();
  plan.state.mockResolvedValueOnce({ status: "checking", tier: "pro" }); f.values = []; view(); f.effects[0](); await flush();
  expect(view().html).toContain("Pro · checking with MausBot Cloud…");
  plan.state.mockResolvedValueOnce({ status: "signin", tier: "max" }); f.values = []; view(); f.effects[0](); await flush();
  all(view().html, ["Max plan", "This computer needs to sign in to MausBot Cloud again"]); none(view().html, [...BUY, "Could not complete", "Switch to this computer"]);
  expect(view().nodes.filter(node => node.type === "button" && node.props.children === "Sign in again")).toHaveLength(1);
  view().nodes.find(node => node.type === "button" && node.props.children === "Sign in again")!.props.onClick!();
  await flush(); expect(plan.signIn).toHaveBeenCalledExactlyOnceWith();
  plan.state.mockRejectedValueOnce(new Error("cloud-plan:state is only available in this app's window")); f.values = []; view(); f.effects[0](); await flush();
  const refused = view();
  expect(refused.html).toContain("Your plan is managed in the OpenMausBot app on your computer.");
  expect(refused.nodes.some(node => node.type === "button")).toBe(false);
  none(refused.html, ["Could not complete", 'role="alert"', "Loading"]);
});

it("on My Cloud once it is home, Settings is that app's own: the plan is managed on the Plan page, never in another app", async () => {
  const plan = { state: vi.fn().mockResolvedValue({ status: "none", home: true }), manage: vi.fn().mockResolvedValue(undefined) };
  const view = () => { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudPlanOnCloud({ bridge: plan }); return tree; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) }; };
  view(); f.effects[0](); await flush();
  all(view().html, ["Your plan is managed on your Plan page.", "Your plan, as MausBot Cloud verified it.", "Manage in your browser"]);
  none(view().html, ["OpenMausBot app", "on your computer"]);
  plan.state.mockResolvedValueOnce({ status: "paid", tier: "pro", home: true }); f.values = []; view(); f.effects[0](); await flush();
  all(view().html, ["Pro active · verified by MausBot Cloud", "Your plan, as MausBot Cloud verified it."]); none(view().html, ["on your computer"]);
  plan.state.mockResolvedValueOnce({ status: "none" }); f.values = []; view(); f.effects[0](); await flush();
  all(view().html, ["Your plan is managed in the OpenMausBot app on your computer.", "verified it for the app on your computer"]);
});

const pro: CloudAccountState = { ...free, entitlement: { plan: "pro", status: "active", expiresAt: 1_900_000_000_000, version: 2 } };
const origin = "https://home-7f3k2.fly.dev";
it("stays exactly as before when the account has no Cloud machine", async () => {
  await ready(free);
  expect(render().html).not.toContain("My Cloud");
  expect(render().html, "chats do go to the Cloud by themselves now").not.toContain("does not upload your chat history");
  expect(render().html).not.toContain(">Open the Cloud</button>");
  push(pro); expect(render().html).not.toContain(">Open the Cloud</button>");
});
it.each([
  ["provisioning", "Setting up the Cloud", false],
  ["ready", "The Cloud is ready", true],
  ["stopped", "The Cloud is stopped", false],
  ["payment-problem", "problem with your payment", false],
  ["failed", "could not be set up yet", false],
] as const)("shows the %s machine state plainly", async (status, text, connectable) => {
  await ready({ ...pro, machine: { status, ...(status === "provisioning" ? {} : { origin }) } });
  const html = render().html;
  expect(html).toContain(`data-cloud-home="${status}"`);
  expect(html).toContain(text);
  expect(html.includes(">Open the Cloud</button>")).toBe(connectable);
  expect(html).not.toContain("Could not complete this Cloud action");
});
it("while the bots move to My Cloud, says how the move goes, with nothing to open or switch back to; Open the Cloud comes back after", async () => {
  let move: unknown = { phase: "copy", chats: { done: 3, total: 12 } };
  const lending = { state: vi.fn().mockResolvedValue({ available: false, screenAvailable: false }), chooseFolder: vi.fn(), save: vi.fn(), stop: vi.fn() };
  vi.stubGlobal("window", { ogb: { cloudAccount: { ...bridge, lending }, cloudSendPage: { notice: vi.fn(async () => ({ ready: true, bots: [], move })), onNotice: vi.fn(() => () => {}), dismiss: vi.fn() } } });
  const moving = async () => { await ready({ ...pro, machine: { status: "ready", origin } }); f.effects[2](); await flush(); return render(); };
  let view = await moving();
  all(view.html, ["Moving your bots to My Cloud… 3 of 12 chats", "data-cloud-moving"]);
  none(view.html, [">Open the Cloud</button>", "Switch back to This computer", "The Cloud is ready"]);
  expect(view.nodes.find(node => node.type === CloudLending)?.props).toMatchObject({ moving: true });
  move = { phase: "finishing" };
  f.values = []; view = await moving();
  all(view.html, ["Moving to My Cloud… almost done"]); none(view.html, [">Open the Cloud</button>", "Switch back to This computer"]);
  move = undefined;
  f.values = []; view = await moving();
  all(view.html, [">Open the Cloud</button>", "Switch back to This computer", "The Cloud is ready"]); none(view.html, ["data-cloud-moving", "Moving"]);
  expect(view.nodes.find(node => node.type === CloudLending)?.props).toMatchObject({ moving: false });
});
it("says why a ready Cloud can't be reached when the Admin knows, with no button that can't reach it", async () => {
  const since = Date.UTC(2026, 9, 16, 9);
  await ready({ ...pro, machine: { status: "ready", origin, unreachable: { cause: "host", since } } });
  let html = render().html;
  expect(html).toContain('data-cloud-unreachable="host"');
  expect(html).toContain("Our hosting provider is restarting the machine the Cloud runs on. The Cloud and its files are safe, and it comes back on its own, usually within about 20 minutes.");
  expect(html).not.toContain(">Open the Cloud</button>");
  expect(html).not.toContain("The Cloud is ready");
  push({ ...pro, machine: { status: "ready", origin, unreachable: { cause: "no_answer", since } } });
  html = render().html;
  expect(html).toContain("The Cloud hasn&#x27;t answered for a few minutes. Nothing was lost, and we&#x27;ve been told.");
  expect(html).not.toContain(">Open the Cloud</button>");
  // The Cloud link opens nothing while it can't be reached, and does once it answers again.
  render({ linkRequest: 1 }); f.effects[1](); await flush();
  expect(bridge.connectHome).not.toHaveBeenCalled();
  push({ ...pro, machine: { status: "ready", origin } });
  expect(render().html).toContain(">Open the Cloud</button>");
  render({ linkRequest: 1 }); f.effects[1](); await flush();
  expect(bridge.connectHome).toHaveBeenCalledExactlyOnceWith();
});
it("promises no included AI: the person signs in with their own account there", async () => {
  await ready({ ...pro, machine: { status: "ready", origin } });
  const html = render().html;
  expect(html).toContain("sign in there with your own Claude or ChatGPT account, or an API key");
  expect(html).not.toMatch(/included/i);
});
it("connects with one click, sending nothing from the page", async () => {
  await ready({ ...pro, machine: { status: "ready", origin } });
  click("Open the Cloud"); await flush();
  expect(bridge.connectHome).toHaveBeenCalledExactlyOnceWith();
});
it("reports a failed connection as its own message", async () => {
  vi.mocked(bridge.connectHome).mockRejectedValueOnce(new Error("offline"));
  const state = { ...pro, machine: { status: "ready" as const, origin } };
  vi.mocked(bridge.state).mockResolvedValue(state);
  await ready(state);
  click("Open the Cloud"); await flush();
  expect(render().html).toContain("Could not open the Cloud");
  expect(render().html).not.toContain("Could not complete this Cloud action");
});

// React re-runs the link effect (the second one) after each render; these helpers do the same.
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
  expect(render().html).toContain("Setting up the Cloud");
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
  expect(render().html).toContain("Sign in to your Cloud plan");
  expect(bridge.connectHome).not.toHaveBeenCalled();
  expect(bridge.begin).not.toHaveBeenCalled();
});
it("a normal visit never signs in or connects by itself", async () => {
  await ready();
  visit(); await flush();
  expect(bridge.begin).not.toHaveBeenCalled();
  push(readyCloud); visit(); await flush();
  expect(bridge.connectHome).not.toHaveBeenCalled();
  expect(render().html).toContain("Open the Cloud");
});
it("a failed automatic connection waits for the next link; a normal visit in between stops it", async () => {
  vi.mocked(bridge.connectHome).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(bridge.state).mockResolvedValue(readyCloud);
  await ready(readyCloud);
  linked(1); await flush();
  expect(render().html).toContain("Could not open the Cloud");
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

const PHONE = "Use the Cloud on your phone";
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
  f.values = []; await ready(pro);
  expect(render().html).toContain('data-cloud-phone="steps"');
});
it("a switch that failed says so, with the two steps, and can be tried again", async () => {
  vi.mocked(bridge.connectHomeForPhone).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(bridge.state).mockResolvedValue(readyCloud);
  await ready(readyCloud);
  click(PHONE); await flush();
  const html = render().html;
  all(html, ["Could not open the Cloud.", "You can also do it in two steps", ...STEPS]);
  expect(html).not.toContain("Could not complete this Cloud action");
  click(PHONE); await flush();
  expect(bridge.connectHomeForPhone).toHaveBeenCalledTimes(2);
  expect(render().html).not.toContain("Could not open the Cloud.");
});
it("is not offered without a paid plan", async () => {
  await ready(free); expect(render().html).not.toContain(PHONE);
  push({ ...pro, entitlement: { plan: "pro", status: "inactive", expiresAt: null, version: 4 }, machine: { status: "stopped", origin } });
  expect(render().html).not.toContain(PHONE);
  push({ status: "signed-out" }); expect(render().html).not.toContain(PHONE);
});
it("on the Cloud itself, opens this Cloud's phone pairing directly; never where this app cannot vouch for it", async () => {
  const plan = { state: vi.fn().mockResolvedValue({ status: "paid", tier: "pro" }), manage: vi.fn() };
  const onConnectPhone = vi.fn();
  const view = (props: { onConnectPhone?: () => void }) => { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudPlanOnCloud({ bridge: plan, ...props }); return tree; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) }; };
  expect(view({ onConnectPhone }).html).not.toContain(PHONE);
  f.effects[0](); await flush();
  view({ onConnectPhone }).nodes.find(node => node.type === "button" && node.props.children === PHONE)!.props.onClick!();
  expect(onConnectPhone).toHaveBeenCalledOnce();
  expect(plan.manage).not.toHaveBeenCalled();
  vi.stubGlobal("window", { ogb: { cloudPlan: plan } });
  const onCloud = render({ cloudHome: true, onConnectPhone }).nodes as unknown as Array<ReactElement<{ onConnectPhone?: () => void }>>;
  const card = onCloud.find(node => node.type === CloudPlanOnCloud);
  expect(card!.props.onConnectPhone).toBe(onConnectPhone);
  // My Cloud's own page also shows the computers lent to it.
  expect(onCloud.some(node => node.type === LentComputersCard)).toBe(true);
  expect(view({}).html).not.toContain(PHONE);
  plan.state.mockRejectedValueOnce(new Error("cloud-plan:state is only available in this app's window")); f.values = []; view({ onConnectPhone }); f.effects[0](); await flush();
  expect(view({ onConnectPhone }).nodes.some(node => node.type === "button")).toBe(false);
});

const ENDS = new Date(2026, 9, 15, 12).getTime(), DAY = 86_400_000;
const onTrial = (state: "active" | "ending" | "processing" | "late" | "ended", extra: object = {}) =>
  ({ state, tier: "pro", endsAt: ENDS, amount: 4900, chargeAt: null, holdUntil: null, deleteAt: null, keep: "none", ...extra }) as NonNullable<CloudAccountState["trial"]>;
const credit = { grantedUsd: 5, remainingUsd: 3.2, state: "active" } as const;
it("a free trial says what happens and when, in the notice's words, with its next step on the browser button", async () => {
  const machine = { status: "ready" as const, origin };
  await ready({ ...pro, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: ENDS + 3 * DAY, version: 3 }, machine,
    trial: onTrial("ending", { deleteAt: ENDS + 3 * DAY, keep: "portal" }), credit });
  const html = render().html;
  all(html, ["Pro free trial · verified by MausBot Cloud", "Your free trial ends on Oct 15", "Renewal is off, so the Cloud stops then and its files are deleted on Oct 18.",
    "Trial Claude credit: $3.20 of $5 left.", 'data-cloud-trial="ending"', 'data-cloud-credit="active"']);
  none(html, ["Pro active", "Manage Cloud subscription", ...BUY]);
  click("Subscribe to keep it"); await flush(); expect(bridge.openDashboard).toHaveBeenCalledExactlyOnceWith();
  push({ ...pro, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: ENDS + 3 * DAY, version: 4 }, machine, trial: onTrial("active", { chargeAt: ENDS }) });
  expect(render().html).toContain("To cancel, choose Manage subscription before then."); expect(button("Manage subscription")).toBeTruthy();
  push({ ...pro, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: ENDS + 3 * DAY, version: 5 }, machine, trial: onTrial("processing") });
  expect(render().html).toContain("Your first payment is processing"); expect(button("Manage Cloud subscription")).toBeTruthy();
});
it("an ended trial is one message: what happens to the files, and Subscribe to keep it; the stopped Cloud only says it is stopped", async () => {
  await ready({ ...free, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 6 }, machine: { status: "stopped", origin },
    trial: onTrial("ended", { deleteAt: ENDS + 3 * DAY, keep: "checkout" }), credit: { grantedUsd: 5, remainingUsd: 0, state: "used_up" } });
  const html = render().html;
  all(html, ["Your free trial has ended", "The Cloud is stopped. Its files are kept until Oct 18, then deleted.", 'data-cloud-home="stopped"', ">The Cloud is stopped.</p>",
    "Your $5 trial Claude credit is used up. To keep your bots working, sign in with your own Claude or ChatGPT account in the Cloud, or add an API key there."]);
  none(html, ["Subscribe again on your Plan page", "Your plan is not active right now", ...BUY]);
  expect(button("Subscribe to keep it")).toBeTruthy();
});
it("signed out or with no plan, the Add a Cloud button names the trial only when the Admin offers one, with its money-back", async () => {
  const onAddCloud = vi.fn();
  const offer = vi.fn().mockResolvedValue({ plans: [{ tier: "pro", amount: 4900, trialDays: 7 }], recommended: "pro", creditUsd: 5, refundDays: 14 });
  (bridge as CloudAccountBridge).offer = offer;
  await ready({ status: "signed-out" });
  render({ onAddCloud }); f.effects.at(-1)!(); await flush();
  expect(offer).toHaveBeenCalledExactlyOnceWith();
  let html = render({ onAddCloud }).html;
  all(html, [">Start free trial<", "14-day money-back on every plan.", "Sign in to your Cloud plan"]);
  expect(html.indexOf("Start free trial")).toBeLessThan(html.indexOf("Sign in to your Cloud plan"));
  render({ onAddCloud }).nodes.find(node => node.type === "button" && node.props.children === "Start free trial")!.props.onClick!();
  expect(onAddCloud).toHaveBeenCalledOnce();
  offer.mockResolvedValue({ plans: [{ tier: "pro", amount: 4900 }], recommended: "pro" });
  push(free); render({ onAddCloud }); f.effects.at(-1)!(); await flush();
  html = render({ onAddCloud }).html;
  expect(html).toContain(">Add a Cloud<"); none(html, ["free trial", "money-back"]);
  offer.mockClear(); push(pro); render({ onAddCloud }); f.effects.at(-1)!(); await flush();
  expect(offer).not.toHaveBeenCalled(); none(render({ onAddCloud }).html, BUY);
});
it("on My Cloud, Settings shows the trial and its credit, and its button names the trial's next step", async () => {
  const plan = { state: vi.fn().mockResolvedValue({ status: "paid", tier: "pro", trial: onTrial("active", { chargeAt: ENDS }), credit }),
    manage: vi.fn().mockResolvedValue(undefined) };
  const view = () => { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudPlanOnCloud({ bridge: plan }); return tree; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) }; };
  view(); f.effects[0](); await flush();
  all(view().html, ["Pro free trial · verified by MausBot Cloud", "Your free trial ends on Oct 15", "Then Pro is $49/month plus tax, charged on Oct 15.", "Trial Claude credit: $3.20 of $5 left."]);
  view().nodes.find(node => node.type === "button" && node.props.children === "Manage subscription")!.props.onClick!();
  await flush(); expect(plan.manage).toHaveBeenCalledExactlyOnceWith();
  plan.state.mockResolvedValueOnce({ status: "paid", tier: "pro" }); f.values = []; view(); f.effects[0](); await flush();
  all(view().html, ["Pro active · verified by MausBot Cloud", "Manage in your browser"]); none(view().html, ["free trial", "Claude credit"]);
});
it("Sign in is the sheet's email code when Settings hands it over; the staging Admin is marked plainly", async () => {
  const onSignIn = vi.fn();
  await ready();
  render({ onSignIn }).nodes.find(node => node.type === "button" && node.props.children === "Sign in to your Cloud plan")!.props.onClick!();
  await flush();
  expect(onSignIn).toHaveBeenCalledOnce(); expect(bridge.begin).not.toHaveBeenCalled();
  expect(render().html).not.toContain("data-cloud-staging");
  push({ ...free, staging: true });
  const staging = render().html;
  expect(staging).toContain("data-cloud-staging"); expect(staging).toContain(">Staging<");
});
