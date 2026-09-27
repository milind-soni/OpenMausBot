/**
 * Nation credit top-up UX.
 *
 * Full Plans is the one place credit is bought:
 *   – <base>subscription renders it (thenation.city/swarm/subscription); the root
 *     /subscription still does wherever it reaches the app, for links shared before
 *   – ?pack=15|49|99 starts checkout for that pack; ?asset=USDG|NATION pre-selects the pay token
 *   – the top strip's "Top up", Settings → Billing & Credits and the account menu's
 *     "Add credits" all navigate there with a full page load
 * The bottom sheet is kept only for "Get free starter credit" (wallet verification).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, ChevronLeft, CircleDollarSign } from "lucide-react";
import type { EIP1193Provider, Hex } from "viem";
import { api, useStore } from "@/state/store";
import { NationCreditsCtx, useNationCredits, type CreditStatus, type CreditTier } from "@/lib/nation-credits-ctx";
import { SettingRow } from "./SettingsPrimitives";
import { NationWalletPay } from "./NationWalletPay";
import { cn } from "@/lib/cn";

const BASE_URL = import.meta.env.BASE_URL;

/** Where Full Plans lives: under the app's own base, the one prefix every host forwards to
 * the app. thenation.city sends only /swarm/* here, so its root /subscription is the city
 * site's 404 page. */
export function fullPlansHref(base: string): string {
  return `${base}subscription`.replace(/\/\//g, "/");
}
export const FULL_PLANS_HREF = fullPlansHref(BASE_URL);

/** The public URL and the base-relative one both render Full Plans. */
export function isFullPlansPath(pathname: string, base: string): boolean {
  const path = pathname.replace(/\/+$/, "");
  return path === "/subscription" || path === `${base}subscription`.replace(/\/\//g, "/");
}

/** Buying credit is a page of its own, never the sheet. */
export function goToFullPlans(): void {
  window.location.assign(FULL_PLANS_HREF);
}

// ─── style tokens ────────────────────────────────────────────────────────────
const btn =
  "rounded-xl bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-50 transition-opacity";
const field =
  "w-full rounded-xl border border-hairline/50 bg-inset p-3 text-ink focus:outline-none focus:border-accent/60";

// Narrow status type used by the pure strip + the Settings row.
type StripStatus = {
  balanceUsd: number;
  label: string;
  verified: boolean;
  exempt: boolean;
  lowBalance: boolean;
  topUpEnabled: boolean;
  topUpMessage: string;
  starterMessage: string;
  packs: number[];
  chains: Array<{ id: number; name: string; symbol: string; token: string; treasury: string }>;
  invoices: Array<{ id: string; chain: number; treasury: string; token: string; pack_micros: number; amount_micros: number; expires_at: number; paid_tx: string | null }>;
};

type Chain = CreditStatus["chains"][number];
type Invoice = CreditStatus["invoices"][number];

// ─── Payment helpers (exported for unit tests) ───────────────────────────────
/** An invoice's own chain entry. USDG and $NATION share Robinhood Chain's id, so the token
 * address has to match too. */
function chainFor(invoice: Pick<Invoice, "chain" | "token">, chains: Chain[]): Chain | undefined {
  return chains.find((c) => c.id === invoice.chain && c.token.toLowerCase() === invoice.token.toLowerCase());
}

/** $NATION is offered only when the server lists its chain entry and prices it. */
export function nationPayable(status: Pick<CreditStatus, "chains" | "nationPriceUsd"> | null): boolean {
  return Boolean(
    status && status.nationPriceUsd != null && status.nationPriceUsd > 0 &&
      status.chains.some((c) => c.symbol === "$NATION"),
  );
}

/** Body for POST /api/credits/invoices. The token address, not the shared chain id, picks
 * the currency the invoice is billed in. */
export function invoiceRequest(
  chains: Chain[],
  payWithNation: boolean,
  packUsd: number,
): { chain: number; token: string; packUsd: number } | null {
  const chain = chains.find((c) => (c.symbol === "$NATION") === payWithNation);
  return chain ? { chain: chain.id, token: chain.token, packUsd } : null;
}

/** An exact on-chain amount in whole tokens: 52447552447552447552447n at 18 decimals is
 * "52447.552447552447552447". A rounded figure would ask for a transfer that never matches. */
export function formatTokenUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${units / scale}.${fraction}` : String(units / scale);
}

/** What an invoice asks for, in whole tokens of its chain entry. Stablecoin invoices from
 * before token_amount existed carry only micros, which are already their token units. */
export function invoiceAmount(invoice: Invoice, chain: Chain): string {
  return formatTokenUnits(BigInt(invoice.token_amount || invoice.amount_micros), chain.decimals ?? 6);
}

// ─── Orphan invoice guard (exported for unit tests) ───────────────────────────
/** Top-ups are paid on Robinhood Chain only. A row on any other chain (Base 8453 from before
 * the migration, or anything a misconfigured server might list) is never offered. */
export const PAYMENT_CHAIN_ID = 4663;
/** An expired request stays visible, labelled and inert, for a day, then drops off. */
export const EXPIRED_ROW_MS = 24 * 60 * 60_000;

/**
 * Return only pending invoices whose chain+token pair is still present in the
 * live `chains` list. Invoices on dropped chains (e.g. old Base invoices after
 * the Robinhood-only migration) are excluded so the symbol never falls back to
 * "?".
 */
export function filterLivePendingInvoices(
  invoices: Invoice[],
  chains: Chain[],
): Invoice[] {
  return invoices.filter((i) => !i.paid_tx && i.chain === PAYMENT_CHAIN_ID && Boolean(chainFor(i, chains)?.symbol));
}

export type PendingRow = { invoice: Invoice; symbol: string; amount: string; expired: boolean };

/** Pending payment requests worth listing: unpaid, on a Robinhood Chain token the server still
 * offers, and for an amount that is not zero at the precision shown. Anything else is what
 * used to render as "25.1462 ?" or "0.0000 $NATION". Live requests come first; expired ones
 * follow for a day so a late payer sees what happened, then drop off. */
export function pendingInvoiceRows(invoices: Invoice[], chains: Chain[], now = Date.now()): PendingRow[] {
  const rows = filterLivePendingInvoices(invoices, chains).flatMap((invoice) => {
    if (invoice.expires_at <= now - EXPIRED_ROW_MS) return [];
    const chain = chainFor(invoice, chains)!;
    let amount: number;
    try {
      amount = Number(invoiceAmount(invoice, chain));
    } catch {
      return [];
    }
    if (!(amount >= 0.00005)) return [];
    return [{
      invoice,
      symbol: chain.symbol,
      amount: amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
      expired: invoice.expires_at <= now,
    }];
  });
  return [...rows.filter((row) => !row.expired), ...rows.filter((row) => row.expired)];
}

// ─── wallet helpers ───────────────────────────────────────────────────────────
async function injectedWallet() {
  const { createWalletClient, custom } = await import("viem");
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider)
    throw new Error(
      "Open an injected wallet, or use the address and transaction hash below.",
    );
  return createWalletClient({ transport: custom(provider) });
}

// ─── Pure strip (exported for tests and reuse) ────────────────────────────────
/** Top banner shown in the chat shell. "Top up" is a link to Full Plans; only the free
 * starter credit opens the sheet. Hidden on Full Plans itself. */
export function NationCreditsStrip({ status, onStarter }: { status: StripStatus; onStarter: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-b border-hairline/30 bg-panel px-4 py-2 text-xs text-ink">
      <span>{status.exempt ? "NATION API" : status.label}</span>
      {status.lowBalance && status.verified && (
        <span>Your teammates are ready when you are. Add credit to keep going.</span>
      )}
      {!status.verified && (
        <button className="underline" onClick={onStarter}>
          Get free starter credit
        </button>
      )}
      {status.topUpEnabled ? (
        <a className="font-medium underline" href={FULL_PLANS_HREF}>
          Top up
        </a>
      ) : !status.exempt ? (
        <span>{status.topUpMessage}</span>
      ) : status.topUpMessage ? (
        <span className="text-ink-secondary">{status.topUpMessage}</span>
      ) : null}
    </div>
  );
}

// ─── Full Plans pieces (exported for unit tests) ─────────────────────────────
/** The NATION column mark. Swapping the logo means replacing this one file. */
export const NATION_MARK_SRC = `${BASE_URL}nation-mark.png`;

/** The discount this server applies to $NATION invoices, or 0. Only a server that reports
 * nationInvoiceDiscount applies one: an older server sends nationDiscount but bills $NATION at
 * the full pack price, and "Save 20%" must never sit over a full-price charge. */
export function nationInvoiceDiscount(status: Pick<CreditStatus, "nationInvoiceDiscount"> | null): number {
  const discount = status?.nationInvoiceDiscount;
  return typeof discount === "number" && discount > 0 && discount < 1 ? discount : 0;
}

/** What a pack costs in USD when paid with a token carrying `discount` — the share the server
 * keeps is (10000 − discount in basis points) / 10000, exactly as it prices the invoice. */
export function packPriceUsd(packUsd: number, discount: number): number {
  return Math.round(packUsd * (10_000 - Math.round(discount * 10_000))) / 10_000;
}

/** "$12", "$39.20". */
export function formatUsd(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Full Plans header: the mark, a short headline and one pitch. */
export function FullPlansHeader({ status }: { status: CreditStatus | null }) {
  const stableSymbol = status?.chains.find((c) => c.symbol !== "$NATION")?.symbol ?? "USDG";
  const tokens = nationPayable(status) ? `${stableSymbol} or $NATION` : stableSymbol;
  return (
    <header className="max-w-3xl">
      <div className="flex items-center gap-3">
        <img src={NATION_MARK_SRC} alt="NATION" width={40} height={40} className="size-10 rounded-xl" />
        <span className="text-[13px] font-semibold uppercase tracking-[0.16em] text-nation-text">Full Plans</span>
      </div>
      <h1 id="full-plans-title" className="mt-6 text-[34px] font-bold leading-[1.1] tracking-tight text-ink sm:text-[44px]">
        Permanent credit for your whole AI team.
      </h1>
      <p className="mt-3 text-[17px] leading-relaxed text-ink-secondary">
        Top up once with {tokens} on Robinhood Chain. Credit never expires and is only spent when your
        teammates work — no subscription, nothing renews.
      </p>
    </header>
  );
}

/** "Pay with": compact pills. USDG is the default; $NATION appears only when the server prices it. */
export function PayWith({
  payWithNation,
  hasNation,
  stableSymbol,
  nationDiscount,
  onChange,
  disabled = false,
}: {
  payWithNation: boolean;
  hasNation: boolean;
  stableSymbol: string;
  /** The discount the server applies to $NATION invoices (0 when none). */
  nationDiscount: number;
  onChange: (nation: boolean) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const pct = Math.round(nationDiscount * 100);
  const pill = "flex items-center gap-2 rounded-full px-4 py-1.5 text-[15px] font-semibold";
  const chosen = "bg-panel text-ink shadow-sm ring-1 ring-hairline";
  const stableIcon = <CircleDollarSign aria-hidden size={18} className="text-ink-secondary" />;
  const options = [
    { nation: true, label: "$NATION", icon: <img src={NATION_MARK_SRC} alt="" width={20} height={20} className="size-5 rounded-[5px]" /> },
    { nation: false, label: stableSymbol, icon: stableIcon },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <span id={labelId} className="text-[14px] font-medium text-ink-secondary">Pay with</span>
      {hasNation ? (
        <div role="radiogroup" aria-labelledby={labelId} className="inline-flex rounded-full border border-hairline bg-inset p-1">
          {options.map(({ nation, label, icon }) => {
            const checked = payWithNation === nation;
            return (
              <label
                key={label}
                className={cn(
                  pill,
                  "cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
                  checked ? chosen : "text-ink-secondary hover:text-ink",
                  disabled && "pointer-events-none opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="nation-pay-asset"
                  value={nation ? "NATION" : stableSymbol}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(nation)}
                  className="sr-only"
                />
                {icon}
                {label}
              </label>
            );
          })}
        </div>
      ) : (
        <span className="inline-flex rounded-full border border-hairline bg-inset p-1">
          <span className={cn(pill, chosen)}>{stableIcon}{stableSymbol}</span>
        </span>
      )}
      {hasNation && pct > 0 && (
        <p className="text-[14px] text-ink-secondary">
          <strong className="font-semibold text-ink">$NATION saves about {pct}%.</strong> Same packs, lower price.
        </p>
      )}
    </div>
  );
}

/** Whether the Free column is this account's plan. Owner/admin accounts are exempt and on no
 * plan. A server from before plans existed sends no plan fields: free unless one of its
 * recent payment requests was paid. */
export function freePlanCurrent(
  status: Pick<CreditStatus, "exempt" | "invoices" | "plan" | "onFreePlan">,
): boolean {
  if (status.exempt) return false;
  if (typeof status.onFreePlan === "boolean") return status.onFreePlan;
  if (status.plan) return status.plan === "free";
  return !status.invoices.some((invoice) => invoice.paid_tx);
}

/** The Free column of Full Plans: what every account starts with. It is never sold, so its
 * button only ever states the plan, and it ignores "Pay with". */
export function FreeCard({
  status,
}: {
  status: Pick<CreditStatus, "exempt" | "verified" | "invoices" | "plan" | "onFreePlan" | "starterCreditUsd" | "starterGranted" | "starterMessage">;
}) {
  const current = freePlanCurrent(status);
  const starter = status.starterCreditUsd;
  // Only what is true for this account: an unverified account has not received the credit yet.
  const starterNote = status.exempt || status.starterGranted !== false
    ? null
    : status.verified ? status.starterMessage : "Verify your email or wallet to receive it.";
  const features = [
    starter != null && starter > 0 ? `${formatUsd(starter)} starter credit` : "Starter credit",
    "Your own bots + team chat",
    "Paid credits never expire when you top up",
    "No subscription · pay only when you top up",
  ];
  return (
    <article aria-label="Free plan" className="flex flex-col rounded-2xl border border-hairline bg-panel p-6">
      <div className="flex min-h-[30px] items-start justify-between gap-3">
        <h3 className="text-[22px] font-semibold text-ink">Free</h3>
        {current && (
          <span className="mt-0.5 whitespace-nowrap rounded-full bg-nation px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em]">
            Current plan
          </span>
        )}
      </div>
      <p className="mt-4 flex items-baseline gap-2">
        <span className="text-[44px] font-bold leading-none tracking-tight text-ink">$0</span>
      </p>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">Try Nation Team Chat with starter credit.</p>
      <button
        type="button"
        disabled
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-hairline px-4 py-3 text-[15px] font-semibold text-ink-secondary"
      >
        {current && <Check size={16} aria-hidden="true" className="text-nation-text" />}
        {current ? "Current plan" : status.exempt ? "Owner access" : "Included"}
      </button>
      <ul className="mt-5 space-y-3 text-[14px] leading-snug text-ink">
        {features.map((feature, index) => (
          <li key={feature} className="flex gap-2.5">
            <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-nation-text" />
            <span>
              {feature}
              {index === 0 && starterNote && (
                <span className="mt-0.5 block text-[12.5px] text-ink-secondary">{starterNote}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

const PACK_BLURB: Record<string, string> = {
  starter: "Try your AI team on real work.",
  builder: "For everyday work across your team.",
  swarm: "For heavy, all-day agent work.",
};

/** A pack card. Its prices are what the token chosen under "Pay with" pays; the button starts
 * checkout for this pack in that token. */
export function PackCard({
  tier,
  payWithNation,
  nationPriceUsd,
  nationDiscount,
  stableSymbol,
  busy,
  onSelect,
}: {
  tier: CreditTier;
  payWithNation: boolean;
  nationPriceUsd: number | null;
  /** The discount the server applies to $NATION invoices (0 when none). */
  nationDiscount: number;
  stableSymbol: string;
  busy: boolean;
  onSelect: () => void;
}) {
  const nation = payWithNation && nationPriceUsd != null && nationPriceUsd > 0;
  const pct = nation ? Math.round(nationDiscount * 100) : 0;
  const price = packPriceUsd(tier.usd, pct ? nationDiscount : 0);
  const nationAmount = nation
    ? (price / nationPriceUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })
    : null;
  const cta = nation
    ? `Pay ${formatUsd(price)} worth of $NATION${pct ? ` · Save ${pct}%` : ""}`
    : `Pay ${formatUsd(price)} with ${stableSymbol}`;
  return (
    <article
      className={cn(
        "flex flex-col rounded-2xl border bg-panel p-6",
        tier.popular ? "border-nation-text bg-gradient-to-b from-nation/10 to-panel shadow-lg" : "border-hairline",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[22px] font-semibold text-ink">{tier.name}</h3>
        {tier.popular && (
          <span className="pt-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-nation-text">Most popular</span>
        )}
      </div>
      <p className="mt-4 flex items-baseline gap-2">
        <span className="text-[44px] font-bold leading-none tracking-tight text-ink">{formatUsd(price)}</span>
        <span className="text-[14px] text-ink-secondary">one-time</span>
      </p>
      {pct > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-ink-secondary">
            instead of <s>{formatUsd(tier.usd)} {stableSymbol}</s>
          </p>
          <span className="rounded-full bg-nation/15 px-2.5 py-1 text-[12px] font-semibold text-nation-text">Save {pct}%</span>
        </div>
      )}
      {nationAmount && <p className="mt-1 text-[13px] text-ink-secondary">≈ {nationAmount} $NATION</p>}
      <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">{PACK_BLURB[tier.id] ?? "Permanent prepaid credit."}</p>
      {/* Values sit on one baseline even when a label wraps to two lines. */}
      <dl className="mt-5 grid grid-cols-2 divide-x divide-hairline rounded-xl bg-inset">
        <div className="flex flex-col justify-between px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">Permanent credit</dt>
          <dd className="mt-1 text-[20px] font-semibold text-ink">{formatUsd(tier.creditUsd)}</dd>
        </div>
        <div className="flex flex-col justify-between px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">Expires</dt>
          <dd className="mt-1 text-[20px] font-semibold text-ink">Never</dd>
        </div>
      </dl>
      <button
        type="button"
        disabled={busy}
        onClick={onSelect}
        aria-label={`${tier.name}: ${cta}`}
        className={cn(
          "mt-5 w-full rounded-xl px-4 py-3 text-[15px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-50",
          tier.popular ? "bg-nation" : "bg-ink text-app",
        )}
      >
        {cta}
      </button>
    </article>
  );
}

/** Pending payment requests on Full Plans. */
export function PendingInvoices({
  rows,
  onResume,
  disabled,
}: {
  rows: PendingRow[];
  onResume: (invoice: Invoice) => void;
  disabled: boolean;
}) {
  if (!rows.length) return null;
  const anyLive = rows.some((row) => !row.expired);
  const anyExpired = rows.some((row) => row.expired);
  return (
    <section className="mt-10">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">
        {anyLive ? "Resume a pending payment" : "Recent payment requests"}
      </h2>
      <div className="mt-3 divide-y divide-hairline/60 overflow-hidden rounded-2xl border border-hairline bg-panel">
        {rows.map(({ invoice, symbol, amount, expired }) => expired ? (
          // Inert on purpose: an expired request cannot be resumed.
          <div
            key={invoice.id}
            data-expired=""
            className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-[14px] text-ink-secondary"
          >
            <span className="font-semibold line-through decoration-hairline">
              {amount} {symbol}
            </span>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[12px] font-medium text-ink-secondary">Expired</span>
          </div>
        ) : (
          <button
            key={invoice.id}
            type="button"
            disabled={disabled}
            onClick={() => onResume(invoice)}
            className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-left text-[14px] text-ink hover:bg-raised/50 disabled:opacity-50"
          >
            <span className="font-semibold">
              {amount} {symbol}
            </span>
            <span className="text-[13px] text-ink-secondary">
              {`Expires ${new Date(invoice.expires_at).toLocaleTimeString()}`}
            </span>
          </button>
        ))}
      </div>
      {anyExpired && (
        <p className="mt-2 text-[12.5px] leading-5 text-ink-secondary">
          Expired requests can't be resumed; choose a pack above for a new one. A payment already sent
          for an expired request is still credited once it is found on Robinhood Chain.
        </p>
      )}
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const write = navigator.clipboard?.writeText(value);
        if (!write) return;
        void write.then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => {});
      }}
      className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
    >
      {copied ? "Copied" : `Copy ${label}`}
    </button>
  );
}

/** Exported for unit tests. */
export function CheckoutPanel({
  invoice,
  status,
  busy,
  hash,
  onHash,
  onPay,
  onConfirm,
  onBack,
}: {
  invoice: Invoice;
  status: CreditStatus;
  busy: boolean;
  hash: string;
  onHash: (v: string) => void;
  onPay: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const chain = chainFor(invoice, status.chains);
  const packUsd = invoice.pack_micros / 1_000_000;
  const tierName = status.tiers.find((t) => t.usd === packUsd)?.name ?? formatUsd(packUsd);
  // The whole amount, suffix included, is credited; shown to the cent.
  const credit = formatUsd(Math.floor(invoice.amount_micros / 10_000) / 100);
  const pct = Math.round((invoice.discount_bps ?? 0) / 100);
  const back = (
    <button
      type="button"
      onClick={onBack}
      disabled={busy}
      className="shrink-0 text-[13px] text-ink-secondary hover:text-ink"
    >
      ← Back to packs
    </button>
  );

  if (invoice.paid_tx) {
    return (
      <div className="space-y-5 rounded-2xl border border-hairline bg-panel p-6 text-center">
        <p role="status" className="text-[17px] font-semibold text-success">
          ✓ Payment verified. Your credit is ready.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <a className="rounded-xl bg-ink px-4 py-2 font-semibold text-app" href={BASE_URL}>
            Back to chat
          </a>
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl border border-hairline px-4 py-2 font-semibold text-ink hover:bg-raised"
          >
            Buy another pack
          </button>
        </div>
      </div>
    );
  }

  let amount: string | null = null;
  try {
    if (chain) amount = invoiceAmount(invoice, chain);
  } catch {
    amount = null;
  }
  if (!chain || amount === null) {
    return (
      <div className="space-y-3 rounded-2xl border border-hairline bg-panel p-6">
        <p className="text-[14px] text-ink">
          This payment request is for a network or token that is no longer offered. Choose a
          pack to start a new one.
        </p>
        {back}
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-hairline bg-panel p-5 sm:p-7">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-secondary">{tierName} pack</p>
          <h2 tabIndex={-1} className="mt-1 text-[22px] font-semibold text-ink focus:outline-none">
            Send payment
          </h2>
        </div>
        {back}
      </div>

      <div className="mt-5 rounded-xl bg-inset p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">Send exactly</p>
          <CopyButton value={amount} label="amount" />
        </div>
        <p className="mt-1 break-all font-mono text-[20px] font-bold text-ink">
          {amount} {chain.symbol}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          {pct > 0 && <span className="font-semibold text-nation-text">Save {pct}% with $NATION. </span>}
          You receive {credit} of permanent credit. The unique amount identifies your payment.
        </p>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
            To the NATION treasury on {chain.name}
          </p>
          <CopyButton value={invoice.treasury} label="address" />
        </div>
        <code className="mt-1 block break-all rounded-xl bg-inset p-3 font-mono text-[13px] text-ink">
          {invoice.treasury}
        </code>
      </div>

      <div className="mt-5 flex justify-center">
        <div className="w-fit rounded-xl bg-white p-3">
          <QRCodeSVG
            value={`ethereum:${invoice.token}@${invoice.chain}/transfer?address=${invoice.treasury}&uint256=${invoice.token_amount || invoice.amount_micros}`}
            size={160}
          />
        </div>
      </div>
      <p className="mt-4 text-center text-[12px] text-ink-secondary">
        Pay within 30 minutes. Matching late transfers are still credited.{" "}
        {chain.symbol === "$NATION"
          ? "Switch your wallet to Robinhood Chain."
          : "Your wallet may require a separate ETH network fee."}
      </p>
      {status.exempt && (
        <p className="mt-2 text-center text-[12px] text-ink-secondary">
          Usage is not charged to this account. Test payments still credit the ledger if they complete.
        </p>
      )}
      <NationWalletPay
        invoiceId={invoice.id}
        symbol={chain.symbol}
        token={invoice.token}
        amount={amount}
        disabled={busy || invoice.expires_at <= Date.now() || Boolean(hash)}
        onSent={onHash}
      />
      <button
        className="mt-5 w-full rounded-xl bg-ink py-3 font-semibold text-app transition-opacity disabled:opacity-50"
        disabled={busy || invoice.expires_at <= Date.now() || Boolean(hash)}
        onClick={onPay}
      >
        Pay with a connected wallet
      </button>
      <div className="mt-5">
        <label className="mb-1 block text-[13px] text-ink-secondary">
          Already paid? Paste your transaction hash
        </label>
        <input
          className={field}
          value={hash}
          onChange={(e) => onHash(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
        />
      </div>
      <button
        className="mt-3 w-full rounded-xl border border-hairline py-3 font-semibold text-ink transition-opacity hover:bg-raised disabled:opacity-50"
        disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hash.trim())}
        onClick={onConfirm}
      >
        I've paid — confirm
      </button>
      {hash && (
        <p className="mt-3 text-center text-[12px] text-ink-secondary">
          Waiting for network confirmations. You can check again without sending another payment.
        </p>
      )}
    </section>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────
/** Owns the credit status and the starter sheet for the whole app, so the account
 * menu and Settings see the same status as the strip. Mount inside StoreProvider. */
export function NationCreditsProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [starterOpen, setStarterOpen] = useState(false);
  const isPlansPage = isFullPlansPath(window.location.pathname, BASE_URL);

  const refresh = useCallback(async () => {
    setStatus(await api("/api/credits/status"));
  }, []);

  useEffect(() => {
    if (!state.connected) return;
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), starterOpen || isPlansPage ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [state.connected, starterOpen, isPlansPage, refresh]);

  const openStarter = useCallback(() => setStarterOpen(true), []);
  const closeStarter = useCallback(() => setStarterOpen(false), []);
  const value = useMemo(
    () => ({ status, refresh, starterOpen, openStarter, closeStarter, openSubscription: goToFullPlans }),
    [status, refresh, starterOpen, openStarter, closeStarter],
  );
  return <NationCreditsCtx.Provider value={value}>{children}</NationCreditsCtx.Provider>;
}

// ─── Main component ───────────────────────────────────────────────────────────
/** Top strip + starter-credit sheet in the chat shell, Full Plans on /subscription. */
export function NationCredits() {
  const { status, refresh, starterOpen, openStarter, closeStarter } = useNationCredits();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [hash, setHash] = useState("");

  // Lazily initialize payWithNation from ?asset= URL param.
  const [payWithNation, setPayWithNation] = useState(() => {
    try {
      const asset = new URLSearchParams(window.location.search).get("asset");
      return /^(\$?nation)$/i.test(asset ?? "");
    } catch { return false; }
  });

  // Navigation to and from Full Plans is always a full page load, so this is
  // stable for the life of the component.
  const isPlansPage = isFullPlansPath(window.location.pathname, BASE_URL);

  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const checkoutRef = useRef<HTMLDivElement>(null);
  // Pending deep-link pack: consumed on first status load.
  const deepLinkPackRef = useRef<number | null>(null);

  // Keep the open payment request in step with each status poll (paid_tx arrives this way).
  useEffect(() => {
    if (!status) return;
    setInvoice((cur) =>
      cur ? (status.invoices.find((i) => i.id === cur.id) ?? cur) : null,
    );
  }, [status]);

  // ?pack= deep link: Full Plans starts that pack's checkout once status loads;
  // anywhere else forwards to Full Plans with the same query.
  useEffect(() => {
    try {
      const pack = Number(new URLSearchParams(window.location.search).get("pack"));
      if (!Number.isInteger(pack) || pack <= 0) return;
      if (isPlansPage) deepLinkPackRef.current = pack;
      else window.location.replace(FULL_PLANS_HREF + window.location.search);
    } catch { /* ignore */ }
  }, [isPlansPage]);

  useEffect(() => {
    if (starterOpen) closeRef.current?.focus();
  }, [starterOpen]);

  // Keyboard close + focus trap for the starter sheet
  useEffect(() => {
    if (!starterOpen || isPlansPage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) closeStarter();
      if (e.key === "Tab" && sheetRef.current) {
        const els = [
          ...sheetRef.current.querySelectorAll<HTMLElement>(
            "a[href],button:not(:disabled),input:not(:disabled)",
          ),
        ];
        const first = els[0], last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [starterOpen, busy, isPlansPage, closeStarter]);

  // Escape on Full Plans steps back from checkout to the packs
  useEffect(() => {
    if (!isPlansPage || !invoice) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setInvoice(null);
        setHash("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isPlansPage, invoice, busy]);

  // Checkout replaces the packs in place: bring the steps and the payment into
  // view, and move focus to the payment heading.
  const checkoutId = invoice?.id;
  useEffect(() => {
    if (!isPlansPage || !checkoutId) return;
    checkoutRef.current?.scrollIntoView?.({ block: "start" });
    checkoutRef.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [isPlansPage, checkoutId]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const verify = () =>
    run(async () => {
      const wallet = await injectedWallet();
      const [address] = await wallet.requestAddresses();
      if (!address) throw new Error("Choose a wallet account.");
      const challenge = await api("/api/credits/wallet/challenge", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const signature = await wallet.signMessage({
        account: address,
        message: challenge.message,
      });
      await api("/api/credits/wallet/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
    });

  const createInvoice = (packUsd: number, useNation: boolean) =>
    run(async () => {
      const body = invoiceRequest(status?.chains ?? [], useNation, packUsd);
      if (!body) throw new Error("No payment network available for the selected currency.");
      const inv: Invoice = await api("/api/credits/invoices", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setInvoice(inv);
      setHash("");
    });

  const pay = () =>
    run(async () => {
      if (!invoice || invoice.expires_at <= Date.now())
        throw new Error(
          "Create a new payment request. A matching payment already sent can still be credited.",
        );
      const wallet = await injectedWallet();
      const { defineChain, encodeFunctionData, parseAbi } = await import("viem");
      const transferAbi = parseAbi([
        "function transfer(address to, uint256 amount) returns (bool)",
      ]);
      const chainMeta = status ? chainFor(invoice, status.chains) : undefined;
      if (!chainMeta) throw new Error("This payment request is for a network or token that is no longer offered.");
      const chain = defineChain({
        id: invoice.chain,
        name: chainMeta.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
      });
      try {
        await wallet.switchChain({ id: chain.id });
      } catch (err) {
        const code =
          (err as { code?: number; cause?: { code?: number } }).cause?.code ??
          (err as { code?: number }).code;
        if (code !== 4902) throw err;
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      }
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("Choose a wallet account.");
      const transferAmount = invoice.token_amount
        ? BigInt(invoice.token_amount)
        : BigInt(invoice.amount_micros);
      const tx = await wallet.sendTransaction({
        account,
        chain,
        to: invoice.token as Hex,
        data: encodeFunctionData({
          abi: transferAbi,
          functionName: "transfer",
          args: [invoice.treasury as Hex, transferAmount],
        }),
      });
      setHash(tx);
    });

  const confirm = () =>
    run(async () => {
      if (!invoice) return;
      await api("/api/credits/confirm", {
        method: "POST",
        body: JSON.stringify({ invoiceId: invoice.id, txHash: hash.trim() }),
      });
    });

  // Apply deep-link pack once status arrives.
  useEffect(() => {
    if (!status || deepLinkPackRef.current === null) return;
    const pack = deepLinkPackRef.current;
    deepLinkPackRef.current = null;
    if (!status.verified || !status.topUpEnabled || !status.packs.includes(pack)) return;
    void createInvoice(pack, payWithNation && nationPayable(status));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const hasNation = nationPayable(status);
  const nonNationSymbol =
    status?.chains.find((c) => c.symbol !== "$NATION")?.symbol ?? "USDG";
  const tiers: CreditTier[] = status?.tiers ?? [];
  const discount = nationInvoiceDiscount(status);
  const treasury = status?.chains[0]?.treasury;
  const backToPacks = () => { setInvoice(null); setHash(""); };
  // Back to where the visitor came from inside the app, else to the chat.
  const leavePlans = () => {
    try {
      if (document.referrer && new URL(document.referrer).origin === window.location.origin && window.history.length > 1) {
        window.history.back();
        return;
      }
    } catch { /* fall through */ }
    window.location.assign(BASE_URL);
  };

  return (
    <>
      {/* ── Full Plans (/subscription) ───────────────────────────────────── */}
      {isPlansPage && (
        <div className="fixed inset-0 z-[90] overflow-auto bg-app">
          <main className="mx-auto w-full max-w-7xl px-5 pb-24 pt-6 sm:px-8 sm:pt-8">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={leavePlans}
                className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-4 py-2 text-[14px] font-medium text-ink hover:bg-raised"
              >
                <ChevronLeft aria-hidden size={16} />
                Back to chat
              </button>
              {status && (
                <span className="rounded-full border border-hairline px-3.5 py-1.5 text-[13px] text-ink-secondary">
                  {status.exempt ? "Owner / admin" : `$${status.balanceUsd.toFixed(2)} credit`}
                </span>
              )}
            </div>

            <div className="mt-8">
              <FullPlansHeader status={status} />
            </div>

            <div ref={checkoutRef} className="mt-8 scroll-mt-6">
              {!status ? (
                <div className="flex h-32 items-center justify-center">
                  <span className="text-[13px] text-ink-secondary">Loading plans…</span>
                </div>
              ) : !status.verified ? (
                <div className="max-w-md space-y-4 rounded-2xl border border-hairline bg-panel p-6">
                  <div>
                    <h2 className="text-[20px] font-semibold text-ink">Verify your account</h2>
                    <p className="mt-2 text-[14px] text-ink-secondary">{status.starterMessage}</p>
                  </div>
                  <p className="text-[13px] text-ink-secondary">
                    Sign in with your verified email, or verify a wallet with a free signature. No payment is needed to start.
                  </p>
                  <button className={btn} disabled={busy} onClick={() => void verify()}>
                    Verify wallet for starter credit
                  </button>
                </div>
              ) : !status.topUpEnabled ? (
                <p className="text-[15px] text-ink-secondary">Top up coming soon</p>
              ) : invoice ? (
                <div className="mx-auto max-w-xl">
                  <CheckoutPanel
                    invoice={invoice}
                    status={status}
                    busy={busy}
                    hash={hash}
                    onHash={setHash}
                    onPay={() => void pay()}
                    onConfirm={() => void confirm()}
                    onBack={backToPacks}
                  />
                </div>
              ) : (
                <>
                  <PayWith
                    payWithNation={payWithNation && hasNation}
                    hasNation={hasNation}
                    stableSymbol={nonNationSymbol}
                    nationDiscount={discount}
                    onChange={setPayWithNation}
                    disabled={busy}
                  />
                  {status.exempt && (
                    <p className="mt-3 text-[13px] text-ink-secondary">
                      Owner / admin: usage is not charged to this account. Test payments still credit the ledger.
                    </p>
                  )}
                  <hr className="my-8 border-hairline/70" />
                  <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                    <FreeCard status={status} />
                    {tiers.map((tier) => (
                      <PackCard
                        key={tier.id}
                        tier={tier}
                        payWithNation={payWithNation && hasNation}
                        nationPriceUsd={status.nationPriceUsd}
                        nationDiscount={discount}
                        stableSymbol={nonNationSymbol}
                        busy={busy}
                        onSelect={() => void createInvoice(tier.usd, payWithNation && hasNation)}
                      />
                    ))}
                  </div>

                  <PendingInvoices
                    rows={pendingInvoiceRows(status.invoices, status.chains)}
                    onResume={(i) => { if (i.expires_at > Date.now()) { setInvoice(i); setHash(""); } }}
                    disabled={busy}
                  />

                  <footer className="mt-12 border-t border-hairline/70 pt-6 text-[14px] leading-relaxed text-ink-secondary">
                    <strong className="font-semibold text-ink">Every pack is the same permanent credit.</strong>{" "}
                    It never expires and is only spent when your teammates work. Payments settle on Robinhood
                    Chain to the NATION treasury
                    {treasury && (
                      <>
                        {" "}
                        <code title={treasury} className="font-mono text-[13px] text-ink">{shortAddress(treasury)}</code>
                      </>
                    )}
                    .
                  </footer>
                </>
              )}

              {/* Errors shown in page */}
              {error && (
                <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-2 text-[13px] text-danger">
                  {error}
                </p>
              )}
              {busy && (
                <p role="status" className="mt-4 text-[13px] text-ink-secondary">
                  Please wait…
                </p>
              )}
            </div>
          </main>
        </div>
      )}

      {/* ── Top low-balance / unverified strip (not on Full Plans) ───────── */}
      {status && !isPlansPage && (
        <NationCreditsStrip status={status} onStarter={openStarter} />
      )}

      {/* ── Starter-credit sheet (not on Full Plans) ─────────────────────── */}
      {starterOpen && !isPlansPage && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) closeStarter();
          }}
        >
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="nation-starter-title"
            className="w-full max-w-xl rounded-t-3xl bg-panel text-ink shadow-2xl"
            style={{ maxHeight: "92dvh", overflowY: "auto" }}
          >
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-hairline/60" />
            </div>

            <div className="px-5 pb-8 pt-2">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 id="nation-starter-title" className="text-xl font-semibold">
                  Get free starter credit
                </h2>
                <button
                  ref={closeRef}
                  onClick={closeStarter}
                  disabled={busy}
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-full hover:bg-raised text-ink-secondary hover:text-ink"
                >
                  ✕
                </button>
              </div>

              {!status ? null : !status.verified ? (
                <div className="space-y-4">
                  <p className="text-[14px] text-ink-secondary">{status.starterMessage}</p>
                  <p className="text-[13px] text-ink-secondary">
                    Sign in with your verified email, or verify a wallet with a free signature.
                    No payment is needed to start.
                  </p>
                  <button
                    className={cn(btn, "w-full")}
                    disabled={busy}
                    onClick={() => void verify()}
                  >
                    Verify wallet for starter credit
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-[14px] font-medium text-ink">Your account is verified.</p>
                  <p className="text-[14px] text-ink-secondary">{status.starterMessage}</p>
                  {status.topUpEnabled && (
                    <a className={cn(btn, "block w-full text-center")} href={FULL_PLANS_HREF}>
                      See Full Plans
                    </a>
                  )}
                </div>
              )}

              {busy && (
                <p role="status" className="mt-4 text-center text-[13px] text-ink-secondary">
                  Please wait…
                </p>
              )}
              {error && (
                <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-2 text-[13px] text-danger">
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Settings row (exported for UsageSection) ─────────────────────────────────
/** "Free plan · $2.97 credit left." — what the account has, before what it can buy. */
export function billingSummary(status: Pick<CreditStatus, "exempt" | "onFreePlan" | "balanceUsd">): string {
  if (status.exempt) return "Owner / admin access: your usage is not charged.";
  return `${status.onFreePlan ? "Free plan" : "Paid credit"} · $${status.balanceUsd.toFixed(2)} credit left.`;
}

/** Settings → Usage row. "Top up" is a link to Full Plans. */
export function NationCreditsSettingsRow() {
  const { status } = useNationCredits();
  if (!status) return null;
  return (
    <SettingRow
      title="Billing & Credits"
      subtitle={`${billingSummary(status)} ${
        status.topUpEnabled
          ? "Top up any time on Full Plans; credit never expires."
          : status.topUpMessage || "Top up coming soon"
      }`}
    >
      {status.topUpEnabled ? (
        <a className="ui-button hover:bg-raised-hover" href={FULL_PLANS_HREF}>
          Top up
        </a>
      ) : (
        <span className="text-[13px] text-ink-secondary">
          {status.topUpMessage || "Coming soon"}
        </span>
      )}
    </SettingRow>
  );
}
