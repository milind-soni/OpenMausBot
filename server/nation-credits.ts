import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const USD_SCALE = 1_000_000;
export function micros(usd: number): number {
  const result = Math.round(usd * USD_SCALE);
  if (!Number.isFinite(usd) || !Number.isSafeInteger(result)) throw new Error("Invalid credit amount");
  return result;
}
export function creditError(message: string, status = 400): Error & { status: number } { return Object.assign(new Error(message), { status }); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CreditTier { id: string; name: string; usd: number; creditUsd: number; popular: boolean }
/** nationDiscount: share of the pack price a $NATION payment skips (0.2 = send 20% less; the credit is unchanged). */
export interface CreditSettings { freeUsd: number; markup: number; lowUsd: number; packs: number[]; grantsPerIp: number; grantsPerDay: number; confirmations: number; tiers: CreditTier[]; nationDiscount: number }

const DEFAULT_TIERS: CreditTier[] = [
  { id: "starter", name: "Starter", usd: 15, creditUsd: 15, popular: false },
  { id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true },
  { id: "swarm",   name: "Swarm",   usd: 99, creditUsd: 99, popular: false },
];

export function creditSettings(env: NodeJS.ProcessEnv = process.env): CreditSettings {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw creditError(`Invalid ${key}`);
    return value;
  };
  const packs = (env.NATION_PACKS_USD ?? "15,49,99").split(",").map(value => Number(value.trim()));
  if (!packs.length || packs.length > 20 || packs.some(value => !Number.isFinite(value) || value <= 0 || value > 1_000_000 || !Number.isInteger(value * 100))) throw creditError("Invalid NATION_PACKS_USD");
  const grantsPerIp = number("NATION_FREE_GRANTS_PER_IP_PER_DAY", 2, 1, 1000);
  // Starter credits in all per UTC day: a ceiling no request header can move.
  const grantsPerDay = number("NATION_FREE_GRANTS_PER_DAY", 1000, 1, 1_000_000);
  const confirmations = number("NATION_CONFIRMATIONS", 3, 1, 10000);
  if (!Number.isInteger(grantsPerIp) || !Number.isInteger(grantsPerDay) || !Number.isInteger(confirmations)) throw creditError("Grant and confirmation limits must be whole numbers");
  const defaultByUsd = new Map(DEFAULT_TIERS.map(t => [t.usd, t]));
  const tiers: CreditTier[] = [...new Set(packs)].map((usd, i) => {
    const def = defaultByUsd.get(usd);
    return def ?? { id: `pack${i}`, name: `$${usd} pack`, usd, creditUsd: usd, popular: false };
  });
  // An empty NATION_TOKEN_DISCOUNT= line means the default, not "no discount"; set 0 to turn it off.
  const nationDiscount = env.NATION_TOKEN_DISCOUNT?.trim() ? number("NATION_TOKEN_DISCOUNT", 0.2, 0, 0.9) : 0.2;
  return { freeUsd: number("NATION_FREE_CREDIT_USD", 3, 2, 5), markup: number("NATION_CREDIT_MARKUP", 1, 0.01, 100),
    lowUsd: number("NATION_LOW_BALANCE_USD", 0.5, 0, 1000), packs: [...new Set(packs)], grantsPerIp, grantsPerDay, confirmations, tiers, nationDiscount };
}
/** The inbox an address delivers to: a +tag, and dots in a Gmail name, reach
 * the same one, so they share its one starter credit. */
export function mailboxOf(email: string): string {
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at).trim().toLowerCase(), domain = email.slice(at + 1).trim().toLowerCase();
  local = local.split("+")[0] || local;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "") || local;
  return `${local}@${domain}`;
}
export interface CreditAccount { id: string; verified: boolean; email?: string; exempt?: boolean }
/** token_amount: expected ERC-20 transfer uint256 value as decimal string; empty string means use amount_micros (legacy USDC invoices).
 * amount_micros is always what the payment credits; discount_bps records how much less a $NATION buyer sends for it. */
export interface CreditInvoice { id: string; user_id: string; chain: number; treasury: string; token: string; pack_micros: number; amount_micros: number; created_at: number; expires_at: number; paid_tx: string | null; from_block: string; token_amount: string; discount_bps: number }
/** decimals: ERC-20 token decimals (6 for USDC/USDG, 18 for $NATION). */
export interface CreditChain { id: number; name: string; symbol: string; token: string; treasury: string; rpc: string; decimals: number }

/** NATION_TOKEN_USD_PRICE is held in pico-dollars: a $0.000286 token keeps every digit an operator sets. */
const PRICE_SCALE = 1_000_000_000_000;

/**
 * Compute the expected ERC-20 transfer uint256 value for an invoice.
 * For 6-decimal tokens (USDC/USDG) this equals amountMicros directly.
 * For 18-decimal tokens ($NATION) this converts USD micros → token units via NATION_TOKEN_USD_PRICE,
 * less discountBps (2000 = the buyer sends 20% less $NATION; the invoice still credits amountMicros).
 * Returns result as a decimal string safe for BigInt.
 */
export function invoiceTokenAmount(amountMicros: number, chain: CreditChain, env: NodeJS.ProcessEnv = process.env, discountBps = 0): string {
  if (chain.decimals === 6) return String(amountMicros);
  const priceUsd = Number(env.NATION_TOKEN_USD_PRICE ?? "");
  const pricePico = Number.isFinite(priceUsd) ? BigInt(Math.round(priceUsd * PRICE_SCALE)) : 0n;
  if (pricePico <= 0n) throw creditError("NATION_TOKEN_USD_PRICE must be set to a positive number to use $NATION payments.", 503);
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps >= 10_000) throw creditError("Invalid $NATION discount");
  // token_units = floor(amountMicros/USD_SCALE × (1 − discount) ÷ (pricePico/PRICE_SCALE) × 10^decimals), in integers.
  return String((BigInt(amountMicros) * BigInt(10_000 - discountBps) * BigInt(PRICE_SCALE) * 10n ** BigInt(chain.decimals))
    / (BigInt(USD_SCALE) * 10_000n * pricePico));
}

export function creditChains(env: NodeJS.ProcessEnv = process.env): CreditChain[] {
  // Top-up payment is Robinhood Chain only. Base (8453) is no longer offered
  // in the user-facing top-up path; NATION_TREASURY_BASE is intentionally ignored.
  const specs: Array<{ id: number; name: string; symbol: string; token: string; treasury: string | undefined; rpc: string; decimals: number }> = [
    // $NATION on Robinhood Chain — only included when NATION_TOKEN_USD_PRICE is configured.
    ...(env.NATION_TOKEN_USD_PRICE ? [{ id: 4663, name: "Robinhood Chain", symbol: "$NATION", token: "0xc839A88A05B231515a82c71EE97b4F18973C1340", treasury: env.NATION_TREASURY_ROBINHOOD, rpc: env.NATION_RPC_ROBINHOOD || "https://rpc.mainnet.chain.robinhood.com", decimals: 18 } as const] : []),
    // USDG on Robinhood Chain — primary stablecoin for top-up.
    { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", treasury: env.NATION_TREASURY_ROBINHOOD, rpc: env.NATION_RPC_ROBINHOOD || "https://rpc.mainnet.chain.robinhood.com", decimals: 6 },
  ];
  return specs.flatMap(spec => spec.treasury && /^0x[0-9a-f]{40}$/i.test(spec.treasury) && !/^0x0{40}$/i.test(spec.treasury)
    ? [{ ...spec, treasury: spec.treasury.toLowerCase(), token: spec.token.toLowerCase() }] : []);
}
/** The payment entry an invoice request names. USDG and $NATION share Robinhood Chain's id, so the token
 * address decides; a request without one (a client from before the pay toggle) gets the stablecoin rather
 * than whichever entry happens to be listed first. */
export function invoiceChain(chains: CreditChain[], id: number, token?: string): CreditChain | undefined {
  const onChain = chains.filter(chain => chain.id === id);
  return token ? onChain.find(chain => chain.token === token.toLowerCase()) : onChain.find(chain => chain.symbol !== "$NATION");
}
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "yopmail.com", "yopmail.fr", "dispostable.com", "trashmail.com", "getnada.com", "sharklasers.com", "grr.la", "guerrillamailblock.com", "maildrop.cc", "mohmal.com", "fakeinbox.com", "throwawaymail.com"]);
export function disposableEmail(email: string, extra = process.env.NATION_DISPOSABLE_EMAIL_DOMAINS ?? ""): boolean {
  const domain = email.toLowerCase().split("@").at(-1) ?? "";
  const blocked = [...DISPOSABLE, ...extra.toLowerCase().split(/[\s,]+/).filter(Boolean)];
  return blocked.some(item => domain === item || domain.endsWith("." + item));
}

/** Integer USD ledger. Transactions serialize grants, payments and adjustments across PM2 workers. */
export class CreditLedger {
  readonly db: DatabaseSync;
  readonly inFlight = new Set<string>();
  readonly settings: CreditSettings;
  readonly env: NodeJS.ProcessEnv;
  constructor(file: string, settings = creditSettings(), env: NodeJS.ProcessEnv = process.env) {
    this.settings = settings;
    this.env = env;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_accounts(id TEXT PRIMARY KEY, verified INTEGER NOT NULL, exempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES credit_accounts(id), type TEXT NOT NULL CHECK(type IN ('free','purchase','usage','refund')), amount_micros INTEGER NOT NULL, cost_micros INTEGER NOT NULL DEFAULT 0, tx_hash TEXT UNIQUE, chain INTEGER, reference TEXT UNIQUE, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger(user_id, created_at);
      CREATE TABLE IF NOT EXISTS credit_grants(user_id TEXT PRIMARY KEY REFERENCES credit_accounts(id), ip_hash TEXT NOT NULL, device_hash TEXT NOT NULL UNIQUE, day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS credit_grants_ip_day ON credit_grants(ip_hash, day);
      CREATE INDEX IF NOT EXISTS credit_grants_day ON credit_grants(day);
      CREATE TABLE IF NOT EXISTS credit_grant_mailboxes(mailbox_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_invoices(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES credit_accounts(id), chain INTEGER NOT NULL, treasury TEXT NOT NULL, token TEXT NOT NULL, pack_micros INTEGER NOT NULL, amount_micros INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_tx TEXT UNIQUE, from_block TEXT NOT NULL, token_amount TEXT NOT NULL DEFAULT '', discount_bps INTEGER NOT NULL DEFAULT 0, UNIQUE(chain,amount_micros));
      CREATE TABLE IF NOT EXISTS credit_wallets(session_id TEXT PRIMARY KEY, address TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_challenges(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_calls(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_sponsors(thread_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_cursors(chain INTEGER PRIMARY KEY, block TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_scan_cursors(chain INTEGER NOT NULL, token TEXT NOT NULL, block TEXT NOT NULL, PRIMARY KEY(chain, token));
      CREATE TABLE IF NOT EXISTS credit_embedded_wallets(account_id TEXT PRIMARY KEY, sub_org_id TEXT NOT NULL, wallet_id TEXT NOT NULL, address TEXT NOT NULL UNIQUE, credential_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    // credit_cursors kept one block per chain id, which USDG and $NATION share; the payment
    // scan now keeps one per chain + token in credit_scan_cursors and no longer reads it.
    // Forward-compatible migrations: add columns to existing databases that predate them.
    const cols = (this.db.prepare("PRAGMA table_info(credit_invoices)").all() as { name: string }[]).map(c => c.name);
    if (!cols.includes("token_amount")) {
      this.db.exec("ALTER TABLE credit_invoices ADD COLUMN token_amount TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.includes("discount_bps")) {
      this.db.exec("ALTER TABLE credit_invoices ADD COLUMN discount_bps INTEGER NOT NULL DEFAULT 0");
    }
  }
  close() { this.db.close(); }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  account(account: CreditAccount, now = Date.now()): void {
    this.db.prepare("INSERT INTO credit_accounts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET verified=MAX(verified,excluded.verified),exempt=excluded.exempt")
      .run(account.id, Number(account.verified), Number(account.exempt === true), now);
  }
  balance(id: string): number {
    return Number(this.db.prepare("SELECT COALESCE(SUM(amount_micros),0) AS balance FROM credit_ledger WHERE user_id=?").get(id)?.balance ?? 0);
  }
  private row(id: string, type: string, amount: number, reason: string, input: { reference?: string; cost?: number; tx?: string; chain?: number; now?: number } = {}) {
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(input.cost ?? 0)) throw creditError("Invalid ledger amount");
    this.db.prepare("INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), id, type, amount, input.cost ?? 0, input.tx ?? null, input.chain ?? null, input.reference ?? null, reason, input.now ?? Date.now());
  }
  grant(account: CreditAccount, ip: string, device: string, now = Date.now()): { granted: boolean; reason: string } {
    this.account(account, now);
    if (account.exempt) return { granted: false, reason: "Owner/admin access" };
    if (!account.verified) return { granted: false, reason: "Verify your email or wallet to receive starter credit." };
    if (account.email && disposableEmail(account.email)) return { granted: false, reason: "This email is not eligible for starter credit." };
    if (!ip || !device || device.length > 256) return { granted: false, reason: "A verified device is required for starter credit." };
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM credit_grants WHERE user_id=?").get(account.id)) return { granted: false, reason: "Starter credit already received" };
      const mailboxHash = account.email ? digest(`mailbox:${mailboxOf(account.email)}`) : null;
      if (mailboxHash && this.db.prepare("SELECT 1 FROM credit_grant_mailboxes WHERE mailbox_hash=?").get(mailboxHash)) return { granted: false, reason: "This email address already received starter credit." };
      const day = new Date(now).toISOString().slice(0, 10), ipHash = digest(ip), deviceHash = digest(device);
      const today = Number(this.db.prepare("SELECT COUNT(*) AS count FROM credit_grants WHERE day=?").get(day)?.count ?? 0);
      if (today >= this.settings.grantsPerDay) return { granted: false, reason: "Today's starter credit has all been given out. Try again tomorrow." };
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM credit_grants WHERE ip_hash=? AND day=?").get(ipHash, day)?.count ?? 0);
      if (count >= this.settings.grantsPerIp || this.db.prepare("SELECT 1 FROM credit_grants WHERE device_hash=?").get(deviceHash)) return { granted: false, reason: "Starter credit is unavailable for this device or network." };
      this.db.prepare("INSERT INTO credit_grants VALUES(?,?,?,?)").run(account.id, ipHash, deviceHash, day);
      if (mailboxHash) this.db.prepare("INSERT INTO credit_grant_mailboxes VALUES(?,?)").run(mailboxHash, account.id);
      this.row(account.id, "free", micros(this.settings.freeUsd), "Starter credit", { reference: `free:${account.id}`, now });
      return { granted: true, reason: "Starter credit ready" };
    });
  }
  assertAvailable(account: CreditAccount): void {
    if (account.exempt) return;
    if (!account.verified) throw creditError("Verify your email or wallet before using NATION API.", 403);
    if (this.db.prepare("SELECT id,state FROM credit_calls WHERE user_id=? AND state IN ('active','pending')").all(account.id).some(call => call.state === "pending" || !this.inFlight.has(String(call.id)))) throw creditError("A previous call is awaiting cost confirmation. Please try again shortly.", 409);
    if (this.balance(account.id) <= 0) throw creditError("Your credit has run out. Please top up to keep working with your teammates.", 402);
  }
  beginCall(account: CreditAccount, now = Date.now()): string {
    this.account(account, now);
    return this.transaction(() => {
      this.assertAvailable(account);
      const id = randomUUID();
      this.db.prepare("INSERT INTO credit_calls VALUES(?,?, 'active', NULL, ?)").run(id, account.id, now);
      this.inFlight.add(id);
      return id;
    });
  }
  providerId(call: string, id: string) { this.db.prepare("UPDATE credit_calls SET provider_id=? WHERE id=? AND state IN ('active','pending')").run(id, call); }
  markUnconfirmed(call: string) { this.inFlight.delete(call); this.db.prepare("UPDATE credit_calls SET state='pending' WHERE id=? AND state='active'").run(call); }
  cancelUnsent(call: string) { this.inFlight.delete(call); this.db.prepare("UPDATE credit_calls SET state='cancelled' WHERE id=? AND state IN ('active','pending')").run(call); }
  settle(call: string, actualUsd: number, reason = "NATION API usage"): number {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw creditError("NATION API cost confirmation is unavailable.", 502);
    const cost = micros(actualUsd);
    return this.transaction(() => {
      const pending = this.db.prepare("SELECT * FROM credit_calls WHERE id=?").get(call);
      if (!pending || !["active", "pending"].includes(String(pending.state))) return 0;
      const account = this.db.prepare("SELECT exempt FROM credit_accounts WHERE id=?").get(pending.user_id!);
      const debit = account?.exempt ? 0 : Math.ceil(actualUsd * this.settings.markup * USD_SCALE);
      this.row(String(pending.user_id), "usage", -debit, reason, { cost, reference: `call:${call}` });
      this.db.prepare("UPDATE credit_calls SET state='settled' WHERE id=?").run(call);
      this.inFlight.delete(call);
      return debit;
    });
  }
  adjust(id: string, amountUsd: number, reason: string, actor: string): void {
    const amount = micros(amountUsd);
    if (!amount || !reason.trim() || reason.length > 500) throw creditError("Enter a nonzero amount and a reason.");
    this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM credit_accounts WHERE id=?").get(id)) throw creditError("Unknown account", 404);
      if (this.balance(id) + amount < 0) throw creditError("An adjustment cannot make credit negative.");
      this.row(id, "refund", amount, `${actor}: ${reason.trim()}`);
    });
  }
  invoice(id: string): CreditInvoice | undefined { return this.db.prepare("SELECT * FROM credit_invoices WHERE id=?").get(id) as unknown as CreditInvoice | undefined; }
  createInvoice(account: CreditAccount, chain: CreditChain, packUsd: number, block: bigint, now = Date.now()): CreditInvoice {
    if (!account.verified) throw creditError("Verify your account first.", 403);
    if (!this.settings.packs.includes(packUsd)) throw creditError("Unknown credit pack");
    this.account(account, now);
    // Only $NATION is discounted; the stablecoin pays the pack price.
    const discountBps = chain.symbol === "$NATION" ? Math.round(this.settings.nationDiscount * 10_000) : 0;
    return this.transaction(() => {
      const open = Number(this.db.prepare("SELECT COUNT(*) AS n FROM credit_invoices WHERE user_id=? AND expires_at>? AND paid_tx IS NULL").get(account.id, now)?.n ?? 0);
      if (open >= 5) throw creditError("Use one of your current payment requests before creating another.", 429);
      const pack = micros(packUsd);
      for (let attempt = 0; attempt < 100; attempt++) {
        const amount = pack + randomInt(1, 1_000_000);
        if (this.db.prepare("SELECT 1 FROM credit_invoices WHERE chain=? AND amount_micros=?").get(chain.id, amount)) continue;
        const id = randomUUID();
        const tokenAmt = invoiceTokenAmount(amount, chain, this.env, discountBps);
        this.db.prepare("INSERT INTO credit_invoices(id,user_id,chain,treasury,token,pack_micros,amount_micros,created_at,expires_at,paid_tx,from_block,token_amount,discount_bps) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)").run(id, account.id, chain.id, chain.treasury, chain.token.toLowerCase(), pack, amount, now, now + 30 * 60_000, String(block), tokenAmt, discountBps);
        return this.invoice(id)!;
      }
      throw creditError("Payment requests are busy. Please try again.", 503);
    });
  }
  paid(invoice: CreditInvoice, tx: string, paidMicros: number, now = Date.now()): void {
    if (!/^0x[0-9a-f]{64}$/i.test(tx) || paidMicros !== invoice.amount_micros || paidMicros < invoice.pack_micros) throw creditError("Payment does not match this request.");
    this.transaction(() => {
      const current = this.invoice(invoice.id);
      if (!current || current.paid_tx) throw creditError("This payment request has already been credited.", 409);
      if (this.db.prepare("SELECT 1 FROM credit_ledger WHERE tx_hash=?").get(tx.toLowerCase())) throw creditError("This transaction has already been used.", 409);
      this.row(invoice.user_id, "purchase", paidMicros, "Credit purchase", { tx: tx.toLowerCase(), chain: invoice.chain, reference: `invoice:${invoice.id}`, now });
      this.db.prepare("UPDATE credit_invoices SET paid_tx=? WHERE id=?").run(tx.toLowerCase(), invoice.id);
    });
  }
  admin() {
    return {
      users: this.db.prepare("SELECT a.*, COALESCE(SUM(l.amount_micros),0) AS balance_micros FROM credit_accounts a LEFT JOIN credit_ledger l ON l.user_id=a.id GROUP BY a.id ORDER BY a.created_at DESC LIMIT 500").all(),
      ledger: this.db.prepare("SELECT * FROM credit_ledger ORDER BY created_at DESC LIMIT 1000").all(),
      payments: this.db.prepare("SELECT * FROM credit_invoices ORDER BY created_at DESC LIMIT 500").all(),
      pendingCosts: this.db.prepare("SELECT * FROM credit_calls WHERE state IN ('active','pending') ORDER BY created_at LIMIT 500").all(),
      daily: this.db.prepare("SELECT date(created_at/1000,'unixepoch') AS day,SUM(cost_micros) AS cost_micros,SUM(CASE WHEN type='purchase' THEN amount_micros ELSE 0 END) AS sold_micros FROM credit_ledger GROUP BY day ORDER BY day DESC LIMIT 90").all(),
    };
  }
}
