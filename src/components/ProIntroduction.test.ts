import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch: f.dispatch }),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
import { ProSettingsCard, proOfferAvailable } from "./ProIntroduction";

const PLANS = [{ tier: "personal", label: "Personal", amount: 2900, trialDays: 7 }, { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 }];
const TRIAL: CloudOffer = { plans: PLANS, recommended: "pro", creditUsd: 5, refundDays: 14 };
const signedOut = { status: "signed-out" } as const;
const plan = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
  entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 }, ...extra });
const paid = (tier?: string, status: "active" | "inactive" = "active") => ({ plan: "pro" as const, ...(tier ? { tier } : {}), status, expiresAt: status === "active" ? 1_900_000_000_000 : null, version: 2 });

let offer: CloudOffer | null;
let openExternal: ReturnType<typeof vi.fn>;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.clearAllMocks(); f.values = []; f.index = 0; f.effects = []; f.dispatch = vi.fn(); offer = TRIAL;
  openExternal = vi.fn().mockResolvedValue(true);
  bridge = { state: vi.fn(async () => signedOut), onState: vi.fn(() => () => {}), offer: vi.fn(async () => offer) };
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge, openExternal } });
});
afterEach(() => vi.unstubAllGlobals());

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** The card for this account, with the offer read. */
async function card(state: CloudAccountState) {
  f.values = []; bridge.state.mockResolvedValue(state);
  for (let round = 0; round < 3; round++) { f.index = 0; f.effects = []; renderToStaticMarkup(createElement(ProSettingsCard)); f.effects.forEach(effect => effect()); await flush(); }
  f.index = 0; f.effects = [];
  return renderToStaticMarkup(createElement(ProSettingsCard));
}
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const nodes = (value: ReactNode): Node[] => !isValidElement(value) ? [] : [value as Node, ...Children.toArray((value as Node).props.children).flatMap(nodes)];
const press = (label: string) => {
  f.index = 0; f.effects = [];
  const button = nodes(ProSettingsCard()).find(node => node.type === "button" && renderToStaticMarkup(node).includes(`>${label}<`));
  expect(button, label).toBeTruthy(); button!.props.onClick!();
};

it("for someone who may buy: what Cloud does, the Admin's lowest price and money-back, Start free trial (the dialog) and Compare plans", async () => {
  const html = await card(signedOut);
  for (const text of ["OpenMausBot Cloud", "Keeps your bots and routines running 24/7, even when this computer is off.", "OpenMausBot Cloud plans from $29/month + tax.",
    "14-day money-back on every plan.", "OpenMausBot on this computer stays free and open source.", "Compare plans", "Start free trial", "Sign in to your Cloud plan"]) expect(html).toContain(text);
  for (const gone of ["OMB", "$89", "launch price", "New features first", "Get Pro", "OpenMausBot Pro"]) expect(html).not.toContain(gone);
  press("Start free trial");
  expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_settings" });
  press("Compare plans"); await flush();
  expect(openExternal).toHaveBeenCalledWith("https://www.openmausbot.com/pricing?src=app_settings");
  press("Sign in to your Cloud plan");
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true });
});

it("without a trial it says Add a Cloud; signed in, no sign-in link; without the Admin's numbers, no price and no money-back", async () => {
  offer = { plans: PLANS.map(({ trialDays: _days, ...rest }) => rest), recommended: "pro" };
  const html = await card(plan());
  expect(html).toContain(">Add a Cloud<"); expect(html).not.toContain("Start free trial");
  expect(html).not.toContain("Sign in to your Cloud plan"); expect(html).not.toContain("money-back");
  offer = null;
  const unknown = await card(plan());
  expect(unknown).toContain(">Add a Cloud<"); expect(unknown).not.toContain("plans from");
});

it("someone with a plan sees that plan and the way to it, never an offer, and Cloud is never asked", async () => {
  for (const [state, text] of [
    [plan({ entitlement: paid("max") }), "Max active · verified by OpenMausBot Cloud"],
    [plan({ entitlement: paid("pro", "inactive") }), "Pro · not active right now"],
    [plan({ purchase: { state: "confirming", tier: "personal" } }), "Personal · payment received"],
    [{ status: "unavailable", lastPlan: { tier: "personal", active: true } }, "Personal · checking with OpenMausBot Cloud…"],
    [{ status: "reauth-required", message: "expired", lastPlan: { tier: "max", active: true } }, "Sign in again to use My Cloud on this computer. Your plan is not affected."],
  ] as const) {
    const html = await card(state as CloudAccountState);
    expect(html).toContain(text); expect(html).toContain("OpenMausBot Cloud settings");
    expect(html).not.toContain("Start free trial"); expect(html).not.toContain("$29");
  }
  expect(bridge.offer).not.toHaveBeenCalled();
  for (const state of [{ status: "unavailable" }, { status: "connecting" }, { status: "signed-out", message: "restoring" }] as CloudAccountState[]) expect(await card(state)).toBe("");
  await card(plan({ entitlement: paid("max") }));
  press("OpenMausBot Cloud settings");
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
});

it("never offers a plan to anyone who pays, may pay, or whose state is unknown; and never in a browser or on another server", async () => {
  const nobodyToSell: Array<CloudAccountState | null> = [
    null, { status: "signed-out", message: "restoring" }, { status: "signed-out", message: "restore-removed" }, { status: "connecting" },
    plan({ entitlement: paid("max") }), plan({ entitlement: paid("personal"), checking: true }), plan({ entitlement: paid("pro", "inactive") }),
    plan({ machine: { status: "payment-problem", origin: "https://home.fly.dev" } }), plan({ machine: { status: "stopped" } }),
    plan({ purchase: { state: "confirming", tier: "personal" } }), plan({ purchase: { state: "held" } }),
    { status: "unavailable", lastPlan: { tier: "max", active: true } }, { status: "unavailable" },
    { status: "reauth-required", message: "expired", lastPlan: { active: true } }, { status: "reauth-required" },
  ];
  for (const state of nobodyToSell) expect(proOfferAvailable(state), JSON.stringify(state)).toBe(false);
  expect(proOfferAvailable(signedOut)).toBe(true); expect(proOfferAvailable(plan())).toBe(true);
  vi.stubGlobal("window", { ogb: { remoteClient: { active: true }, cloudAccount: bridge } });
  expect(await card(signedOut)).toBe("");
  vi.stubGlobal("window", {});
  expect(await card(signedOut)).toBe("");
});
