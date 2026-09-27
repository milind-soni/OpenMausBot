// Public sign-up on the founder's server, through the real HTTP API:
//   - an emailed one-time link signs a stranger in and creates a workspace of
//     their own, served by its own server over its own data directory;
//   - two accounts never see each other's bots, conversations or credit, and
//     neither sees the founder's desk; the founder still signs in to the desk;
//   - a new account is on the free plan with its starter credit, and its
//     Starter invoice pays the founder treasury on Robinhood Chain from the
//     one shared ledger, here from its own passkey-held NATION wallet, and
//     the public server's payment scan credits it;
//   - the account saves its own welcome-tour progress, and nothing else of
//     the workspace's configuration;
//   - an account cookie never falls through to the desk: a stale one, a
//     cross-site one and forged owner headers are all refused.
// Every external service is an owned loopback stand-in.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeRobinhoodChain } from "./testing/fake-robinhood-chain.ts";
import { startFakeTurnkey } from "./testing/fake-turnkey.ts";

const FOUNDER = "founder@example.test";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const TREASURY = "0x85E3C2D8f776d9D05b14E108F368070CbD8C1639";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const accountId = (email: string) => "email:" + createHash("sha256").update(email).digest("hex");
const CREDENTIAL = "fixture-passkey-" + "A".repeat(32);
const ATTESTATION = { challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZQ", attestation: { credentialId: CREDENTIAL, clientDataJson: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0", attestationObject: "o2NmbXRkbm9uZWdhdHRTdG10oA", transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"] } };
/** What the browser's passkey returns for a wallet request body. */
const passkeyStamp = (body: string) => JSON.stringify({
  authenticatorData: "AAAA", credentialId: CREDENTIAL, signature: "BBBB",
  clientDataJson: Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(createHash("sha256").update(body).digest("hex"), "utf8").toString("base64url"), origin: "https://thenation.city" })).toString("base64url"),
});

type Reply = { status: number; body: any; text: string };

/** One browser: its own cookie jar, and the Origin a page on the app sends. */
function browser(base: string) {
  const jar = new Map<string, string>();
  const request = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Reply> => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.origin === null ? {} : { origin: init.origin ?? base }),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      if (attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name);
      else jar.set(name, pair!.slice(eq + 1).trim());
    }
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: response.status, body, text };
  };
  return { jar, request };
}

it("gives every email its own workspace and keeps the founder desk out of reach", async () => {
  const prompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (String(req.url).endsWith("/chat/completions")) {
      prompts.push(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "Hello from your teammate." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const chain = await startFakeRobinhoodChain();
  const turnkey = await startFakeTurnkey();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    `http://127.0.0.1:${(provider.address() as { port: number }).port}`, undefined, undefined, undefined, {
      founderEmails: [FOUNDER],
      payments: { rpc: chain.url, treasury: TREASURY, confirmations: 1, scanSeconds: 5 },
      turnkey: { url: turnkey.url, organizationId: turnkey.organizationId, apiPublicKey: turnkey.apiPublicKey, apiPrivateKey: turnkey.apiPrivateKey },
    });
  const base = fixture.info.url;
  const outbox = join(fixture.info.dataDir, "mail-outbox");
  const linkFor = (email: string): string => {
    const files = existsSync(outbox) ? readdirSync(outbox).sort() : [];
    for (const file of files.reverse()) {
      const message = JSON.parse(readFileSync(join(outbox, file), "utf8"));
      if (message.to === email) return message.link as string;
    }
    throw new Error(`no sign-in email for ${email}`);
  };
  const signIn = async (who: ReturnType<typeof browser>, email: string) => {
    expect((await who.request("/api/auth/magic/start", { method: "POST", body: { email } })).status).toBe(200);
    const link = linkFor(email);
    expect(link.startsWith(`${base}/#login=nml_`)).toBe(true);
    const token = decodeURIComponent(link.split("#login=")[1]!);
    expect((await who.request("/api/auth/magic/peek", { method: "POST", body: { token } })).body).toEqual({ email });
    const verified = await who.request("/api/auth/magic/verify", { method: "POST", body: { token, label: "Fixture browser" } });
    expect(verified.status, verified.text).toBe(200);
    return { token, verified: verified.body };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    expect(response.status, `${method} ${path} ${text}`).toBeLessThan(300);
    return text ? JSON.parse(text) : {};
  };

  try {
    // The founder's desk already has teammates and history.
    // Names no starter teammate can be given (server/names.ts picks from a pool).
    const echo = (await owner("/api/bots", "POST", { name: "Desk Echo" })).bot;
    await owner("/api/bots", "POST", { name: "Desk Pebble" });
    const founderBots = (await owner("/api/bots")).bots as Array<{ id: string; name: string; threadId: string }>;
    expect(founderBots.map((bot) => bot.name)).toEqual(expect.arrayContaining(["Desk Echo", "Desk Pebble"]));
    const founderIds = new Set(founderBots.flatMap((bot) => [bot.id, bot.threadId]));

    // The environment tells the app to show email sign-in.
    const environment = await (await fetch(`${base}/.well-known/nationteamchat/environment`)).json() as any;
    expect(environment.capabilities.accountSignIn).toBe(true);

    // 1. Alice: a link, then her own new workspace.
    const alice = browser(base);
    const aliceLink = await signIn(alice, ALICE);
    expect(aliceLink.verified).toEqual({ ok: true, destination: "workspace", created: true });
    expect(alice.jar.has("nation_account")).toBe(true);
    // The link worked once.
    expect((await alice.request("/api/auth/magic/verify", { method: "POST", body: { token: aliceLink.token } })).status).toBe(401);
    // The app opens its event stream as it loads. A first look at a teammate
    // then creates this account's own conversation with it: exactly one, even
    // while the stream is being told about it.
    const events = new AbortController();
    const stream = await fetch(`${base}/api/events`, { headers: { cookie: [...alice.jar].map(([name, value]) => `${name}=${value}`).join("; "), origin: base }, signal: events.signal });
    expect(stream.status).toBe(200);
    void stream.body?.pipeTo(new WritableStream()).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const aliceSession = (await alice.request("/api/auth/session")).body;
    expect(aliceSession).toMatchObject({ kind: "session", scopes: ["client"], email: ALICE });
    const aliceBots = await alice.request("/api/bots");
    expect(aliceBots.status, aliceBots.text).toBe(200);
    const aliceNames = aliceBots.body.bots.map((bot: any) => bot.name);
    expect(aliceNames).not.toContain("Desk Echo");
    expect(aliceNames).not.toContain("Desk Pebble");
    // Not one teammate or conversation id in common with the desk.
    expect(aliceBots.body.bots.flatMap((bot: any) => [bot.id, bot.threadId]).filter((id: string) => founderIds.has(id))).toEqual([]);
    // (The first answer was built before that conversation existed; the next one lists it.)
    const onceMore = (await alice.request("/api/bots")).body.bots;
    expect(onceMore.map((bot: any) => (bot.tasks ?? []).length)).toEqual([1]);
    expect(onceMore[0].threadId).toBe(onceMore[0].tasks[0].threadId);
    events.abort();
    // …served by another process than the desk
    const health = await alice.request("/api/health");
    expect(health.body.app).toBe("nation-team-chat");
    expect(health.body.pid).not.toBe(fixture.info.pid);

    // 4. Free plan, starter credit, never exempt.
    const credits = await alice.request("/api/credits/status");
    expect(credits.status, credits.text).toBe(200);
    expect(credits.body).toMatchObject({ exempt: false, onFreePlan: true, plan: "free", starterCreditUsd: 3, starterGranted: true, verified: true });
    expect(credits.body.balanceUsd).toBe(3);
    // A Starter invoice in USDG pays the founder treasury on Robinhood Chain.
    const invoice = await alice.request("/api/credits/invoices", { method: "POST", body: { chain: 4663, packUsd: 15, token: USDG } });
    expect(invoice.status, invoice.text).toBe(201);
    expect(invoice.body).toMatchObject({ chain: 4663, treasury: TREASURY, symbol: "USDG" });
    expect(Number(invoice.body.amount)).toBeGreaterThanOrEqual(15);
    expect(Number(invoice.body.amount)).toBeLessThan(16);

    // Her first-run progress is hers to save; the rest of the configuration is not.
    const config = (await alice.request("/api/config")).body;
    expect(config).toMatchObject({ isProductOwner: false, personalWorkspace: true, onboarding: { completedAt: "" } });
    const completedAt = new Date().toISOString();
    const saved = await alice.request("/api/workspace/preferences", { method: "PATCH", body: { onboarding: { completedAt, version: 1 }, profile: { name: "Alice" } } });
    expect(saved.status, saved.text).toBe(200);
    expect((await alice.request("/api/config")).body).toMatchObject({ onboarding: { completedAt, version: 1 }, profile: { name: "Alice" } });
    expect((await alice.request("/api/workspace/preferences", { method: "PATCH", body: { signIn: { admins: [ALICE] } } })).status).toBe(400);
    expect((await alice.request("/api/config", { method: "PUT", body: { onboarding: { completedAt } } })).status).toBe(403);

    // Her own teammate, and a conversation with it.
    const scout = (await alice.request("/api/bots", { method: "POST", body: { name: "Alice Scout" } })).body.bot;
    expect(scout?.name).toBe("Alice Scout");
    const sent = await alice.request(`/api/bots/${scout.id}/messages`, { method: "POST", body: { text: "Plan my launch week" } });
    expect(sent.status, sent.text).toBeLessThan(300);
    await expect.poll(async () => {
      const messages = (await alice.request(`/api/threads/${scout.threadId}/messages`)).body.messages ?? [];
      return messages.some((message: any) => message.role === "bot" && /Hello from your teammate/.test(message.text ?? ""));
    }, { timeout: 30_000, interval: 250 }).toBe(true);
    expect(prompts.join("\n")).toContain("Plan my launch week");

    // The Starter invoice, paid from her own NATION wallet: a passkey creates
    // it, she funds it, the passkey approves exactly this transfer, and the
    // public server's payment scan credits her account in the shared ledger.
    expect((await alice.request("/api/credits/wallet/embedded")).body).toEqual({ available: true, wallet: null });
    const created = await alice.request("/api/credits/wallet/embedded", { method: "POST", body: ATTESTATION });
    expect(created.status, created.text).toBe(201);
    const walletAddress = created.body.wallet.address as string;
    chain.fund(USDG, walletAddress, BigInt(Math.round(Number(invoice.body.amount) * 1e6)));
    chain.fundEth(walletAddress, 10n ** 16n);
    const prepared = await alice.request("/api/credits/wallet/embedded/prepare", { method: "POST", body: { invoiceId: invoice.body.id } });
    expect(prepared.status, prepared.text).toBe(200);
    const paid = await alice.request("/api/credits/wallet/embedded/pay", { method: "POST", body: { invoiceId: invoice.body.id, body: prepared.body.body, stamp: passkeyStamp(prepared.body.body) } });
    expect(paid.status, paid.text).toBe(200);
    expect(chain.balance(USDG, TREASURY)).toBe(BigInt(Math.round(Number(invoice.body.amount) * 1e6)));
    await expect.poll(async () => (await alice.request("/api/credits/status")).body.plan, { timeout: 30_000, interval: 500 }).toBe("paid");
    const afterPayment = (await alice.request("/api/credits/status")).body;
    expect(afterPayment).toMatchObject({ onFreePlan: false, exempt: false });
    expect(afterPayment.balanceUsd).toBeGreaterThan(15);
    expect(afterPayment.invoices.find((row: any) => row.id === invoice.body.id)?.paid_tx).toBe(paid.body.txHash);
    expect(turnkey.requests.map((request) => request.stamp)).toEqual(["api-key", "passkey"]);

    // 2. Bob: his own workspace, none of Alice's.
    const bob = browser(base);
    expect((await signIn(bob, BOB)).verified).toEqual({ ok: true, destination: "workspace", created: true });
    const bobBots = (await bob.request("/api/bots")).body.bots.map((bot: any) => bot.name);
    expect(bobBots).not.toContain("Alice Scout");
    expect(bobBots).not.toContain("Desk Echo");
    expect((await bob.request(`/api/threads/${scout.threadId}/messages`)).status).toBe(404);
    expect((await bob.request(`/api/bots/${scout.id}/messages`, { method: "POST", body: { text: "hi" } })).status).toBe(404);
    const bobCredits = (await bob.request("/api/credits/status")).body;
    expect(bobCredits.invoices).toEqual([]);
    expect(bobCredits.onFreePlan).toBe(true);
    // …nor her wallet, nor her invoice.
    expect((await bob.request("/api/credits/wallet/embedded")).body.wallet).toBeNull();
    expect((await bob.request("/api/credits/wallet/embedded/prepare", { method: "POST", body: { invoiceId: invoice.body.id } })).status).toBe(404);
    // Bob can reach neither the desk's teammates nor its admin routes.
    expect((await bob.request(`/api/threads/${echo.threadId}/messages`)).status).toBe(404);
    expect((await bob.request("/api/admin/credits")).status).toBe(403);
    expect((await bob.request("/api/config", { method: "PUT", body: { profile: { name: "Bob" } } })).status).toBe(403);
    // Forged owner and proxy headers change nothing.
    const forged = await bob.request("/api/admin/credits", { headers: { "x-openmausbot-desktop-owner": "1", "x-forwarded-for": "127.0.0.1", "x-nation-workspace-key": "forged" } });
    expect(forged.status).toBe(403);
    // A page on another site cannot ride Bob's cookie.
    expect((await bob.request("/api/bots", { origin: "https://evil.example" })).status).toBe(403);

    // Separate data roots: each workspace holds only its own teammates.
    const roots = readdirSync(join(fixture.info.dataDir, "workspaces")).filter((name) => name.startsWith("ws_"));
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(readFileSync(join(fixture.info.dataDir, "workspaces", root, "logs", "server.log"), "utf8")).not.toMatch(/change listener threw|ReferenceError|Maximum call stack/);
    }
    const holding = (text: string) => roots.filter((name) => {
      const file = join(fixture.info.dataDir, "workspaces", name, "bots.json");
      return existsSync(file) && readFileSync(file, "utf8").includes(text);
    });
    expect(holding("Alice Scout")).toHaveLength(1);
    expect(holding("Desk Echo")).toHaveLength(0);
    expect(holding(echo.id)).toHaveLength(0);
    expect(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).not.toContain("Alice Scout");

    // One ledger for everyone: Alice's invoice, on Alice's account.
    const ledger = new DatabaseSync(join(fixture.info.dataDir, "nation-credits.db"), { readOnly: true });
    try {
      const rows = ledger.prepare("SELECT user_id, chain, treasury FROM credit_invoices").all();
      expect(rows).toEqual([{ user_id: accountId(ALICE), chain: 4663, treasury: TREASURY.toLowerCase() }]);
    } finally {
      ledger.close();
    }

    // 3. The founder can switch an existing member browser to the desk.
    const founder = browser(base);
    founder.jar.set("nation_account", alice.jar.get("nation_account")!);
    expect((await founder.request("/api/config")).body.isProductOwner).toBe(false);
    expect((await signIn(founder, FOUNDER)).verified).toEqual({ ok: true, destination: "desk" });
    expect(founder.jar.has("nation_account")).toBe(false);
    expect((await founder.request("/api/config")).body.isProductOwner).toBe(true);
    const founderSession = (await founder.request("/api/auth/session")).body;
    expect(founderSession.scopes).toContain("admin");
    const deskNames = (await founder.request("/api/bots")).body.bots.map((bot: any) => bot.name);
    expect(deskNames).toEqual(expect.arrayContaining(["Desk Echo", "Desk Pebble"]));
    expect(deskNames).not.toContain("Alice Scout");
    expect((await founder.request("/api/credits/status")).body.exempt).toBe(true);

    // A stale account cookie never falls through to the desk, not even on loopback.
    const stale = browser(base);
    stale.jar.set("nation_account", "nas_" + "A".repeat(43));
    const refused = await stale.request("/api/bots", { origin: null });
    expect(refused.status).toBe(401);
    expect(refused.text).not.toContain("Desk Echo");

    // Signing out ends the account session.
    expect((await alice.request("/api/auth/logout", { method: "POST", body: {} })).status).toBe(200);
    expect(alice.jar.has("nation_account")).toBe(false);
    const again = browser(base);
    again.jar.set("nation_account", "gone");
    expect((await again.request("/api/bots")).status).toBe(401);
  } finally {
    await fixture.close();
    await new Promise((resolve) => provider.close(resolve));
    await chain.close();
    await turnkey.close();
  }
}, 180_000);
