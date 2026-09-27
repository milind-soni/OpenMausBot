import { randomUUID } from "node:crypto";
import { getAddress, verifyMessage, type Hex } from "viem";
import { z } from "zod";
import { PASS, type RouteHandler } from "./table.ts";
import { creditAccount, nationLedger } from "../nation-credit-context.ts";
import { creditChains, creditError, invoiceChain, USD_SCALE, type CreditLedger } from "../nation-credits.ts";
import { chainClient, confirmCreditPayment } from "../nation-payments.ts";
import { clientAddressDetail, parseCookies } from "../request-auth.ts";

const invoiceSchema = z.object({ chain: z.number().int(), packUsd: z.number().positive(), token: z.string().regex(/^0x[0-9a-f]{40}$/i).optional() }).strict();
const confirmSchema = z.object({ invoiceId: z.string().uuid(), txHash: z.string().regex(/^0x[0-9a-f]{64}$/i) }).strict();
const challengeSchema = z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/i) }).strict();
const signatureSchema = z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[0-9a-f]+$/i).max(4096) }).strict();
const reconcileSchema = z.object({ callId: z.string().uuid(), actualCostUsd: z.number().finite().nonnegative(), reason: z.string().trim().min(1).max(500) }).strict();
const adjustSchema = z.object({ userId: z.string().max(256), amountUsd: z.number().finite(), reason: z.string().trim().min(1).max(500) }).strict();

/** Free until the account has paid for a pack; the starter credit is what the ledger actually
 * granted it, or the configured amount it would receive once verified. */
export function creditPlan(db: CreditLedger["db"], userId: string, freeUsd: number): { plan: "free" | "paid"; starterCreditUsd: number; starterGranted: boolean } {
  const paid = Boolean(db.prepare("SELECT 1 FROM credit_ledger WHERE user_id=? AND type='purchase' LIMIT 1").get(userId));
  const granted = Number(db.prepare("SELECT COALESCE(SUM(amount_micros),0) AS n FROM credit_ledger WHERE user_id=? AND type='free'").get(userId)?.n ?? 0);
  return { plan: paid ? "paid" : "free", starterCreditUsd: granted > 0 ? granted / USD_SCALE : freeUsd, starterGranted: granted > 0 };
}

/** Invoice rows whose chain id and token address are both still billed here. */
export function liveInvoices<T extends Record<string, unknown>>(chains: ReadonlyArray<{ id: number; token: string }>, rows: T[]): T[] {
  return rows.filter((row) => chains.some((chain) => chain.id === Number(row.chain) && chain.token.toLowerCase() === String(row.token).toLowerCase()));
}

export function createNationCreditRoutes(): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/credits") && !path.startsWith("/api/admin/credits")) return PASS;
    const ledger = nationLedger(), account = creditAccount(auth);
    ledger.account(account);
    res.setHeader("cache-control", "no-store");
    if (path.startsWith("/api/admin/credits")) {
      if (!account.exempt) return json(res, 403, { error: "Owner/admin access required." });
      if (path === "/api/admin/credits" && method === "GET") return json(res, 200, ledger.admin());
      // The owner's own request, as per-network limits see it: after a deploy,
      // `address` should be the owner's own public address, not the web front
      // end's; `headers` shows which one names it (NATION_CLIENT_IP_HEADER).
      if (path === "/api/admin/credits/client-address" && method === "GET") {
        const named = process.env.NATION_CLIENT_IP_HEADER?.trim().toLowerCase();
        const headers = [...new Set(["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", ...(named && /^[a-z0-9-]{1,64}$/.test(named) ? [named] : [])])];
        const value = (name: string) => { const raw = req.headers[name]; return (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 200) ?? null; };
        return json(res, 200, { ...clientAddressDetail(req), peer: req.socket.remoteAddress ?? null, headers: Object.fromEntries(headers.map((name) => [name, value(name)])) });
      }
      if (path === "/api/admin/credits/reconcile" && method === "POST") {
        const input = reconcileSchema.parse(await readBody(req));
        const call = ledger.db.prepare("SELECT state,created_at FROM credit_calls WHERE id=?").get(input.callId);
        if (!call || !["active", "pending"].includes(String(call.state))) throw creditError("Pending call not found", 404);
        if (ledger.inFlight.has(input.callId) || (call.state === "active" && Date.now() - Number(call.created_at) < 600_000)) throw creditError("This call may still be running. Try again later.", 409);
        ledger.settle(input.callId, input.actualCostUsd, `Owner/admin cost reconciliation: ${input.reason}`);
        return json(res, 200, { ok: true });
      }
      if (path === "/api/admin/credits/adjust" && method === "POST") {
        const input = adjustSchema.parse(await readBody(req));
        ledger.adjust(input.userId, input.amountUsd, input.reason, account.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "Not found" });
    }
    if (path === "/api/credits/status" && method === "GET") {
      const supplied = parseCookies(req.headers.cookie).get("nation_device");
      const device = supplied && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : randomUUID();
      if (device !== supplied) res.setHeader("set-cookie", `nation_device=${device}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${auth.kind === "loopback" ? "" : "; Secure"}`);
      // The visitor, as the account gateway counts them (server/request-auth.ts clientAddress).
      const grant = ledger.grant(account, clientAddressDetail(req).address, device);
      const balanceUsd = Math.max(0, ledger.balance(account.id) / USD_SCALE);
      // Treasuries are stored lowercase; show them checksummed, as a wallet shows the address.
      const chains = creditChains().map(({ rpc: _rpc, ...chain }) => ({ ...chain, treasury: getAddress(chain.treasury) }));
      // $NATION price for the pack cards, and the discount createInvoice applies to $NATION invoices.
      // nationInvoiceDiscount is new: a client keys "Save N%" on it, so it never advertises a
      // discount to a server that still bills $NATION at the full price.
      const nationPriceUsd = Number(process.env.NATION_TOKEN_USD_PRICE ?? "");
      const nationPriced = Number.isFinite(nationPriceUsd) && nationPriceUsd > 0;
      const nationDiscount = nationPriced && ledger.settings.nationDiscount > 0 ? ledger.settings.nationDiscount : null;
      // The plan is read from the ledger, not a subscription: an account is on the free plan
      // until it has paid for a pack. Owner/admin accounts are exempt and on neither.
      const plan = creditPlan(ledger.db, account.id, ledger.settings.freeUsd);
      // Only requests on a chain+token this server still bills: an old Base row or a dropped
      // token can be neither paid nor listed without guessing its symbol, and must not crowd
      // the recent window out of the rows that can.
      const invoices = liveInvoices(chains, ledger.db.prepare("SELECT id,chain,treasury,token,pack_micros,amount_micros,token_amount,discount_bps,expires_at,paid_tx FROM credit_invoices WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(account.id))
        .slice(0, 5).map(row => ({ ...row, treasury: getAddress(String(row.treasury)) }));
      return json(res, 200, { balanceUsd, label: account.exempt ? "NATION API · owner/admin" : `$${balanceUsd.toFixed(2)} credit left`,
        verified: account.verified, exempt: account.exempt === true, lowBalance: !account.exempt && balanceUsd < ledger.settings.lowUsd,
        topUpEnabled: chains.length > 0, topUpMessage: chains.length ? "Top up" : "Top up coming soon", packs: ledger.settings.packs,
        tiers: ledger.settings.tiers, nationPriceUsd: nationPriced ? nationPriceUsd : null, nationDiscount, nationInvoiceDiscount: nationDiscount, chains,
        starterMessage: grant.reason, invoices, plan: plan.plan, onFreePlan: plan.plan === "free" && account.exempt !== true,
        starterCreditUsd: plan.starterCreditUsd, starterGranted: plan.starterGranted });
    }
    if (path === "/api/credits/invoices" && method === "POST") {
      const input = invoiceSchema.parse(await readBody(req));
      const chain = invoiceChain(creditChains(), input.chain, input.token);
      if (!chain) throw creditError("Top up coming soon", 503);
      const rpc = chainClient(chain);
      if (await rpc.getChainId() !== chain.id) throw creditError("Payment network is unavailable.", 503);
      const invoice = ledger.createInvoice(account, chain, input.packUsd, await rpc.getBlockNumber());
      return json(res, 201, { ...invoice, treasury: getAddress(invoice.treasury), amount: (invoice.amount_micros / USD_SCALE).toFixed(6), symbol: chain.symbol, chainName: chain.name });
    }
    if (path === "/api/credits/confirm" && method === "POST") {
      const input = confirmSchema.parse(await readBody(req));
      const invoice = ledger.invoice(input.invoiceId);
      if (!invoice || invoice.user_id !== account.id) throw creditError("Payment request not found", 404);
      await confirmCreditPayment(ledger, invoice, input.txHash);
      return json(res, 200, { ok: true, balanceUsd: Math.max(0, ledger.balance(account.id) / USD_SCALE) });
    }
    if (path === "/api/credits/wallet/challenge" && method === "POST") {
      if (auth.kind !== "session") throw creditError("Sign in before verifying a wallet.", 403);
      const { address } = challengeSchema.parse(await readBody(req));
      const now = Date.now();
      ledger.db.prepare("DELETE FROM credit_challenges WHERE expires_at<?").run(now);
      if (Number(ledger.db.prepare("SELECT COUNT(*) AS n FROM credit_challenges WHERE session_id=?").get(auth.session.id)?.n ?? 0) >= 5) throw creditError("Please use a recent verification request or wait five minutes.", 429);
      const id = randomUUID(), expiresAt = now + 300_000;
      const message = `Nation Team Chat wallet verification\nDomain: thenation.city\nAddress: ${address.toLowerCase()}\nSession: ${auth.session.id}\nNonce: ${id}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature only verifies your account. It authorizes no payments or allowances.`;
      ledger.db.prepare("INSERT INTO credit_challenges VALUES(?,?,?,?,?)").run(id, auth.session.id, address.toLowerCase(), message, expiresAt);
      return json(res, 200, { challengeId: id, message });
    }
    if (path === "/api/credits/wallet/verify" && method === "POST") {
      if (auth.kind !== "session") throw creditError("Sign in before verifying a wallet.", 403);
      const input = signatureSchema.parse(await readBody(req));
      const challenge = ledger.db.prepare("SELECT * FROM credit_challenges WHERE id=? AND session_id=? AND expires_at>?").get(input.challengeId, auth.session.id, Date.now());
      if (!challenge || !await verifyMessage({ address: String(challenge.address) as Hex, message: String(challenge.message), signature: input.signature as Hex })) throw creditError("Wallet verification failed.", 403);
      ledger.transaction(() => {
        const consumed = ledger.db.prepare("DELETE FROM credit_challenges WHERE id=? AND expires_at>?").run(input.challengeId, Date.now());
        if (!consumed.changes) throw creditError("Verification request expired.", 403);
        ledger.db.prepare("INSERT INTO credit_wallets VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET address=excluded.address").run(auth.session.id, challenge.address!);
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found" });
  };
}
