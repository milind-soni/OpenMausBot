import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

vi.hoisted(() => {
  vi.stubGlobal("window", { location: { pathname: "/", search: "", assign: vi.fn() } });
  // Match the production build: the app, Full Plans included, is served under /swarm/. With
  // vitest's own base ("/") the base-relative and root paths would coincide.
  vi.stubEnv("BASE_URL", "/swarm/");
  vi.stubEnv("DEV", false);
  vi.stubEnv("PROD", true);
});
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { connected: false }, dispatch: vi.fn() }),
  api: vi.fn(),
}));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

import {
  NationCredits, NationCreditsProvider, NationCreditsStrip, NationCreditsSettingsRow, FullPlansHeader, PackCard, PayWith,
  NATION_MARK_SRC, nationInvoiceDiscount, packPriceUsd, formatUsd,
  CheckoutPanel, PendingInvoices, filterLivePendingInvoices, pendingInvoiceRows, invoiceRequest, EXPIRED_ROW_MS,
  nationPayable, formatTokenUnits, fullPlansHref, isFullPlansPath, goToFullPlans, FULL_PLANS_HREF,
  FreeCard, freePlanCurrent,
} from "./NationCredits";
import { NationCreditsCtx, useNationCredits, type CreditStatus, type CreditTier } from "@/lib/nation-credits-ctx";

type Status = Parameters<typeof NationCreditsStrip>[0]["status"];

const chain = { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0x1" as Hex, treasury: "0x2" as Hex };
const base: Status = {
  balanceUsd: 5, label: "$5.00 credit", verified: true, exempt: false,
  lowBalance: false, topUpEnabled: true, topUpMessage: "", starterMessage: "",
  packs: [10, 25], chains: [chain], invoices: [],
};

beforeEach(() => vi.unstubAllGlobals());

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Matches an element whose whole text is `text`, e.g. <a …>Top up</a>. */
const element = (tag: string, text: string) => new RegExp(`<${tag}\\b[^>]*>${escapeRegExp(text)}</${tag}>`);
const linkTo = (href: string, text: string) =>
  new RegExp(`<a\\b[^>]*href="${escapeRegExp(href)}"[^>]*>${escapeRegExp(text)}</a>`);

// ─── Full Plans routing ───────────────────────────────────────────────────────

describe("Full Plans location", () => {
  it("is under the app's base, the only prefix thenation.city forwards to the app", () => {
    expect(fullPlansHref("/swarm/")).toBe("/swarm/subscription");
    expect(fullPlansHref("/")).toBe("/subscription");
  });

  it("recognizes both the public path and the base-relative path", () => {
    for (const path of ["/subscription", "/subscription/", "/swarm/subscription", "/swarm/subscription/"]) {
      expect(isFullPlansPath(path, "/swarm/"), path).toBe(true);
    }
    for (const path of ["/", "/swarm/", "/swarm", "/subscriptions", "/swarm/subscription/x", "/admin/subscription"]) {
      expect(isFullPlansPath(path, "/swarm/"), path).toBe(false);
    }
  });

  it("navigates with a full page load to /swarm/subscription", () => {
    expect(FULL_PLANS_HREF).toBe("/swarm/subscription");
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/swarm/", search: "", assign } });
    goToFullPlans();
    expect(assign).toHaveBeenCalledWith("/swarm/subscription");
  });
});

// ─── NationCreditsStrip ────────────────────────────────────────────────────────

describe("NationCreditsStrip", () => {
  it("primary Top up links to Full Plans instead of opening the sheet", () => {
    const onStarter = vi.fn();
    const html = renderToStaticMarkup(createElement(NationCreditsStrip, { status: base, onStarter }));
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
    expect(html).not.toMatch(element("button", "Top up"));
    expect(onStarter).not.toHaveBeenCalled();
  });

  it("keeps the sheet only for Get free starter credit", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, verified: false }, onStarter: vi.fn() }),
    );
    expect(html).toMatch(element("button", "Get free starter credit"));
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
  });

  it("shows Top up when topUpEnabled and NOT exempt", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: true, exempt: false }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Top up");
    expect(html).not.toContain("NATION API");
  });

  it("shows Top up when topUpEnabled AND exempt (owner can test payment flow)", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: true, exempt: true }, onStarter: vi.fn() }),
    );
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
    expect(html).toContain("NATION API");
  });

  it("shows topUpMessage for non-exempt when topUpEnabled is false", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: false, topUpMessage: "Top up launching soon" }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Top up launching soon");
    expect(html).not.toContain(">Top up<");
  });

  it("shows muted topUpMessage for exempt when topUpEnabled is false", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: true, topUpMessage: "Coming soon for members" }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Coming soon for members");
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("NATION API");
  });

  it("renders nothing actionable for exempt + topUpDisabled + no topUpMessage", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: true, topUpMessage: "" }, onStarter: vi.fn() }),
    );
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("NATION API");
  });

  it("shows Get free starter credit for unverified users (regardless of exempt)", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, verified: false, exempt: true }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Get free starter credit");
  });
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const usdgToken = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Hex;
const nationToken = "0xc839a88a05b231515a82c71ee97b4f18973c1340" as Hex;
// The founder's Robinhood treasury, checksummed as the server returns it.
const robinhoodTreasury = "0x85E3C2D8f776d9D05b14E108F368070CbD8C1639" as Hex;
const baseToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Hex;

// The live server lists $NATION first whenever NATION_TOKEN_USD_PRICE is set.
const liveChains: CreditStatus["chains"] = [
  { id: 4663, name: "Robinhood Chain", symbol: "$NATION", token: nationToken, treasury: robinhoodTreasury, decimals: 18 },
  { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: usdgToken, treasury: robinhoodTreasury, decimals: 6 },
];
const liveUsdgOnly: CreditStatus["chains"] = [
  { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: usdgToken, treasury: robinhoodTreasury, decimals: 6 },
];

const tiers: CreditTier[] = [
  { id: "starter", name: "Starter", usd: 15, creditUsd: 15, popular: false },
  { id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true },
  { id: "swarm", name: "Swarm", usd: 99, creditUsd: 99, popular: false },
];
const liveStatus: CreditStatus = {
  balanceUsd: 5, label: "$5.00 credit left", verified: true, exempt: false, lowBalance: false,
  topUpEnabled: true, topUpMessage: "Top up", starterMessage: "Starter credit already received",
  packs: [15, 49, 99], tiers, nationPriceUsd: 0.000286, nationDiscount: 0.2, nationInvoiceDiscount: 0.2, chains: liveChains, invoices: [],
};

// ─── Settings → Billing & Credits ─────────────────────────────────────────────

describe("NationCreditsSettingsRow", () => {
  const renderRow = (status: CreditStatus) => renderToStaticMarkup(createElement(
    NationCreditsCtx.Provider,
    { value: { status, refresh: vi.fn(), starterOpen: false, openStarter: vi.fn(), closeStarter: vi.fn(), openSubscription: vi.fn() } },
    createElement(NationCreditsSettingsRow),
  ));

  it("Top up links to Full Plans", () => {
    const html = renderRow(liveStatus);
    expect(html).toContain("Billing &amp; Credits");
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
    expect(html).not.toMatch(element("button", "Top up"));
  });

  it("shows the server message instead when top up is unavailable", () => {
    const html = renderRow({ ...liveStatus, topUpEnabled: false, topUpMessage: "Top up coming soon", chains: [] });
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("Top up coming soon");
  });
});

describe("NationCreditsProvider", () => {
  // The account menu and Settings are siblings of the strip, not its children.
  const Probe = () => createElement("span", null, String(useNationCredits().openSubscription === goToFullPlans));

  it("gives every consumer under it — account menu, Settings — the real Full Plans navigation", () => {
    vi.stubGlobal("window", { location: { pathname: "/swarm/", search: "", assign: vi.fn() } });
    expect(renderToStaticMarkup(createElement(NationCreditsProvider, null, createElement(Probe)))).toBe("<span>true</span>");
  });

  it("outside it, the context default is a no-op (why the provider wraps the whole app)", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>false</span>");
  });
});

// ─── Full Plans page ──────────────────────────────────────────────────────────

describe("Full Plans page", () => {
  const renderAt = (pathname: string) => {
    vi.stubGlobal("window", { location: { pathname, search: "", assign: vi.fn() }, history: { length: 1 } });
    return renderToStaticMarkup(createElement(NationCredits));
  };
  const headline = "Permanent credit for your whole AI team.";

  it("renders Full Plans on the root /subscription shared before, with no sheet", () => {
    const html = renderAt("/subscription");
    expect(html).toContain('id="full-plans-title"');
    expect(html).toMatch(element("h1", headline));
    expect(html).toContain(">Full Plans<");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Top up credits");
  });

  it("renders it on the base-relative path too", () => {
    expect(renderAt("/swarm/subscription/")).toMatch(element("h1", headline));
  });

  it("stays out of the chat shell elsewhere", () => {
    expect(renderAt("/swarm/")).not.toContain("Full Plans");
  });

  it("header carries the NATION column mark, a short headline and the permanent-credit pitch", () => {
    const html = renderToStaticMarkup(createElement(FullPlansHeader, { status: liveStatus }));
    expect(NATION_MARK_SRC).toMatch(/nation-mark\.png$/);
    expect(html).toMatch(/<img[^>]*src="[^"]*nation-mark\.png"/);
    expect(html).toMatch(element("h1", headline));
    expect(html).toContain("USDG or $NATION on Robinhood Chain");
    expect(html).toContain("never expires");
    expect(html).toContain("no subscription");
  });

  it("header offers only USDG when $NATION is not payable", () => {
    const html = renderToStaticMarkup(createElement(FullPlansHeader, { status: { ...liveStatus, nationPriceUsd: null } }));
    expect(html).toContain("Top up once with USDG on Robinhood Chain");
    expect(html).not.toContain("$NATION");
  });
});

// ─── Free plan ─────────────────────────────────────────────────────────────────

describe("Free plan card", () => {
  const free: CreditStatus = { ...liveStatus, plan: "free", onFreePlan: true, starterCreditUsd: 3, starterGranted: true };
  const render = (status: CreditStatus) => renderToStaticMarkup(createElement(FreeCard, { status }));

  it("is the current plan for an account that has not paid: badge, $0, pitch, disabled CTA, honest checklist", () => {
    const html = render(free);
    expect(html).toMatch(element("h3", "Free"));
    expect(html).toMatch(/<span class="[^"]*\bbg-nation\b[^"]*">Current plan<\/span>/);
    expect(html).toContain(">$0<");
    expect(html).toContain("Try Nation Team Chat with starter credit.");
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>.*Current plan<\/button>/);
    for (const item of ["$3 starter credit", "Your own bots + team chat", "Paid credits never expire when you top up", "No subscription · pay only when you top up"]) {
      expect(html).toContain(item);
    }
    // never sold, and independent of the Pay with toggle
    expect(html).not.toMatch(/Pay |Save|\$NATION|USDG|one-time/);
  });

  it("quotes the starter grant the server reports, not a hard-coded amount", () => {
    expect(render({ ...free, starterCreditUsd: 5 })).toContain("$5 starter credit");
    expect(render({ ...free, starterCreditUsd: 2.5 })).toContain("$2.50 starter credit");
    // an older server sends no amount: no number is invented
    const unknown = render({ ...free, starterCreditUsd: undefined });
    expect(unknown).toContain("Starter credit");
    expect(unknown).not.toMatch(/\$\d+ starter credit/);
  });

  it("tells an account that has not received the credit why", () => {
    expect(render({ ...free, verified: false, starterGranted: false })).toContain("Verify your email or wallet to receive it.");
    expect(render({ ...free, starterGranted: false, starterMessage: "Starter credit is unavailable for this device or network." }))
      .toContain("Starter credit is unavailable for this device or network.");
    expect(render(free)).not.toContain("Verify your email");
  });

  it("is not current once a pack is paid, and still offers nothing to buy", () => {
    const html = render({ ...free, plan: "paid", onFreePlan: false });
    expect(html).not.toContain("Current plan");
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Included<\/button>/);
  });

  it("owner/admin accounts are exempt: no badge", () => {
    const html = render({ ...free, exempt: true, onFreePlan: false, starterGranted: false, starterMessage: "Owner/admin access" });
    expect(html).not.toContain("Current plan");
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Owner access<\/button>/);
    expect(html).not.toContain("Owner/admin access");
  });

  it("works out the plan from an older server's status", () => {
    expect(freePlanCurrent(liveStatus)).toBe(true);
    expect(freePlanCurrent({ ...liveStatus, invoices: [{ ...makeInvoice(4663, usdgToken, true) }] })).toBe(false);
    expect(freePlanCurrent({ ...liveStatus, exempt: true })).toBe(false);
    expect(freePlanCurrent({ ...liveStatus, plan: "paid" })).toBe(false);
    expect(freePlanCurrent({ ...liveStatus, onFreePlan: true, exempt: true })).toBe(false);
  });

  it("sits first in a four-column grid ahead of the three paid packs", () => {
    vi.stubGlobal("window", { location: { pathname: "/subscription", search: "", assign: vi.fn() }, history: { length: 1 } });
    const html = renderToStaticMarkup(createElement(
      NationCreditsCtx.Provider,
      { value: { status: free, refresh: vi.fn(), starterOpen: false, openStarter: vi.fn(), closeStarter: vi.fn(), openSubscription: vi.fn() } },
      createElement(NationCredits),
    ));
    expect([...html.matchAll(/<h3\b[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1])).toEqual(["Free", "Starter", "Builder", "Swarm"]);
    expect(html).toMatch(/class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4"/);
    expect(html.match(/>Current plan</g)).toHaveLength(2);
  });
});

// ─── Pricing helpers ───────────────────────────────────────────────────────────

describe("$NATION discount the page may advertise", () => {
  it("comes only from nationInvoiceDiscount, which only a discounting server sends", () => {
    expect(nationInvoiceDiscount(liveStatus)).toBe(0.2);
    // An older server sends nationDiscount but bills $NATION in full: no saving to show.
    expect(nationInvoiceDiscount({ ...liveStatus, nationInvoiceDiscount: undefined })).toBe(0);
    expect(nationInvoiceDiscount({ ...liveStatus, nationInvoiceDiscount: null })).toBe(0);
    for (const bad of [0, 1, 1.5, -0.2]) expect(nationInvoiceDiscount({ ...liveStatus, nationInvoiceDiscount: bad })).toBe(0);
    expect(nationInvoiceDiscount(null)).toBe(0);
  });

  it("prices packs the way the server bills them, to the cent", () => {
    expect([15, 49, 99].map((usd) => packPriceUsd(usd, 0.2))).toEqual([12, 39.2, 79.2]);
    expect(packPriceUsd(49, 0)).toBe(49);
    expect([12, 39.2, 79.2, 49].map(formatUsd)).toEqual(["$12", "$39.20", "$79.20", "$49"]);
  });
});

// ─── PackCard ──────────────────────────────────────────────────────────────────

const builder: CreditTier = { id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true };
const starter: CreditTier = { id: "starter", name: "Starter", usd: 15, creditUsd: 15, popular: false };

describe("PackCard", () => {
  const usdgProps = {
    tier: builder, payWithNation: false, nationPriceUsd: 0.000286, nationDiscount: 0.2,
    stableSymbol: "USDG", busy: false, onSelect: vi.fn(),
  };
  const nationProps = { ...usdgProps, payWithNation: true };
  /** The $NATION amount a card quotes, as a number. */
  const quoted = (html: string) => Number(/≈ ([\d,.]+) \$NATION/.exec(html)?.[1]?.replace(/,/g, ""));

  it("with USDG: the pack price, no strikethrough, no discount", () => {
    const html = renderToStaticMarkup(createElement(PackCard, usdgProps));
    expect(html).toContain(">$49<");
    expect(html).toContain("Pay $49 with USDG");
    expect(html).not.toContain("$NATION");
    expect(html).not.toContain("Save");
    expect(html).not.toContain("<s>");
    expect(html).not.toContain("USDC");
  });

  it("with $NATION: the discounted price, 'instead of $49 USDG' struck through, Save 20% and the matching CTA", () => {
    const html = renderToStaticMarkup(createElement(PackCard, nationProps));
    expect(html).toContain(">$39.20<");
    expect(html).toContain("instead of <s>$49 USDG</s>");
    expect(html).toContain("Save 20%");
    expect(html).toContain("Pay $39.20 worth of $NATION · Save 20%");
    expect(quoted(html)).toBeCloseTo(39.2 / 0.000286, 1);
  });

  it("$NATION amount is 20% cheaper exactly when the badge shows", () => {
    const discounted = renderToStaticMarkup(createElement(PackCard, nationProps));
    const full = renderToStaticMarkup(createElement(PackCard, { ...nationProps, nationDiscount: 0 }));
    expect(discounted).toContain("Save 20%");
    expect(full).not.toContain("Save");
    expect(full).toContain("Pay $49 worth of $NATION<");
    expect(quoted(discounted) / quoted(full)).toBeCloseTo(0.8, 4);
    expect(quoted(full)).toBeCloseTo(49 / 0.000286, 1);
  });

  it("marks Builder as most popular with the brand CTA, and names the pack in the button", () => {
    const html = renderToStaticMarkup(createElement(PackCard, nationProps));
    expect(html).toContain("Most popular");
    expect(html).toMatch(/<button[^>]*aria-label="Builder: Pay \$39\.20 worth of \$NATION · Save 20%"[^>]*class="[^"]*\bbg-nation\b/);
    const plain = renderToStaticMarkup(createElement(PackCard, { ...usdgProps, tier: starter }));
    expect(plain).not.toContain("Most popular");
    expect(plain).toMatch(/<button[^>]*aria-label="Starter: Pay \$15 with USDG"[^>]*class="[^"]*\bbg-ink\b/);
    expect(plain).toContain(">Permanent credit<");
    expect(plain).toContain(">$15<");
    expect(plain).toContain(">Never<");
  });

  it("falls back to the stablecoin when $NATION is not priced", () => {
    const html = renderToStaticMarkup(createElement(PackCard, { ...nationProps, nationPriceUsd: null }));
    expect(html).toContain("Pay $49 with USDG");
    expect(html).not.toContain("$NATION");
  });

  it("does not redirect anywhere on its own", () => {
    const html = renderToStaticMarkup(createElement(PackCard, usdgProps));
    expect(html).not.toContain("window.location.href");
    expect(html).not.toContain("thenation.city/subscription");
  });
});

// ─── Pay with ──────────────────────────────────────────────────────────────────

describe("PayWith", () => {
  const props = { payWithNation: false, hasNation: true, stableSymbol: "USDG", nationDiscount: 0.2, onChange: vi.fn() };
  const checkedValue = (html: string) =>
    [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag).filter((tag) => /\bchecked=""/.test(tag))
      .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);

  it("offers only USDG when $NATION is not payable (toggle gating)", () => {
    const html = renderToStaticMarkup(createElement(PayWith, { ...props, hasNation: false, nationDiscount: 0 }));
    expect(html).toContain("Pay with");
    expect(html).toContain("USDG");
    expect(html).not.toContain("$NATION");
    expect(html).not.toContain('type="radio"');
  });

  it("is a labelled pill choice with USDG selected by default", () => {
    const html = renderToStaticMarkup(createElement(PayWith, props));
    expect(html).toMatch(/role="radiogroup" aria-labelledby="[^"]+"/);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(checkedValue(html)).toEqual(["USDG"]);
    expect(html).toContain("$NATION saves about 20%.");
    expect(html).toContain("Same packs, lower price.");
  });

  it("marks $NATION as the one selected pill when chosen", () => {
    const html = renderToStaticMarkup(createElement(PayWith, { ...props, payWithNation: true }));
    expect(checkedValue(html)).toEqual(["NATION"]);
    const pills = [...html.matchAll(/<label\b[^>]*class="([^"]*)"/g)].map(([, cls]) => cls);
    expect(pills.filter((cls) => /\bshadow-sm\b/.test(cls))).toHaveLength(1);
    expect(pills[0]).toMatch(/\bshadow-sm\b/); // $NATION is the first pill
  });

  it("never claims a saving the server does not apply", () => {
    const html = renderToStaticMarkup(createElement(PayWith, { ...props, nationDiscount: 0 }));
    expect(html).toContain("$NATION");
    expect(html).not.toContain("saves");
  });
});

describe("nationPayable (toggle gating)", () => {
  it("needs both the $NATION chain entry and a positive price", () => {
    expect(nationPayable(liveStatus)).toBe(true);
    expect(nationPayable({ chains: liveChains, nationPriceUsd: null })).toBe(false);
    expect(nationPayable({ chains: liveChains, nationPriceUsd: 0 })).toBe(false);
    expect(nationPayable({ chains: liveUsdgOnly, nationPriceUsd: 0.000286 })).toBe(false);
    expect(nationPayable(null)).toBe(false);
  });
});

// ─── Invoice creation ─────────────────────────────────────────────────────────

describe("invoiceRequest", () => {
  it("sends chain + token + packUsd so USDG and $NATION on chain 4663 stay distinct", () => {
    expect(invoiceRequest(liveChains, false, 49)).toEqual({ chain: 4663, token: usdgToken, packUsd: 49 });
    expect(invoiceRequest(liveChains, true, 49)).toEqual({ chain: 4663, token: nationToken, packUsd: 49 });
  });

  it("refuses $NATION when the server does not offer it", () => {
    expect(invoiceRequest(liveUsdgOnly, true, 15)).toBeNull();
    expect(invoiceRequest([], false, 15)).toBeNull();
  });
});

describe("formatTokenUnits", () => {
  it("is exact at 18 decimals, where a rounded figure would never match the transfer", () => {
    expect(formatTokenUnits(52_447_552_447_552_447_552_447n, 18)).toBe("52447.552447552447552447");
    expect(formatTokenUnits(49_012_345n, 6)).toBe("49.012345");
    expect(formatTokenUnits(15_000_000n, 6)).toBe("15");
    expect(formatTokenUnits(5n, 18)).toBe("0.000000000000000005");
  });
});

// ─── CheckoutPanel ─────────────────────────────────────────────────────────────

const usdgChain = { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0xabc" as Hex, treasury: "0xdef" as Hex, decimals: 6 };
const usdgInvoice = {
  id: "inv-1", chain: 4663, treasury: "0xdef" as Hex, token: "0xabc" as Hex,
  pack_micros: 49_000_000, amount_micros: 49_012_345, token_amount: "",
  expires_at: Date.now() + 30 * 60_000, paid_tx: null,
};
const checkoutStatus: CreditStatus = {
  balanceUsd: 5, label: "$5.00", verified: true, exempt: false, lowBalance: false,
  topUpEnabled: true, topUpMessage: "", starterMessage: "", packs: [15, 49, 99],
  tiers: [{ id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true }],
  nationPriceUsd: null, nationDiscount: null,
  chains: [usdgChain],
  invoices: [],
};

describe("CheckoutPanel", () => {
  const baseProps = {
    invoice: usdgInvoice,
    status: checkoutStatus,
    busy: false,
    hash: "",
    onHash: vi.fn(),
    onPay: vi.fn(),
    onConfirm: vi.fn(),
    onBack: vi.fn(),
  };

  it("shows USDG symbol — not hardcoded USDC — for Robinhood chain invoice", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("USDG");
    expect(html).not.toContain("USDC");
  });

  it("shows Robinhood Chain network — not hardcoded Base — for chain 4663", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("Robinhood Chain");
    expect(html).not.toContain(">Base<");
  });

  it("shows payment amount from invoice.amount_micros", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    // 49_012_345 micros → 49.012345 USDG
    expect(html).toContain("49.012345");
  });

  it("shows the pack, the exact amount to send and the credit it buys", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("Builder pack");
    expect(html).toContain("49.012345 USDG");
    expect(html).toContain("You receive $49.01 of permanent credit.");
    expect(html).toContain("Robinhood Chain");
    expect(html).not.toContain("Save");
  });

  it("sends both tokens to the same NATION treasury, with the exact amount for each", () => {
    const usdg = { ...usdgInvoice, token: usdgToken, treasury: robinhoodTreasury, token_amount: "49012345", discount_bps: 0 };
    const nation = { ...usdgInvoice, token: nationToken, treasury: robinhoodTreasury, token_amount: "137096744755244755244755", discount_bps: 2000 };
    for (const [invoice, exact] of [[usdg, "49.012345 USDG"], [nation, "137096.744755244755244755 $NATION"]] as const) {
      const html = renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice, status: liveStatus }));
      expect(html).toContain("To the NATION treasury on Robinhood Chain");
      expect(html).toContain(`>${robinhoodTreasury}</code>`);
      expect(html).toContain(exact);
    }
  });

  it("says a $NATION request is 20% off only when the invoice itself was discounted", () => {
    const discounted = { ...usdgInvoice, token: nationToken, treasury: robinhoodTreasury, token_amount: "137096744755244755244755", discount_bps: 2000 };
    expect(renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice: discounted, status: liveStatus })))
      .toContain("Save 20% with $NATION.");
    const fullPrice = { ...discounted, discount_bps: 0 };
    expect(renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice: fullPrice, status: liveStatus })))
      .not.toContain("Save");
  });

  it("asks for the exact $NATION amount the payment check expects", () => {
    const nationInvoice = {
      ...usdgInvoice, token: nationToken, treasury: robinhoodTreasury,
      token_amount: "171372552447552447552447",
    };
    const html = renderToStaticMarkup(
      createElement(CheckoutPanel, { ...baseProps, invoice: nationInvoice, status: liveStatus }),
    );
    expect(html).toContain("171372.552447552447552447 $NATION");
    expect(html).not.toContain("USDG");
  });

  it("names the USDG invoice correctly even though $NATION is listed first on the same chain id", () => {
    const invoice = { ...usdgInvoice, token: usdgToken, treasury: robinhoodTreasury, token_amount: "49012345" };
    const html = renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice, status: liveStatus }));
    expect(html).toContain("49.012345 USDG");
    expect(html).not.toContain("$NATION");
  });

  it("never guesses a symbol for an invoice whose token is no longer offered", () => {
    const orphan = { ...usdgInvoice, chain: 8453, token: baseToken };
    const html = renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice: orphan }));
    expect(html).toContain("no longer offered");
    expect(html).not.toContain(" ?");
    expect(html).not.toContain("Pay with a connected wallet");
  });

  it("shows staged action buttons: Pay with a connected wallet + I've paid — confirm", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("Pay with a connected wallet");
    expect(html).toContain("I&#x27;ve paid");
  });

  it("shows paid confirmation when invoice is paid", () => {
    const paid = { ...usdgInvoice, paid_tx: "0xdeadbeef" as Hex };
    const html = renderToStaticMarkup(
      createElement(CheckoutPanel, { ...baseProps, invoice: paid }),
    );
    expect(html).toContain("Payment verified");
    expect(html).not.toContain("Send payment");
  });

  it("shows Back button to return to tier picker", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    // Named apart from the page's own "← Back", which leaves Full Plans.
    expect(html).toMatch(element("button", "← Back to packs"));
  });
});

// ─── filterLivePendingInvoices ────────────────────────────────────────────────

const makeInvoice = (chain: number, token: Hex, paid = false): CreditStatus["invoices"][number] => ({
  id: crypto.randomUUID(),
  chain, treasury: robinhoodTreasury, token,
  pack_micros: 15_000_000, amount_micros: 15_000_500, token_amount: "",
  expires_at: Date.now() + 3_600_000,
  paid_tx: paid ? ("0x" + "a".repeat(64)) as Hex : null,
});

describe("filterLivePendingInvoices", () => {
  it("keeps invoices whose chain+token pair is in live chains", () => {
    const inv = makeInvoice(4663, usdgToken);
    expect(filterLivePendingInvoices([inv], liveUsdgOnly)).toHaveLength(1);
  });

  it("removes invoices on a dropped chain (Base 8453 after Robinhood-only migration)", () => {
    const orphan = makeInvoice(8453, baseToken);
    const result = filterLivePendingInvoices([orphan], liveUsdgOnly);
    expect(result).toHaveLength(0);
  });

  it("removes paid invoices even when their chain is live", () => {
    const paid = makeInvoice(4663, usdgToken, true);
    expect(filterLivePendingInvoices([paid], liveUsdgOnly)).toHaveLength(0);
  });

  it("distinguishes USDG and $NATION on the same chain id 4663 by token address", () => {
    const usdgInv = makeInvoice(4663, usdgToken);
    const nationInv = makeInvoice(4663, nationToken);
    // Both chains live → both invoices kept
    expect(filterLivePendingInvoices([usdgInv, nationInv], liveChains)).toHaveLength(2);
    // Only USDG live → only USDG invoice kept
    expect(filterLivePendingInvoices([usdgInv, nationInv], liveUsdgOnly)).toHaveLength(1);
    expect(filterLivePendingInvoices([usdgInv, nationInv], liveUsdgOnly)[0].token).toBe(usdgToken);
  });

  it("matches token addresses case-insensitively", () => {
    const checksummed = makeInvoice(4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex);
    expect(filterLivePendingInvoices([checksummed], liveUsdgOnly)).toHaveLength(1);
  });

  it("returns empty list when chains is empty", () => {
    const inv = makeInvoice(4663, usdgToken);
    expect(filterLivePendingInvoices([inv], [])).toHaveLength(0);
  });

  it("returns empty list when invoices is empty", () => {
    expect(filterLivePendingInvoices([], liveChains)).toHaveLength(0);
  });

  it("mixed: keeps live pending, drops orphan, drops paid", () => {
    const livePending = makeInvoice(4663, usdgToken);
    const orphan = makeInvoice(8453, baseToken);
    const paid = makeInvoice(4663, usdgToken, true);
    const result = filterLivePendingInvoices([livePending, orphan, paid], liveUsdgOnly);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(livePending);
  });
});

// ─── Pending rows (what Full Plans shows) ─────────────────────────────────────

describe("pendingInvoiceRows", () => {
  // The rows the founder saw on the live page, rebuilt from the old defaults and chain order:
  //   – a $25 pack on Base from before the Robinhood-only migration ("25.1462 ?")
  //   – a USDG invoice read against the $NATION entry listed first ("0.0000 $NATION")
  const baseOrphan = { ...makeInvoice(8453, baseToken), pack_micros: 25_000_000, amount_micros: 25_146_200 };
  const usdgPending = { ...makeInvoice(4663, usdgToken), amount_micros: 15_123_456, token_amount: "15123456" };
  const nationPending = { ...makeInvoice(4663, nationToken), amount_micros: 15_123_456, token_amount: "52879216783216783216783" };
  // A $NATION-token row carrying a stablecoin-sized amount is not a real payment request.
  const zeroNation = { ...makeInvoice(4663, nationToken), amount_micros: 15_123_456, token_amount: "15123456" };

  it("never renders '?' and hides the orphan Base invoice", () => {
    const rows = pendingInvoiceRows([baseOrphan, usdgPending], liveChains);
    expect(rows.map((r) => r.invoice.id)).toEqual([usdgPending.id]);
    expect(rows.every((r) => r.symbol === "USDG" || r.symbol === "$NATION")).toBe(true);
  });

  it("labels a USDG invoice as USDG with its real amount even though $NATION is listed first", () => {
    const [row] = pendingInvoiceRows([usdgPending], liveChains);
    expect(row).toMatchObject({ symbol: "USDG", amount: "15.1235" });
  });

  it("hides zero-amount pending invoices (0.0000 …)", () => {
    expect(pendingInvoiceRows([zeroNation], liveChains)).toEqual([]);
    const empty = { ...makeInvoice(4663, usdgToken), amount_micros: 0, token_amount: "0" };
    expect(pendingInvoiceRows([empty], liveChains)).toEqual([]);
  });

  it("shows $NATION amounts in whole tokens", () => {
    const [row] = pendingInvoiceRows([nationPending], liveChains);
    expect(row).toMatchObject({ symbol: "$NATION", amount: "52,879.2168" });
  });

  it("hides rows whose stored amount cannot be read", () => {
    expect(pendingInvoiceRows([{ ...usdgPending, token_amount: "not-a-number" }], liveChains)).toEqual([]);
  });

  it("flags expired requests instead of showing a past expiry time", () => {
    const now = Date.now();
    const [row] = pendingInvoiceRows([{ ...usdgPending, expires_at: now - 1 }], liveChains, now);
    expect(row.expired).toBe(true);
  });

  it("renders a list with no '?' and no zero rows", () => {
    const rows = pendingInvoiceRows([baseOrphan, usdgPending, nationPending, zeroNation], liveChains);
    const html = renderToStaticMarkup(createElement(PendingInvoices, { rows, onResume: vi.fn(), disabled: false }));
    expect(html).toContain("15.1235 USDG");
    expect(html).toContain("52,879.2168 $NATION");
    expect(html).not.toContain("?");
    expect(html).not.toContain("0.0000");
    expect(html).not.toContain("25.1462");
  });

  it("renders nothing when there is nothing to resume", () => {
    expect(renderToStaticMarkup(createElement(PendingInvoices, { rows: [], onResume: vi.fn(), disabled: false }))).toBe("");
  });

  it("never lists a Base (8453) row, even from a server that lists a Base chain entry", () => {
    const baseListed = [...liveChains, { ...liveChains[0]!, id: 8453, name: "Base", symbol: "USDC", token: baseToken }];
    const baseRow = { ...makeInvoice(8453, baseToken), amount_micros: 25_146_200, token_amount: "25146200" };
    expect(pendingInvoiceRows([baseRow, usdgPending], baseListed).map((r) => r.invoice.id)).toEqual([usdgPending.id]);
    // a live entry without a symbol would be the old "?" row
    expect(pendingInvoiceRows([usdgPending], liveChains.map((c) => ({ ...c, symbol: "" })))).toEqual([]);
  });

  it("puts live requests first and renders an expired one as an inert, labelled row", () => {
    const now = Date.now();
    const expired = { ...usdgPending, id: "expired-row", expires_at: now - 60_000 };
    const rows = pendingInvoiceRows([expired, nationPending], liveChains, now);
    expect(rows.map((r) => [r.invoice.id, r.expired])).toEqual([[nationPending.id, false], ["expired-row", true]]);
    const html = renderToStaticMarkup(createElement(PendingInvoices, { rows, onResume: vi.fn(), disabled: false }));
    expect(html).toContain("Resume a pending payment");
    // exactly one button: the live $NATION row; the expired USDG row is not clickable
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<div data-expired=""[^>]*>.*15\.1235 USDG.*Expired<\/span><\/div>/);
    expect(html).toContain("still credited once it is found on Robinhood Chain");
  });

  it("titles a list of only expired requests as recent, not resumable", () => {
    const now = Date.now();
    const rows = pendingInvoiceRows([{ ...usdgPending, expires_at: now - 1 }], liveChains, now);
    const html = renderToStaticMarkup(createElement(PendingInvoices, { rows, onResume: vi.fn(), disabled: false }));
    expect(html).toContain("Recent payment requests");
    expect(html).not.toContain("Resume a pending payment");
    expect(html).not.toContain("<button");
  });

  it("drops an expired request a day after it expired", () => {
    const now = Date.now();
    expect(pendingInvoiceRows([{ ...usdgPending, expires_at: now - EXPIRED_ROW_MS }], liveChains, now)).toEqual([]);
    expect(pendingInvoiceRows([{ ...usdgPending, expires_at: now - EXPIRED_ROW_MS + 60_000 }], liveChains, now)).toHaveLength(1);
  });
});
