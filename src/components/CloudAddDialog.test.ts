import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudCheckoutResult } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
import { CloudAddDialog, CloudAddPanel, planFromKey, type CloudAddActions } from "./CloudAddDialog";
import { cloudAddView } from "@/lib/cloud-plan";
import { track } from "@/lib/analytics";

const DAY = 86_400_000, NOW = new Date(2026, 9, 8, 12).getTime();
const allowances = (computers: number, diskGb: number) => ({ cpus: computers, memoryMb: computers * 1024, diskGb, maxDiskGb: diskGb, computers, computerHours: computers * 50, voiceCharacters: 100_000 });
const PLANS = [
  { tier: "personal", label: "Personal", amount: 2900, allowances: allowances(1, 10), trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, allowances: allowances(4, 40), trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, allowances: allowances(8, 80), trialDays: 7 },
];
const TRIAL: CloudOffer = { plans: PLANS, recommended: "pro", creditUsd: 5, reminderDays: 2, refundDays: 14 };
const PLAIN: CloudOffer = { plans: PLANS.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (extra: Partial<CloudTrial> = {}): CloudTrial => ({ state: "active", tier: "pro", endsAt: NOW + 7 * DAY, amount: 4900, chargeAt: NOW + 7 * DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const actions = (): CloudAddActions => ({ choose: vi.fn(), checkout: vi.fn(), signIn: vi.fn(), reopenBrowser: vi.fn(), cancelSignIn: vi.fn(), changePlan: vi.fn(), retry: vi.fn(), openCloud: vi.fn(), close: vi.fn() });
const panel = (account: CloudAccountState | null, offer: CloudOffer | null | undefined, options: { chosen?: string | null; error?: "failed" | "rate-limited"; choosing?: boolean; offerShown?: CloudOffer | null } = {}) => {
  const view = cloudAddView(account, offer, { now: NOW, error: options.error ?? null, choosing: options.choosing ?? false });
  const handlers = actions();
  const props = { view, chosen: options.chosen ?? null, offerShown: options.offerShown ?? offer ?? null, now: NOW, actions: handlers };
  return { view, html: renderToStaticMarkup(createElement(CloudAddPanel, props)), tree: nodes(CloudAddPanel(props)), handlers };
};
const button = (tree: Node[], label: string) => tree.find(node => node.type === "button" && (text(renderToStaticMarkup(node)) === label || text(renderToStaticMarkup(node)).startsWith(label)));

beforeEach(() => { vi.clearAllMocks(); setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("each view of the buying journey says one thing and offers one next step", () => {
  it("the offer with a trial: three plans with Pro preselected and most popular, the timeline, the credit, money-back, Start free trial", () => {
    const { html, tree, handlers } = panel({ status: "signed-out" }, TRIAL);
    const words = ["Try OpenMausBot Cloud free for 7 days", "A computer in the cloud that runs your bots 24/7, even when this one is off.",
      "Personal", "$29/month + tax", "1 cloud computer at once · 10 GB storage", "Pro", "Most popular", "$49/month + tax", "Up to 4 cloud computers at once · 40 GB storage",
      "Max", "$99/month + tax", "Today", "Your trial starts. Nothing is charged today. $5 of Claude credit included.", "Oct 13", "We email you a reminder.",
      "Oct 15", "Pro starts at $49/month + tax. Cancel before then and pay nothing.", "Start free trial",
      "14-day money-back on every plan. Checkout opens in your browser.", "Sign in to your Cloud plan", "Not now"];
    const plain = text(html);
    for (const word of words) expect(plain, word).toContain(word);
    for (let i = 1; i < words.length; i++) expect(plain.indexOf(words[i - 1]!), words[i]).toBeLessThanOrEqual(plain.indexOf(words[i]!));
    // One tab stop for the plan picker, on the plan picked.
    expect(html).toContain('aria-checked="true" tabindex="0" data-plan="pro"');
    expect(html).toContain('aria-checked="false" tabindex="-1" data-plan="max"');
    for (const gone of ["Compare plans", "launch", "$89", "Recommended", "AI credit"]) expect(plain).not.toContain(gone);
    button(tree, "Start free trial")!.props.onClick(); expect(handlers.checkout).toHaveBeenCalledOnce();
    tree.find(node => node.props["data-plan"] === "max")!.props.onClick(); expect(handlers.choose).toHaveBeenCalledWith("max");
    button(tree, "Sign in to your Cloud plan")!.props.onClick(); expect(handlers.signIn).toHaveBeenCalledOnce();
    // Picking a plan rewrites the charge line.
    expect(text(panel({ status: "signed-out" }, TRIAL, { chosen: "personal" }).html)).toContain("Personal starts at $29/month + tax.");
  });

  it("the offer without a trial: Add a Cloud, Get the plan at its price, charged today, money-back only from the Admin", () => {
    const { html } = panel(free, PLAIN);
    const plain = text(html);
    expect(plain).toContain("Add a Cloud"); expect(plain).toContain("Get Pro · $49/month");
    expect(plain).toContain("+ tax, charged today. Cancel any time. 14-day money-back on every plan.");
    for (const gone of ["free trial", "Today", "reminder", "Sign in to your Cloud plan", "Claude credit"]) expect(plain).not.toContain(gone);
    expect(text(panel(free, PLAIN, { chosen: "max" }).html)).toContain("Get Max · $99/month");
    expect(text(panel(free, { ...PLAIN, refundDays: undefined }).html)).not.toContain("money-back");
    // A plan the Admin no longer trials shows no trial, while the others do.
    const mixed = { ...TRIAL, plans: [PLANS[0]!, PLANS[1]!, { ...PLANS[2]!, trialDays: undefined }] };
    expect(text(panel(free, mixed, { chosen: "max" }).html)).toContain("Get Max · $99/month");
    expect(text(panel(free, mixed).html)).toContain("Start free trial");
    // No reminder email from the Admin: no reminder line.
    expect(text(panel(free, { ...TRIAL, reminderDays: undefined }).html)).not.toContain("reminder");
  });

  it("checking, Cloud out of reach, and a checkout that did not open each say so, with Try again", () => {
    expect(text(panel(null, undefined).html)).toContain("Checking with OpenMausBot Cloud…");
    const unreachable = panel({ status: "signed-out" }, null);
    expect(text(unreachable.html)).toContain("Can't reach OpenMausBot Cloud right now. Check your connection and try again.");
    button(unreachable.tree, "Try again")!.props.onClick(); expect(unreachable.handlers.retry).toHaveBeenCalledOnce();
    expect(text(panel(free, TRIAL, { error: "failed" }).html)).toContain("Checkout couldn't open. Nothing was charged. Try again.");
    expect(text(panel(free, TRIAL, { error: "rate-limited" }).html)).toContain("You've opened several checkouts in the last hour. Use the one in your browser, or try again later.");
  });

  it("signing in, then the checkout in the browser, then the payment, then My Cloud starting and ready", () => {
    const signing = panel({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: NOW + 600_000 } }, undefined, { offerShown: TRIAL });
    // A plain sign-in ("Sign in to your Cloud plan") ends at connecting: no trial or checkout follows it.
    expect(text(signing.html)).toContain("Finish in your browser Sign in with your email. Check that your browser shows this code: ABCDE-FGHJK Connect this app. Cancel");
    // On the way to a checkout, its last step says what comes next.
    const toTrial = panel({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: NOW + 600_000 }, checkout: { plan: "pro", startedAt: NOW, signIn: true } }, TRIAL);
    expect(text(toTrial.html)).toContain("ABCDE-FGHJK Connect this app, then start your free trial.");
    button(signing.tree, "Reopen browser")!.props.onClick(); expect(signing.handlers.reopenBrowser).toHaveBeenCalledOnce();
    button(signing.tree, "Cancel")!.props.onClick(); expect(signing.handlers.cancelSignIn).toHaveBeenCalledOnce();
    expect(text(panel({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: NOW + 600_000 }, checkout: { plan: "pro", startedAt: NOW, signIn: true } }, undefined, { offerShown: PLAIN }).html))
      .toContain("Connect this app, then continue to checkout.");
    const waiting = panel({ ...free, checkout: { plan: "pro", startedAt: NOW - 60_000 } }, TRIAL);
    expect(text(waiting.html)).toContain("Checkout is open in your browser. When you're done, come back here: My Cloud starts by itself.");
    button(waiting.tree, "Reopen checkout")!.props.onClick(); expect(waiting.handlers.checkout).toHaveBeenCalledOnce();
    button(waiting.tree, "Change plan")!.props.onClick(); expect(waiting.handlers.changePlan).toHaveBeenCalledOnce();
    // Signed in on the way to a checkout: the browser's page after approval has the next step, nothing is open yet; the
    // dialog never says a checkout is open, and its button opens the same checkout if that page is gone.
    const afterSignIn = panel({ ...free, checkout: { plan: "pro", startedAt: NOW - 60_000, signIn: true } }, TRIAL);
    expect(text(afterSignIn.html)).toContain("Finish in your browser Your browser shows the next step. When you're done, come back here: My Cloud starts by itself.");
    expect(text(afterSignIn.html)).not.toContain("Checkout is open");
    button(afterSignIn.tree, "Start free trial")!.props.onClick(); expect(afterSignIn.handlers.checkout).toHaveBeenCalledOnce();
    expect(text(panel({ ...free, checkout: { plan: "pro", startedAt: NOW - 60_000, signIn: true } }, PLAIN).html)).toContain("Get Pro · $49/month");
    // 30 minutes on: a trial checkout says the trial hasn't started (it charges nothing); a paid one, that no payment was seen.
    expect(text(panel({ ...free, checkout: { plan: "pro", startedAt: NOW - 31 * 60_000 } }, TRIAL).html)).toContain("Your free trial hasn't started yet. If you finished checkout, it shows up here within a few minutes.");
    expect(text(panel({ ...free, checkout: { plan: "pro", startedAt: NOW - 31 * 60_000 } }, TRIAL).html)).not.toContain("payment");
    expect(text(panel({ ...free, checkout: { plan: "pro", startedAt: NOW - 31 * 60_000 } }, PLAIN).html)).toContain("We haven't seen a payment yet. If you paid, it shows up here within a few minutes.");
    // A sign-in that ended, or a code that expired, says so with the offer it returns to.
    expect(text(panel({ status: "signed-out", message: "enrollment-expired" }, TRIAL).html)).toContain("The sign-in code expired, so nothing changed. Start again when you're ready.");
    expect(text(panel({ status: "signed-out", message: "enrollment-ended" }, TRIAL).html)).toContain("The sign-in ended before this app was connected, so nothing changed.");
    expect(text(panel({ ...free, purchase: { state: "confirming", tier: "pro" } }, TRIAL).html)).toContain("Payment received Pro · payment received");
    const starting = text(panel(paid({ trial: trial(), machine: { status: "provisioning", setup: { step: "storage" } } }), undefined, { offerShown: TRIAL }).html);
    for (const word of ["Your free trial has started", "My Cloud is starting. This takes about 2 minutes.", "Reserving your machine", "Preparing storage",
      "Free until Oct 15. Then Pro is $49/month + tax. We email you 2 days before. Cancel any time on your Plan page.", "Next: give My Cloud its first job."]) expect(starting).toContain(word);
    expect(text(panel(paid(), undefined).html)).toContain("Payment received My Cloud is starting.");
    expect(text(panel(paid({ trial: trial() }), undefined, { offerShown: null }).html)).toContain("Then Pro is $49/month + tax. Cancel any time on your Plan page.");
    const ready = panel(paid({ machine: { status: "ready", origin: "https://omb-u-1.fly.dev" }, checkout: { plan: "pro", startedAt: NOW - 3600_000 } }), undefined);
    expect(text(ready.html)).toContain("My Cloud is ready It keeps your bots running 24/7, even when this computer is off. Open it and give it a first job.");
    button(ready.tree, "Open My Cloud")!.props.onClick(); expect(ready.handlers.openCloud).toHaveBeenCalledOnce();
    expect(text(panel(paid({ machine: { status: "ready", origin: "https://omb-u-1.fly.dev" } }), undefined).html)).toContain("You have My Cloud It's ready on this computer too.");
    expect(panel(paid({ machine: { status: "ready", origin: "https://omb-u-1.fly.dev" } }), undefined).html).not.toContain("Email me");
  });
});

describe("the dialog", () => {
  let account: CloudAccountState;
  let offer: CloudOffer | null;
  let bridge: Record<string, ReturnType<typeof vi.fn>>;
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(CloudAddDialog, { now: () => NOW })); };
  async function settle() { for (let i = 0; i < 4; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
  const tree = () => { f.index = 0; f.effects = []; return nodes(CloudAddDialog({ now: () => NOW })); };
  beforeEach(() => {
    f.values = []; f.index = 0; f.effects = []; f.dispatch = vi.fn(); f.state = { cloudAdd: { source: "app_menu" } };
    account = free; offer = TRIAL;
    bridge = { state: vi.fn(async () => account), onState: vi.fn(() => () => {}), offer: vi.fn(async () => offer),
      checkout: vi.fn(async (): Promise<CloudCheckoutResult> => ({ outcome: "opened", state: { ...account, checkout: { plan: "pro", startedAt: NOW } } })),
      begin: vi.fn(async () => ({ status: "connecting" })), reopen: vi.fn(async () => account), cancel: vi.fn(async () => ({ status: "signed-out" })),
      connectHome: vi.fn(async () => account) };
    vi.stubGlobal("window", { ogb: { cloudAccount: bridge }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { querySelector: () => null });
  });

  it("asks main for a checkout of the chosen plan from where it was opened, then waits on it", async () => {
    expect(await settle()).toContain("Try OpenMausBot Cloud free for 7 days");
    expect(track).toHaveBeenCalledWith("cloud_dialog_shown", { source: "app_menu", view: "offer" });
    tree().find(node => node.props["data-plan"] === "max")!.props.onClick();
    button(tree(), "Start free trial")!.props.onClick(); await flush();
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("max", "app_menu");
    expect(track).toHaveBeenCalledWith("cloud_checkout_opened", { plan: "max", trial: true, source: "app_menu" });
    expect(text(render())).toContain("Checkout is open in your browser.");
  });

  it("the plan picker moves with the arrow keys, and a new step takes focus at its heading", async () => {
    const tiers = ["personal", "pro", "max"];
    expect([planFromKey(tiers, "pro", "ArrowDown"), planFromKey(tiers, "max", "ArrowRight"), planFromKey(tiers, "pro", "ArrowUp"), planFromKey(tiers, "personal", "ArrowLeft"),
      planFromKey(tiers, "max", "Home"), planFromKey(tiers, "personal", "End"), planFromKey(tiers, "pro", "Enter")]).toEqual(["max", "personal", "personal", "max", "personal", "max", null]);
    await settle();
    const focus = vi.fn(), prevent = vi.fn();
    const max = { focus };
    tree().find(node => node.props["data-plan"] === "pro")!.props.onKeyDown({ key: "ArrowDown", preventDefault: prevent, currentTarget: { parentElement: { querySelector: (selector: string) => selector === '[data-plan="max"]' ? max : null } } });
    expect(prevent).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
    expect(text(render())).toContain("Max starts at $99/month + tax.");
    // The checkout opens: the view changes, and its heading takes focus (the button pressed is gone).
    const heading = { focus: vi.fn() };
    vi.stubGlobal("document", { querySelector: (selector: string) => selector === "#cloud-add-title" ? heading : null, activeElement: null });
    button(tree(), "Start free trial")!.props.onClick(); await flush();
    await settle();
    expect(heading.focus).toHaveBeenCalled();
  });

  it("a refused checkout says why and changes nothing; a conflict shows what the account is now", async () => {
    await settle();
    bridge.checkout.mockResolvedValueOnce({ outcome: "rate-limited", state: account });
    button(tree(), "Start free trial")!.props.onClick(); await flush();
    expect(text(render())).toContain("You've opened several checkouts in the last hour.");
    button(tree(), "Try again")!.props.onClick();
    expect(await settle()).toContain("Start free trial");
    bridge.checkout.mockRejectedValueOnce(new Error("Choose a plan to continue."));
    button(tree(), "Start free trial")!.props.onClick(); await flush();
    expect(text(render())).toContain("Checkout couldn't open. Nothing was charged.");
    button(tree(), "Try again")!.props.onClick(); await settle();
    // A conflict that changed nothing here (a checkout already being prepared) says so, instead of nothing happening.
    bridge.checkout.mockResolvedValueOnce({ outcome: "conflict", state: free });
    button(tree(), "Start free trial")!.props.onClick(); await flush();
    expect(text(render())).toContain("A checkout is already being prepared. Try again in a moment.");
    bridge.checkout.mockResolvedValueOnce({ outcome: "conflict", state: { ...free, purchase: { state: "held", tier: "pro" } } });
    button(tree(), "Start free trial")!.props.onClick(); await flush();
    expect(text(render())).toContain("Payment received");
  });

  it("payment problems and ended sign-ins are Settings' to say: the dialog hands over and closes", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } };
    expect(await settle()).toBe("");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("is only on This computer's page, and only while asked for", async () => {
    f.state = { cloudAdd: null }; expect(await settle()).toBe("");
    f.state = { cloudAdd: { source: "app_card" } };
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true }, cloudAccount: bridge } }); expect(await settle()).toBe("");
    vi.stubGlobal("window", {}); expect(await settle()).toBe("");
  });
});
