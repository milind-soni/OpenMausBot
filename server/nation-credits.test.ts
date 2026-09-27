import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeEventTopics, encodeAbiParameters, pad, parseAbiItem, toHex, type Hex } from "viem";
import { CreditLedger, creditSettings, creditChains, invoiceChain, invoiceTokenAmount, mailboxOf, micros, type CreditAccount, type CreditChain, type CreditInvoice } from "./nation-credits.ts";
import { LATE_PAYMENT_WINDOW_MS, SCAN_CHUNK_BLOCKS, confirmCreditPayment, creditScanIntervalMs, scanCreditPayments, scanErrorText, verifyCreditPayment, type PaymentRpc } from "./nation-payments.ts";
import { creditPlan, liveInvoices } from "./routes/nation-credits.ts";

const ledgers: CreditLedger[] = [], roots: string[] = [];
afterEach(() => { ledgers.splice(0).forEach(ledger => ledger.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const account = (id = "verified-1"): CreditAccount => ({ id, verified: true, email: `${id}@example.test` });
const ledger = (env: NodeJS.ProcessEnv = {}) => { const value = new CreditLedger(":memory:", creditSettings(env), env); ledgers.push(value); return value; };
const treasury = "0x1111111111111111111111111111111111111111";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const nationToken = "0xc839a88a05b231515a82c71ee97b4f18973c1340";
const tx = (digit = "a") => ("0x" + digit.repeat(64)) as Hex;
const usdcChain: CreditChain = { id: 8453, name: "Base", symbol: "USDC", treasury, token, rpc: "http://127.0.0.1", decimals: 6 };
const nationChain: CreditChain = { id: 4663, name: "Robinhood Chain", symbol: "$NATION", treasury, token: nationToken, rpc: "http://127.0.0.1", decimals: 18 };
const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const invoice = (value: CreditLedger, id = "verified-1") => value.createInvoice(account(id), usdcChain, 15, 10n, 1_000_000);
function rpc(inv: CreditInvoice, overrides: Partial<PaymentRpc> = {}): PaymentRpc {
  return {
    getChainId: async () => 8453, getBlockNumber: async () => 12n,
    getBlock: async () => ({ hash: tx("b"), timestamp: 1001n }),
    getTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash, blockNumber: 10n, blockHash: tx("b"), logs: [{ address: token,
      topics: encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: "0x2222222222222222222222222222222222222222", to: treasury } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [BigInt(inv.token_amount || inv.amount_micros)]),
    }] }), ...overrides,
  };
}
describe("credit ledger", () => {
  it("validates new defaults (15,49,99) and returns structured tiers; missing treasuries hide top up", () => {
    const settings = creditSettings({});
    expect(settings).toMatchObject({ freeUsd: 3, markup: 1, lowUsd: .5, packs: [15,49,99], grantsPerIp: 2, confirmations: 3 });
    expect(settings.tiers).toHaveLength(3);
    expect(settings.tiers[0]).toMatchObject({ id: "starter", name: "Starter", usd: 15, popular: false });
    expect(settings.tiers[1]).toMatchObject({ id: "builder", name: "Builder", usd: 49, popular: true });
    expect(settings.tiers[2]).toMatchObject({ id: "swarm",   name: "Swarm",   usd: 99, popular: false });
    for (const free of ["1", "6", "NaN", ""]) expect(() => creditSettings({ NATION_FREE_CREDIT_USD: free })).toThrow();
    expect(creditChains({})).toEqual([]);
    // Base (8453) is removed from the top-up path; NATION_TREASURY_BASE is ignored.
    expect(creditChains({ NATION_TREASURY_BASE: "invalid" })).toEqual([]);
    expect(creditChains({ NATION_TREASURY_BASE: treasury })).toEqual([]);
    expect(creditChains({ NATION_TREASURY_ROBINHOOD: treasury })[0]).toMatchObject({ id: 4663, symbol: "USDG" });
  });

  it("includes $NATION chain when NATION_TOKEN_USD_PRICE is set alongside a treasury", () => {
    const chains = creditChains({ NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.50" });
    const nationEntry = chains.find(c => c.symbol === "$NATION");
    expect(nationEntry).toBeDefined();
    expect(nationEntry).toMatchObject({ id: 4663, decimals: 18, token: nationToken.toLowerCase() });
    // USDG is still present
    expect(chains.find(c => c.symbol === "USDG")).toBeDefined();
    // Without the price env, no NATION chain
    const noNation = creditChains({ NATION_TREASURY_ROBINHOOD: treasury });
    expect(noNation.find(c => c.symbol === "$NATION")).toBeUndefined();
  });

  it("resolves an invoice's token on the shared Robinhood chain id; token-less requests get USDG", () => {
    const chains = creditChains({ NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.000286" });
    // $NATION is listed first, so a lookup by chain id alone would bill a USDG buyer in $NATION.
    expect(chains.map(c => c.symbol)).toEqual(["$NATION", "USDG"]);
    expect(invoiceChain(chains, 4663)).toMatchObject({ symbol: "USDG", decimals: 6 });
    expect(invoiceChain(chains, 4663, "0xc839A88A05B231515a82c71EE97b4F18973C1340")).toMatchObject({ symbol: "$NATION", decimals: 18 });
    expect(invoiceChain(chains, 4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")).toMatchObject({ symbol: "USDG" });
    // A token that is not offered on that chain, or a dropped chain, never falls back to another entry.
    expect(invoiceChain(chains, 4663, token)).toBeUndefined();
    expect(invoiceChain(chains, 8453)).toBeUndefined();
    expect(invoiceChain(creditChains({ NATION_TREASURY_ROBINHOOD: treasury }), 4663, nationToken)).toBeUndefined();
  });

  it("computes token_amount correctly for USDC (6 dec) and $NATION (18 dec)", () => {
    const amountMicros = 15_500_000;
    // USDC: token_amount == amount_micros
    expect(invoiceTokenAmount(amountMicros, usdcChain, {})).toBe(String(amountMicros));
    // NATION @ $0.50: 15.5 / 0.50 = 31 NATION = 31e18 units
    const nationAmt = invoiceTokenAmount(amountMicros, nationChain, { NATION_TOKEN_USD_PRICE: "0.50" });
    expect(BigInt(nationAmt)).toBe(31_000_000_000_000_000_000n);
    // Missing price throws
    expect(() => invoiceTokenAmount(amountMicros, nationChain, {})).toThrow("NATION_TOKEN_USD_PRICE");
  });

  it("defaults the $NATION discount to 20%, allows 0 to turn it off, and rejects nonsense", () => {
    expect(creditSettings({}).nationDiscount).toBe(0.2);
    expect(creditSettings({ NATION_TOKEN_DISCOUNT: "" }).nationDiscount).toBe(0.2);
    expect(creditSettings({ NATION_TOKEN_DISCOUNT: "0" }).nationDiscount).toBe(0);
    expect(creditSettings({ NATION_TOKEN_DISCOUNT: "0.25" }).nationDiscount).toBe(0.25);
    for (const bad of ["1", "-0.1", "abc"]) expect(() => creditSettings({ NATION_TOKEN_DISCOUNT: bad })).toThrow("NATION_TOKEN_DISCOUNT");
  });

  it("prices $NATION at the discount and keeps the price's own precision", () => {
    // $15.50 at $0.50 with 20% off: the buyer sends 24.8 $NATION.
    expect(BigInt(invoiceTokenAmount(15_500_000, nationChain, { NATION_TOKEN_USD_PRICE: "0.50" }, 2000))).toBe(24_800_000_000_000_000_000n);
    // $1 at $0.00028637 is 1e30 / 286_370_000 units; rounding the price to whole micro-dollars ($0.000286) would ask 0.13% more.
    expect(BigInt(invoiceTokenAmount(1_000_000, nationChain, { NATION_TOKEN_USD_PRICE: "0.00028637" }))).toBe(10n ** 30n / 286_370_000n);
    expect(() => invoiceTokenAmount(1_000_000, nationChain, { NATION_TOKEN_USD_PRICE: "0.0000000000001" })).toThrow("NATION_TOKEN_USD_PRICE");
    expect(() => invoiceTokenAmount(1_000_000, nationChain, { NATION_TOKEN_USD_PRICE: "0.5" }, 10_000)).toThrow("discount");
  });

  it("bills $NATION invoices 20% under the pack price, bills USDG in full, and credits both in full", () => {
    const env = { NATION_TOKEN_USD_PRICE: "0.000286" };
    const db = ledger(env);
    db.account(account());
    const nation = db.createInvoice(account(), nationChain, 49, 1n);
    expect(nation.discount_bps).toBe(2000);
    const undiscounted = BigInt(invoiceTokenAmount(nation.amount_micros, nationChain, env));
    expect(Number(BigInt(nation.token_amount) * 1_000_000n / undiscounted) / 1_000_000).toBeCloseTo(0.8, 5);
    expect(nation.amount_micros).toBeGreaterThanOrEqual(49_000_000); // the credit stays the full pack
    const usdg = db.createInvoice(account(), { ...nationChain, symbol: "USDG", token, decimals: 6 }, 49, 1n);
    expect(usdg.discount_bps).toBe(0);
    expect(usdg.token_amount).toBe(String(usdg.amount_micros));
    // Turning the discount off bills $NATION at the full price.
    const full = ledger({ ...env, NATION_TOKEN_DISCOUNT: "0" });
    full.account(account("full"));
    const fullInvoice = full.createInvoice(account("full"), nationChain, 49, 1n);
    expect(fullInvoice.discount_bps).toBe(0);
    expect(fullInvoice.token_amount).toBe(invoiceTokenAmount(fullInvoice.amount_micros, nationChain, env));
  });

  it("stores token_amount on NATION invoices and '' for USDC invoices", () => {
    const db = ledger({ NATION_PACKS_USD: "15,49,99", NATION_TOKEN_USD_PRICE: "0.50" });
    db.account(account());
    // USDC invoice
    const usdcInv = db.createInvoice(account(), usdcChain, 15, 1n);
    expect(usdcInv.token_amount).toBe(String(usdcInv.amount_micros));
    // NATION invoice
    const nationInv = db.createInvoice(account(), nationChain, 15, 1n);
    expect(nationInv.token_amount).not.toBe("");
    expect(BigInt(nationInv.token_amount)).toBeGreaterThan(0n);
  });

  it("grants once per verified account and requires real account verification", () => {
    const db = ledger();
    expect(db.grant({ id: "unverified", verified: false }, "ip", "device").granted).toBe(false);
    expect(db.grant(account(), "ip", "device").granted).toBe(true);
    expect(db.grant(account(), "other-ip", "other-device").granted).toBe(false);
    expect(db.balance(account().id)).toBe(micros(3));
    expect(db.admin().ledger).toHaveLength(1);
  });
  it("enforces IP/day and lifetime device limits and rejects disposable email domains", () => {
    const db = ledger(), now = Date.UTC(2026, 8, 24);
    expect(db.grant(account("a"), "same-ip", "a", now).granted).toBe(true);
    expect(db.grant(account("b"), "same-ip", "b", now).granted).toBe(true);
    expect(db.grant(account("c"), "same-ip", "c", now).granted).toBe(false);
    expect(db.grant(account("d"), "other-ip", "a", now).granted).toBe(false);
    expect(db.grant(account("c"), "same-ip", "c", now + 86_400_000).granted).toBe(true);
    expect(db.grant({ ...account("temp"), email: "new@sub.mailinator.com" }, "fresh-ip", "fresh-device", now).granted).toBe(false);
  });
  it("gives one starter credit per inbox, whatever +tag or Gmail dots the address adds", () => {
    const db = ledger(), now = Date.UTC(2026, 8, 27);
    const as = (id: string, email: string): CreditAccount => ({ id, verified: true, email });
    expect(db.grant(as("a", "jane.doe@gmail.com"), "ip-a", "device-a", now).granted).toBe(true);
    for (const [id, email] of [["b", "janedoe+ads@gmail.com"], ["c", "j.a.n.e.d.o.e@googlemail.com"]]) {
      expect(db.grant(as(id, email), `ip-${id}`, `device-${id}`, now)).toEqual({ granted: false, reason: "This email address already received starter credit." });
    }
    // Outside Gmail a dot is part of the name; a +tag still is not.
    expect(db.grant(as("d", "jane.doe@example.test"), "ip-d", "device-d", now).granted).toBe(true);
    expect(db.grant(as("e", "janedoe@example.test"), "ip-e", "device-e", now).granted).toBe(true);
    expect(db.grant(as("f", "jane.doe+x@example.test"), "ip-f", "device-f", now).granted).toBe(false);
    expect(mailboxOf("+only@example.test")).toBe("+only@example.test");
  });
  it("stops starter credit at the daily total, whatever networks and devices ask", () => {
    const db = ledger({ NATION_FREE_GRANTS_PER_DAY: "2" }), now = Date.UTC(2026, 8, 27);
    expect(db.grant(account("a"), "ip-a", "a", now).granted).toBe(true);
    expect(db.grant(account("b"), "ip-b", "b", now).granted).toBe(true);
    expect(db.grant(account("c"), "ip-c", "c", now)).toEqual({ granted: false, reason: "Today's starter credit has all been given out. Try again tomorrow." });
    expect(db.grant(account("c"), "ip-c", "c", now + 86_400_000).granted).toBe(true);
    expect(creditSettings({}).grantsPerDay).toBe(1000);
    for (const bad of ["0", "1.5", "abc"]) expect(() => creditSettings({ NATION_FREE_GRANTS_PER_DAY: bad })).toThrow();
  });
  it("debits actual cost times markup once, blocks zero, and retains in-flight overruns", () => {
    const db = ledger({ NATION_CREDIT_MARKUP: "1.25" }); db.grant(account(), "ip", "device");
    const call = db.beginCall(account()); db.settle(call, .48); db.settle(call, .48);
    expect(db.balance(account().id)).toBe(micros(2.4));
    db.settle(db.beginCall(account()), 2);
    expect(db.balance(account().id)).toBe(micros(-.1));
    expect(() => db.beginCall(account())).toThrow("top up");
    expect(db.admin().ledger.filter(row => row.type === "usage")).toHaveLength(2);
  });
  it("records actual operator cost without charging privileged accounts", () => {
    const db = ledger(); const owner = { id: "owner", verified: true, exempt: true };
    db.settle(db.beginCall(owner), 5);
    expect(db.balance("owner")).toBe(0);
    expect(db.admin().ledger[0]).toMatchObject({ amount_micros: 0, cost_micros: micros(5) });
  });
  it("keeps unknown costs pending and unblocks only after actual-cost settlement", () => {
    const db = ledger(); db.grant(account(), "ip", "device");
    const call = db.beginCall(account()); db.markUnconfirmed(call);
    expect(() => db.beginCall(account())).toThrow("cost confirmation");
    db.settle(call, .1);
    expect(() => db.assertAvailable(account())).not.toThrow();
  });
  it("persists credit indefinitely across database reopen and late invoice settlement", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const file = join(root, "credits.db"), first = new CreditLedger(file, creditSettings({}));
    first.grant(account(), "ip", "device", 0); const inv = invoice(first);
    first.paid(inv, tx(), inv.amount_micros, inv.expires_at + 365 * 86_400_000);
    const balance = first.balance(account().id); first.close();
    const second = new CreditLedger(file, creditSettings({})); ledgers.push(second);
    expect(second.balance(account().id)).toBe(balance);
    expect(second.invoice(inv.id)?.paid_tx).toBe(tx());
  });
  it("blocks abandoned calls after restart until the actual cost is reconciled", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const file = join(root, "credits.db"), first = new CreditLedger(file, creditSettings({}));
    first.grant(account(), "ip", "device"); const call = first.beginCall(account()); first.close();
    const second = new CreditLedger(file, creditSettings({})); ledgers.push(second);
    expect(() => second.beginCall(account())).toThrow("cost confirmation");
    second.settle(call, .2);
    expect(second.balance(account().id)).toBe(micros(2.8));
    expect(() => second.assertAvailable(account())).not.toThrow();
  });
  it("serializes unique grants across independent database handles", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const file = join(root, "credits.db"), first = new CreditLedger(file, creditSettings({})), second = new CreditLedger(file, creditSettings({})); ledgers.push(first, second);
    expect(first.grant(account(), "ip", "device").granted).toBe(true);
    expect(second.grant(account(), "other", "other").granted).toBe(false);
    expect(second.balance(account().id)).toBe(micros(3));
  });
  it("requires reasons for manual adjustments and prevents negative manual balances", () => {
    const db = ledger(); db.account(account());
    expect(() => db.adjust(account().id, 10, "", "owner")).toThrow();
    db.adjust(account().id, 10, "Support refund", "owner");
    db.adjust(account().id, -2, "Correct duplicate support refund", "owner");
    expect(db.balance(account().id)).toBe(micros(8));
    expect(() => db.adjust(account().id, -9, "Cannot overdraw", "owner")).toThrow();
  });
  it("migrates existing database without token_amount column", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const { DatabaseSync } = require("node:sqlite");
    const file = join(root, "legacy.db");
    // Build a legacy schema (no token_amount column)
    const legacyDb = new DatabaseSync(file);
    legacyDb.exec(`
      CREATE TABLE credit_accounts(id TEXT PRIMARY KEY, verified INTEGER NOT NULL, exempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE credit_invoices(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chain INTEGER NOT NULL, treasury TEXT NOT NULL, token TEXT NOT NULL, pack_micros INTEGER NOT NULL, amount_micros INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_tx TEXT UNIQUE, from_block TEXT NOT NULL, UNIQUE(chain,amount_micros));
      CREATE TABLE credit_ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('free','purchase','usage','refund')), amount_micros INTEGER NOT NULL, cost_micros INTEGER NOT NULL DEFAULT 0, tx_hash TEXT UNIQUE, chain INTEGER, reference TEXT UNIQUE, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE credit_grants(user_id TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, device_hash TEXT NOT NULL UNIQUE, day TEXT NOT NULL);
      CREATE TABLE credit_wallets(session_id TEXT PRIMARY KEY, address TEXT NOT NULL);
      CREATE TABLE credit_challenges(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE credit_calls(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE credit_sponsors(thread_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE credit_cursors(chain INTEGER PRIMARY KEY, block TEXT NOT NULL);
    `);
    legacyDb.close();
    // Opening with new CreditLedger should not throw (migration adds token_amount and discount_bps)
    const migrated = new CreditLedger(file, creditSettings({}), { NATION_TOKEN_USD_PRICE: "0.000286" }); ledgers.push(migrated);
    migrated.account(account());
    const inv = migrated.createInvoice(account(), usdcChain, 15, 1n);
    expect(inv.token_amount).toBeDefined();
    expect(inv.discount_bps).toBe(0);
    expect(migrated.createInvoice(account(), nationChain, 15, 1n).discount_bps).toBe(2000);
  });
});
describe("server-side transfer verification", () => {
  it("credits a valid exact transfer only once, with no invoice time expiry loss", async () => {
    const db = ledger(), inv = invoice(db);
    await confirmCreditPayment(db, inv, tx(), rpc(inv));
    expect(db.balance(inv.user_id)).toBe(inv.amount_micros);
    await expect(confirmCreditPayment(db, inv, tx(), rpc(inv))).rejects.toThrow("already");
    const other = invoice(db, "second");
    expect(() => db.paid(other, tx(), other.amount_micros)).toThrow("already");
  });
  it("rejects wrong networks, failed receipts, pending confirmations and reorgs", async () => {
    const inv = invoice(ledger());
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getChainId: async () => 4663 }), 3)).rejects.toThrow("network");
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getBlockNumber: async () => 11n }), 3)).rejects.toThrow("confirming");
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getBlock: async () => ({ hash: tx("c"), timestamp: 1001n }) }), 3)).rejects.toThrow("confirming");
    const base = rpc(inv);
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getTransactionReceipt: async args => ({ ...await base.getTransactionReceipt(args), status: "reverted" }) }), 3)).rejects.toThrow("successful");
  });
  it.each(["wrong-token", "wrong-treasury", "too-small", "wrong-suffix"])("rejects %s", async kind => {
    const inv = invoice(ledger()), base = rpc(inv);
    const bad = rpc(inv, { getTransactionReceipt: async args => {
      const receipt = await base.getTransactionReceipt(args); const log = { ...receipt.logs[0]! };
      if (kind === "wrong-token") log.address = treasury;
      if (kind === "wrong-treasury") log.topics = encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: treasury, to: token as Hex } }) as Hex[];
      if (kind === "too-small" || kind === "wrong-suffix") log.data = encodeAbiParameters([{ type: "uint256" }], [BigInt(kind === "too-small" ? inv.pack_micros - 1 : inv.amount_micros + 1)]);
      return { ...receipt, logs: [log] };
    } });
    await expect(verifyCreditPayment(inv, tx(), bad, 3)).rejects.toThrow("does not match");
  });
});
describe("discounted $NATION payments", () => {
  const nationReceipt = (inv: CreditInvoice, value: bigint): PaymentRpc => rpc(inv, {
    getChainId: async () => 4663,
    getTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash, blockNumber: 10n, blockHash: tx("b"), logs: [{ address: nationToken,
      topics: encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: "0x2222222222222222222222222222222222222222", to: treasury } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
    }] }),
  });

  it("a pasted hash for the discounted amount credits the full pack; the undiscounted amount is refused", async () => {
    const env = { NATION_TOKEN_USD_PRICE: "0.000286" };
    const db = ledger(env);
    db.account(account());
    const inv = db.createInvoice(account(), nationChain, 49, 10n, 1_000_000);
    const undiscounted = BigInt(invoiceTokenAmount(inv.amount_micros, nationChain, env));
    await expect(verifyCreditPayment(inv, tx("d"), nationReceipt(inv, undiscounted), 3)).rejects.toThrow("exact amount");
    await confirmCreditPayment(db, inv, tx("e"), nationReceipt(inv, BigInt(inv.token_amount)));
    expect(db.balance(inv.user_id)).toBe(inv.amount_micros);
    expect(db.invoice(inv.id)?.paid_tx).toBe(tx("e"));
  });
});

describe("credit plan", () => {
  it("is free until a pack is paid, with the starter credit the ledger actually granted", () => {
    const db = ledger({ NATION_FREE_CREDIT_USD: "4" });
    const member = account("plan-member");
    // before verification: the configured amount it would receive
    expect(creditPlan(db.db, member.id, db.settings.freeUsd)).toEqual({ plan: "free", starterCreditUsd: 4, starterGranted: false });
    expect(db.grant(member, "203.0.113.4", "device-plan").granted).toBe(true);
    expect(creditPlan(db.db, member.id, 3)).toEqual({ plan: "free", starterCreditUsd: 4, starterGranted: true });
    // an owner adjustment is not a purchase
    db.adjust(member.id, 10, "goodwill", "owner");
    expect(creditPlan(db.db, member.id, 3).plan).toBe("free");
    const inv = db.createInvoice(member, usdcChain, 15, 10n, 1_000_000);
    db.paid(inv, tx("c"), inv.amount_micros);
    expect(creditPlan(db.db, member.id, 3)).toEqual({ plan: "paid", starterCreditUsd: 4, starterGranted: true });
  });
});

describe("credit status invoices", () => {
  it("lists only rows on a chain id and token this server still bills", () => {
    const chains = creditChains({ NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.000286" });
    const rows = [
      { id: "base", chain: 8453, token },
      { id: "usdg", chain: 4663, token: chains[1]!.token.toUpperCase().replace("0X", "0x") },
      { id: "nation", chain: 4663, token: nationToken },
      { id: "dropped-token", chain: 4663, token },
    ];
    expect(liveInvoices(chains, rows).map(row => row.id)).toEqual(["usdg", "nation"]);
    expect(liveInvoices([], rows)).toEqual([]);
  });
});

describe("payment watcher", () => {
  /** A loopback JSON-RPC stand-in for Robinhood Chain: real viem requests, fixture transfers only. */
  async function fakeChain(transfers: Array<{ token: string; to: string; value: bigint; hash: Hex; block: bigint }>, head: bigint, timestamp: bigint,
    fixture: { chainId?: number; failLogsFor?: string } = {}) {
    const topic = (address: string) => pad(address as Hex, { size: 32 }).toLowerCase();
    const blockHash = (n: bigint) => pad(toHex(n), { size: 32 });
    const toLog = (t: (typeof transfers)[number]) => ({
      address: t.token, topics: [...encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: "0x2222222222222222222222222222222222222222", to: t.to as Hex } })],
      data: encodeAbiParameters([{ type: "uint256" }], [t.value]), blockNumber: toHex(t.block), blockHash: blockHash(t.block),
      transactionHash: t.hash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
    });
    const methods: string[] = [];
    const ranges: Array<{ token: string; from: bigint; to: bigint }> = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const call = JSON.parse(raw) as { id: number; method: string; params: any[] };
      methods.push(call.method);
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      if (call.method === "eth_chainId") return reply(toHex(fixture.chainId ?? 4663));
      if (call.method === "eth_blockNumber") return reply(toHex(head));
      if (call.method === "eth_getLogs") {
        const filter = call.params[0], from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        ranges.push({ token: String(filter.address).toLowerCase(), from, to });
        if (fixture.failLogsFor && String(filter.address).toLowerCase() === fixture.failLogsFor) {
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32005, message: "fixture: log query rejected" } }));
        }
        return reply(transfers.filter(t => t.token === String(filter.address).toLowerCase() && topic(t.to) === String(filter.topics?.[2]).toLowerCase()
          && t.block >= from && t.block <= to).map(toLog));
      }
      if (call.method === "eth_getTransactionReceipt") {
        const t = transfers.find(t => t.hash === call.params[0]);
        return reply(t ? { transactionHash: t.hash, blockNumber: toHex(t.block), blockHash: blockHash(t.block), status: "0x1", logs: [toLog(t)],
          transactionIndex: "0x0", from: "0x2222222222222222222222222222222222222222", to: t.token, cumulativeGasUsed: "0x0", gasUsed: "0x0",
          effectiveGasPrice: "0x0", contractAddress: null, type: "0x2", logsBloom: "0x" + "0".repeat(512) } : null);
      }
      if (call.method === "eth_getBlockByNumber") {
        const n = BigInt(call.params[0]);
        return reply({ number: toHex(n), hash: blockHash(n), parentHash: blockHash(n - 1n), timestamp: toHex(timestamp), transactions: [],
          gasLimit: "0x0", gasUsed: "0x0", miner: "0x0000000000000000000000000000000000000000", difficulty: "0x0", extraData: "0x", size: "0x0" });
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "fixture: unsupported" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, methods, ranges };
  }
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });

  it("finds a USDG payment even though $NATION is listed first on the same chain id", async () => {
    const now = Date.now();
    const transfers: Parameters<typeof fakeChain>[0] = [];
    const chainRpc = await fakeChain(transfers, 20n, BigInt(Math.floor(now / 1000)) + 5n);
    const env = { NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.000286", NATION_RPC_ROBINHOOD: chainRpc.url };
    const chains = creditChains(env);
    expect(chains.map(c => c.symbol)).toEqual(["$NATION", "USDG"]);
    const db = ledger(env);
    db.account(account());
    const usdg = db.createInvoice(account(), chains[1]!, 15, 10n, now);
    const nation = db.createInvoice(account(), chains[0]!, 15, 10n, now);
    transfers.push({ token: chains[1]!.token, to: treasury, value: BigInt(usdg.token_amount), hash: tx("f"), block: 12n });

    await scanCreditPayments(db, chains);

    expect(db.invoice(usdg.id)?.paid_tx).toBe(tx("f"));
    expect(db.balance(account().id)).toBe(usdg.amount_micros);
    expect(db.invoice(nation.id)?.paid_tx).toBeNull();
    // One cursor per token, each at the last confirmed block (head 20, 3 confirmations).
    expect(db.db.prepare("SELECT token, block FROM credit_scan_cursors ORDER BY token").all())
      .toEqual([{ token: chains[1]!.token, block: "18" }, { token: chains[0]!.token, block: "18" }].sort((a, b) => a.token.localeCompare(b.token)));
    expect(chainRpc.methods).toContain("eth_getTransactionReceipt");
  });

  it("a $NATION transfer for the discounted amount is found and credited in full", async () => {
    const now = Date.now();
    const transfers: Parameters<typeof fakeChain>[0] = [];
    const chainRpc = await fakeChain(transfers, 20n, BigInt(Math.floor(now / 1000)) + 5n);
    const env = { NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.000286", NATION_RPC_ROBINHOOD: chainRpc.url };
    const chains = creditChains(env);
    const db = ledger(env);
    db.account(account());
    const nation = db.createInvoice(account(), chains[0]!, 49, 10n, now);
    transfers.push({ token: chains[0]!.token, to: treasury, value: BigInt(nation.token_amount), hash: tx("9"), block: 11n });

    await scanCreditPayments(db, chains);

    expect(db.invoice(nation.id)?.paid_tx).toBe(tx("9"));
    expect(db.balance(account().id)).toBe(nation.amount_micros);
  });

  /** Both Robinhood tokens against one fake chain, with a USDG and a $NATION request open. */
  async function twoTokens(head: bigint, fixture: Parameters<typeof fakeChain>[3] = {}, now = Date.now()) {
    const transfers: Parameters<typeof fakeChain>[0] = [];
    const chainRpc = await fakeChain(transfers, head, BigInt(Math.floor(now / 1000)) + 5n, fixture);
    const env = { NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.000286", NATION_RPC_ROBINHOOD: `${chainRpc.url}/v2/sk_live_fixturesecret` };
    const chains = creditChains(env);
    const db = ledger(env);
    db.account(account());
    const lines: string[] = [];
    return { transfers, chainRpc, chains, db, lines, log: (line: string) => lines.push(line), now };
  }

  it("an RPC failure on one token is logged with its chain and token, and the other token is still scanned", async () => {
    const fixture: { failLogsFor?: string } = { failLogsFor: nationToken };
    const t = await twoTokens(20n, fixture);
    const nation = t.db.createInvoice(account(), t.chains[0]!, 15, 10n, t.now);
    const usdg = t.db.createInvoice(account(), t.chains[1]!, 15, 10n, t.now);
    t.transfers.push({ token: t.chains[1]!.token, to: treasury, value: BigInt(usdg.token_amount), hash: tx("1"), block: 12n });

    const failures = await scanCreditPayments(t.db, t.chains, { log: t.log });

    // $NATION is listed first and fails; USDG is scanned and credited anyway
    expect(t.db.invoice(usdg.id)?.paid_tx).toBe(tx("1"));
    expect(t.db.invoice(nation.id)?.paid_tx).toBeNull();
    expect(failures).toEqual([expect.objectContaining({ chain: 4663, symbol: "$NATION", token: nationToken })]);
    expect(failures[0]!.error).toContain("fixture: log query rejected");
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain(`NATION payment scan failed for $NATION on Robinhood Chain (chain 4663, token ${nationToken})`);
    // the RPC endpoint and its key never reach the log
    expect(t.lines[0]).not.toMatch(/127\.0\.0\.1|sk_live|fixturesecret/);
    // the failed token keeps its cursor where it was; the healthy one moves on
    const cursors = Object.fromEntries(t.db.db.prepare("SELECT token, block FROM credit_scan_cursors").all().map((row) => [row.token, row.block]));
    expect(cursors).toEqual({ [t.chains[1]!.token]: "18" });

    // the next pass, with the RPC healthy again, picks the $NATION request up
    t.transfers.push({ token: nationToken, to: treasury, value: BigInt(nation.token_amount), hash: tx("2"), block: 15n });
    delete fixture.failLogsFor;
    expect(await scanCreditPayments(t.db, t.chains, { log: t.log })).toEqual([]);
    expect(t.db.invoice(nation.id)?.paid_tx).toBe(tx("2"));
  });

  it("refuses to scan a network whose chain id does not match, loudly, for every token", async () => {
    const t = await twoTokens(20n, { chainId: 1 });
    t.db.createInvoice(account(), t.chains[1]!, 15, 10n, t.now);
    t.db.createInvoice(account(), t.chains[0]!, 15, 10n, t.now);
    const failures = await scanCreditPayments(t.db, t.chains, { log: t.log });
    expect(failures.map((f) => f.symbol)).toEqual(["$NATION", "USDG"]);
    expect(t.lines).toHaveLength(2);
    for (const line of t.lines) expect(line).toContain("payment RPC reports chain id 1, expected 4663; refusing to scan the wrong network");
    expect(t.chainRpc.methods).not.toContain("eth_getLogs");
    expect(t.db.db.prepare("SELECT COUNT(*) AS n FROM credit_scan_cursors").get()?.n).toBe(0);
  });

  it("expired requests never pull the scan back into history or hold up a fresh one", async () => {
    const t = await twoTokens(1_000n);
    const stale = t.db.createInvoice(account(), t.chains[1]!, 15, 1n, t.now - LATE_PAYMENT_WINDOW_MS - 3_600_000);
    // a stale request alone costs no RPC call at all
    expect(await scanCreditPayments(t.db, t.chains, { log: t.log })).toEqual([]);
    expect(t.chainRpc.methods).toEqual([]);

    const fresh = t.db.createInvoice(account(), t.chains[1]!, 49, 900n, t.now);
    t.transfers.push({ token: t.chains[1]!.token, to: treasury, value: BigInt(fresh.token_amount), hash: tx("3"), block: 950n });
    expect(await scanCreditPayments(t.db, t.chains, { log: t.log })).toEqual([]);

    expect(t.db.invoice(fresh.id)?.paid_tx).toBe(tx("3"));
    expect(t.db.invoice(stale.id)?.paid_tx).toBeNull();
    // it started at the fresh request's block, not the stale one's
    expect(Math.min(...t.chainRpc.ranges.map((range) => Number(range.from)))).toBe(900);
    expect(t.lines).toEqual([]);
  });

  it("closes a long cursor lag in one pass, jumping straight to the earliest fresh request", async () => {
    const t = await twoTokens(6_000n);
    const usdg = t.chains[1]!;
    // a cursor left far behind by a quiet spell
    t.db.db.prepare("INSERT INTO credit_scan_cursors VALUES(?,?,?)").run(4663, usdg.token, "10");
    const invoice = t.db.createInvoice(account(), usdg, 15, 2_000n, t.now);
    t.transfers.push({ token: usdg.token, to: treasury, value: BigInt(invoice.token_amount), hash: tx("4"), block: 5_900n });

    await scanCreditPayments(t.db, t.chains, { log: t.log });

    expect(t.db.invoice(invoice.id)?.paid_tx).toBe(tx("4"));
    const ranges = t.chainRpc.ranges.filter((range) => range.token === usdg.token);
    expect(ranges[0]).toMatchObject({ from: 2_000n, to: 2_000n + SCAN_CHUNK_BLOCKS - 1n });
    // contiguous chunks up to the last confirmed block (head 6000, 3 confirmations)
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.from).toBe(ranges[i - 1]!.to + 1n);
    expect(ranges.at(-1)!.to).toBe(5_998n);
    expect(t.db.db.prepare("SELECT block FROM credit_scan_cursors WHERE token=?").get(usdg.token)?.block).toBe("5998");
  });

  it("sets aside a transfer that can never pay its request instead of pinning the cursor", async () => {
    // every block of this chain is an hour older than the request: its transfer predates it
    const now = Date.now();
    const t = await twoTokens(20n, {}, now);
    const earlier = await fakeChain(t.transfers, 20n, BigInt(Math.floor(now / 1000)) - 3_600n);
    const usdg = t.chains[1]!;
    const invoice = t.db.createInvoice(account(), usdg, 15, 10n, now);
    t.transfers.push({ token: usdg.token, to: treasury, value: BigInt(invoice.token_amount), hash: tx("5"), block: 12n });

    const pass = () => scanCreditPayments(t.db, [{ ...usdg, rpc: earlier.url }], { log: t.log });
    expect(await pass()).toEqual([]);
    expect(t.db.invoice(invoice.id)?.paid_tx).toBeNull();
    expect(t.lines).toEqual([expect.stringContaining(`set aside transfer ${tx("5")} (USDG, chain 4663) for request ${invoice.id}: This transfer predates the payment request.`)]);
    // the cursor moved past it: the next pass does not trip over the same transfer again
    expect(t.db.db.prepare("SELECT block FROM credit_scan_cursors WHERE token=?").get(usdg.token)?.block).toBe("18");
    await pass();
    expect(t.lines).toHaveLength(1);
  });

  it("credits the first of two identical transfers once and logs the second as a likely double payment", async () => {
    const t = await twoTokens(20n);
    const usdg = t.chains[1]!;
    const invoice = t.db.createInvoice(account(), usdg, 15, 10n, t.now);
    // a second request keeps the token scanning after the first is paid
    t.db.createInvoice(account(), usdg, 49, 10n, t.now);
    t.transfers.push({ token: usdg.token, to: treasury, value: BigInt(invoice.token_amount), hash: tx("6"), block: 12n });
    expect(await scanCreditPayments(t.db, t.chains, { log: t.log })).toEqual([]);
    expect(t.db.invoice(invoice.id)?.paid_tx).toBe(tx("6"));
    expect(t.lines).toEqual([]);

    // the same amount again, in a later pass: never credited twice, and reported
    t.transfers.push({ token: usdg.token, to: treasury, value: BigInt(invoice.token_amount), hash: tx("7"), block: 19n });
    await new Promise(resolve => setTimeout(resolve, 5));
    const later = await fakeChain(t.transfers, 25n, BigInt(Math.floor(Date.now() / 1000)) + 5n);
    expect(await scanCreditPayments(t.db, [{ ...usdg, rpc: later.url }], { log: t.log })).toEqual([]);
    expect(t.db.balance(account().id)).toBe(invoice.amount_micros);
    expect(t.lines).toEqual([`NATION payment scan found a second transfer ${tx("7")} (USDG, chain 4663) for request ${invoice.id}, already credited by ${tx("6")}. Nothing credits it automatically: refund it or credit it by hand.`]);
    expect(t.db.db.prepare("SELECT block FROM credit_scan_cursors WHERE token=?").get(usdg.token)?.block).toBe("23");
  });

  it("stays quiet when a pasted hash credited the same transfer first", async () => {
    const t = await twoTokens(20n);
    const usdg = t.chains[1]!;
    const invoice = t.db.createInvoice(account(), usdg, 15, 10n, t.now);
    t.transfers.push({ token: usdg.token, to: treasury, value: BigInt(invoice.token_amount), hash: tx("8"), block: 12n });
    // the buyer pastes the hash before the scan reaches it
    t.db.paid(invoice, tx("8"), invoice.amount_micros);
    t.db.createInvoice(account(), usdg, 49, 10n, t.now);
    expect(await scanCreditPayments(t.db, t.chains, { log: t.log })).toEqual([]);
    expect(t.db.balance(account().id)).toBe(invoice.amount_micros);
    expect(t.lines).toEqual([]);
  });
});

describe("payment scan error text", () => {
  it("keeps the RPC's words and drops its URL, request body and anything secret-shaped", () => {
    const viemLike = Object.assign(new Error("HTTP request failed.\n\nURL: https://rpc.example/v2/sk_live_abc123\nRequest body: {\"method\":\"eth_getLogs\"}"), { shortMessage: "HTTP request failed." });
    expect(scanErrorText(viemLike)).toBe("HTTP request failed.");
    expect(scanErrorText(new Error("fetch https://user:pass@rpc.example/key123 failed"))).toBe("fetch <rpc> failed");
    expect(scanErrorText("plain")).toBe("plain");
  });
});

describe("payment scan interval", () => {
  it("is 30 s unless NATION_CREDIT_SCAN_SECONDS sets a whole number from 5 to 300", () => {
    expect(creditScanIntervalMs({})).toBe(30_000);
    expect(creditScanIntervalMs({ NATION_CREDIT_SCAN_SECONDS: "5" })).toBe(5_000);
    for (const value of ["1", "0", "301", "2.5", "soon"]) expect(creditScanIntervalMs({ NATION_CREDIT_SCAN_SECONDS: value })).toBe(30_000);
  });
});
