// A phone signed in to a MausBot account reaches that account's connected apps: the Cloud Admin signs a 24-hour grant
// naming the account and the phone's installation, and every installation bound to one account acts as the account's
// Composio user until its grant runs out. When the Admin deletes the account it revokes it here: every installation
// acting as its user stops at once, and its sign-ins are deleted at Composio.
import { z } from "zod";

import { base64Bytes, cloudGrantSchema, hmacKey } from "./app-events";
import {
  composioRequest,
  connectedAccountsPageSchema,
  DAY_MS,
  json,
  readJsonBody,
  utcDay,
  utf8,
  type ConnectedAccountResponse,
  type InstallationRow,
} from "./common";
import { userDigest } from "./sharing";

export const ACCOUNT_GRANT = /^v1\.acct\.([A-Za-z0-9][A-Za-z0-9_-]{2,127})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;
/** The Admin mints 24-hour grants; 300 s covers its clock running ahead of ours. */
const MAX_GRANT_AHEAD_MS = DAY_MS + 300_000;
export const ACCOUNT_APP_LIMIT = 3;
const PENDING_LINK_MS = 15 * 60_000;
const ACCOUNT_DAILY_TOOL_CALLS = 300;
export const PHONE_CONNECT_CALLBACK = "openmausbot://connected-apps/done";
const REVOKE_TOLERANCE_S = 300;
const revokeSchema = z.object({ accountId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/) }).strict();

export function accountGrantMessage(accountId: string, installationId: string, exp: number) {
  return `omb-connected-apps-account:v1\n${accountId}\n${installationId}\n${exp}`;
}

/** `v1.acct.<account id>.<installation id>.<exp, unix s>.<base64url HMAC-SHA256(CLOUD_GRANT_SECRET, accountGrantMessage)>`,
 *  minted by the Cloud Admin for the signed-in account's phone. */
export async function verifyAccountGrant(grant: string, secret: string) {
  const match = ACCOUNT_GRANT.exec(grant);
  const signature = match ? base64Bytes(match[4], true) : null;
  if (!match || !signature) return null;
  const [, accountId, installationId] = match;
  const exp = Number(match[3]);
  const signed = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(accountGrantMessage(accountId, installationId, exp)));
  return signed ? { accountId, installationId, exp } : null;
}

export function accountUser(accountId: string) {
  return `omb_acct_${accountId}`;
}

export function accountLeaseLapsed(installation: Pick<InstallationRow, "account_id" | "account_until">, now: number) {
  return Boolean(installation.account_id) && (installation.account_until ?? 0) <= now;
}

/** PUT /v1/installation/account {grant}: binds this installation to the grant's account until the grant expires. */
export async function presentAccountGrant(request: Request, installation: InstallationRow, env: Env, now = Date.now()) {
  // Before migration 0006 the row has no account_id column.
  if (!env.CLOUD_GRANT_SECRET || !("account_id" in installation)) {
    return json({ error: "Connected apps for MausBot accounts are not set up on this service.", code: "unsupported" }, 503);
  }
  const parsed = cloudGrantSchema.safeParse(await readJsonBody(request, 1024).catch(() => null));
  const grant = parsed.success ? await verifyAccountGrant(parsed.data.grant, env.CLOUD_GRANT_SECRET) : null;
  if (!grant || grant.installationId !== installation.id || grant.exp * 1000 <= now || grant.exp * 1000 > now + MAX_GRANT_AHEAD_MS) {
    return json({ error: "This grant isn't valid. Ask MausBot for a new one.", code: "invalid_grant" }, 403);
  }
  const user = accountUser(grant.accountId);
  // One statement, so a revoke can never land between the checks and the write. A fresh Session each bind, so one
  // created with connection management on never survives.
  const bound = await env.DB.prepare(
    `UPDATE installations SET account_id = ?2, account_until = ?3, shared_user_id = ?4, session_id = NULL
     WHERE id = ?1 AND disabled_at IS NULL AND (account_id IS NULL OR account_id = ?2)
       AND NOT EXISTS (SELECT 1 FROM revoked_accounts WHERE account_id = ?2)`,
  ).bind(installation.id, grant.accountId, grant.exp * 1000, user).run();
  if (!bound.meta.changes) {
    const [current, revoked] = await Promise.all([
      env.DB.prepare("SELECT account_id, disabled_at FROM installations WHERE id = ?").bind(installation.id)
        .first<Pick<InstallationRow, "account_id" | "disabled_at">>(),
      env.DB.prepare("SELECT 1 AS revoked FROM revoked_accounts WHERE account_id = ?").bind(grant.accountId).first(),
    ]);
    if (revoked) return json({ error: "This MausBot account was deleted.", code: "account_revoked" }, 403);
    if (current?.disabled_at === null && current.account_id !== grant.accountId) {
      return json({ error: "This installation belongs to another MausBot account.", code: "account_mismatch" }, 409);
    }
    return json({ error: "unauthorized" }, 401);
  }
  return json({ accountUntil: grant.exp * 1000, appLimit: ACCOUNT_APP_LIMIT, user: await userDigest({ ...installation, shared_user_id: user }) });
}

/** Records the sign-in link the account opens for `slug`, or answers 402 when its working apps (`accounts`) and the links
 *  it opened in the last 15 minutes already make ACCOUNT_APP_LIMIT other apps. An app it has or has opened stays allowed. */
export async function reserveAppLink(env: Env, accountId: string, accounts: ConnectedAccountResponse[], slug: string, now = Date.now()) {
  const active = [...new Set(accounts.filter((account) => /^active$/i.test(account.status ?? ""))
    .map((account) => account.toolkit?.slug?.toLowerCase() ?? "").filter(Boolean))];
  const since = now - PENDING_LINK_MS;
  // One statement, so the account's phones opening different apps at once can never pass the allowance together.
  const reserved = await env.DB.prepare(
    `WITH apps(toolkit) AS (SELECT value FROM json_each(?4) UNION SELECT toolkit FROM account_links WHERE account_id = ?1 AND minted_at > ?5)
     INSERT INTO account_links (account_id, toolkit, minted_at)
     SELECT ?1, ?2, ?3 WHERE ?2 IN (SELECT toolkit FROM apps) OR (SELECT COUNT(*) FROM apps) < ?6
     ON CONFLICT (account_id, toolkit) DO UPDATE SET minted_at = excluded.minted_at
     RETURNING toolkit`,
  ).bind(accountId, slug, now, JSON.stringify(active), since, ACCOUNT_APP_LIMIT).first();
  if (reserved) return null;
  const { results: pending } = await env.DB.prepare("SELECT toolkit FROM account_links WHERE account_id = ? AND minted_at > ?")
    .bind(accountId, since).all<{ toolkit: string }>();
  const apps = [...new Set([...active, ...pending.map((link) => link.toolkit)])].sort();
  return json({
    error: "A free MausBot account connects up to 3 apps. Disconnect one, or get MausBot Cloud for more.",
    code: "app_limit",
    limit: ACCOUNT_APP_LIMIT,
    apps,
  }, 402);
}

/** Counts a bound installation's MCP tool calls against its account's UTC day, shared by all the account's phones; a
 *  429 once they would pass the cap. */
export async function accountToolCallRefusal(body: Uint8Array, installation: InstallationRow, env: Env, now = Date.now()) {
  if (!installation.account_id) return null;
  let messages: unknown;
  try {
    messages = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // Forwarded unparsed, a body Composio reads differently could run a call we never counted.
    return json({ error: "This request isn't valid JSON.", code: "invalid_request" }, 400);
  }
  const calls = [messages].flat().filter((message) => (message as { method?: unknown } | null)?.method === "tools/call").length;
  if (!calls) return null;
  const configured = Number(env.ACCOUNT_DAILY_TOOL_CALLS);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : ACCOUNT_DAILY_TOOL_CALLS;
  // One statement, so the account's phones calling at once can never pass the cap together. The day only moves forward:
  // a call from an isolate whose clock is behind counts toward the newer day.
  const counted = calls <= limit && await env.DB.prepare(
    `INSERT INTO account_tool_calls (account_id, day, calls) VALUES (?1, ?2, ?3)
     ON CONFLICT (account_id) DO UPDATE SET
       calls = CASE WHEN excluded.day > day THEN excluded.calls ELSE calls + excluded.calls END, day = MAX(day, excluded.day)
     WHERE excluded.day > day OR calls + excluded.calls <= ?4
     RETURNING calls`,
  ).bind(installation.account_id, utcDay(now), calls, limit).first();
  if (counted) return null;
  return json({ error: `A free MausBot account makes up to ${limit} connected-app tool calls a day. Try again tomorrow, or get MausBot Cloud for more.`, code: "daily_limit" }, 429);
}

export function revokeMessage(timestamp: number, accountId: string) {
  return `omb-connected-apps-revoke:v1\n${timestamp}\n${accountId}`;
}

/** POST /v1/accounts/revoke {accountId}, sent by the Cloud Admin when it deletes the account, with
 *  `x-omb-revoke-timestamp: <unix s>` and `x-omb-revoke-signature: v1=<base64url HMAC-SHA256(CLOUD_GRANT_SECRET,
 *  revokeMessage)>`. A replay within the 300 s window repeats the same revoke. */
export async function revokeAccount(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">, now = Date.now()) {
  if (!env.CLOUD_GRANT_SECRET) return json({ error: "Account revocation is not set up on this service.", code: "unsupported" }, 503);
  const unauthorized = () => json({ error: "unauthorized" }, 401);
  const timestamp = request.headers.get("x-omb-revoke-timestamp") ?? "";
  const signature = /^v1=([A-Za-z0-9_-]{43})$/.exec(request.headers.get("x-omb-revoke-signature") ?? "")?.[1];
  const bytes = signature ? base64Bytes(signature, true) : null;
  if (!bytes || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > REVOKE_TOLERANCE_S) return unauthorized();
  const parsed = revokeSchema.safeParse(await readJsonBody(request, 1024).catch(() => null));
  if (!parsed.success) return unauthorized();
  const { accountId } = parsed.data;
  const message = utf8(revokeMessage(Number(timestamp), accountId));
  if (!await crypto.subtle.verify("HMAC", await hmacKey(env.CLOUD_GRANT_SECRET), bytes, message)) return unauthorized();
  // Bound phones carry account_id; a Cloud that adopted the account's user through a share code (and anything that
  // adopted from it) carries only shared_user_id. One transaction with the revoked_accounts row, so a bind either lands
  // before it and is disabled here, or after it and is refused.
  const theirs = "SELECT id FROM installations WHERE account_id = ?1 OR shared_user_id = ?2";
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(accountId, now),
    ...["events", "trigger_bindings", "event_drops"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE installation_id IN (${theirs})`).bind(accountId, accountUser(accountId))),
    env.DB.prepare(`DELETE FROM user_shares WHERE from_installation IN (${theirs}) OR for_installation IN (${theirs})`)
      .bind(accountId, accountUser(accountId)),
    env.DB.prepare(
      "UPDATE installations SET disabled_at = ?3, session_id = NULL WHERE (account_id = ?1 OR shared_user_id = ?2) AND disabled_at IS NULL",
    ).bind(accountId, accountUser(accountId), now),
  ]);
  const installations = results.at(-1)?.meta.changes ?? 0;
  console.log(JSON.stringify({ message: "account revoked", accountId, installations }));
  ctx.waitUntil(clearRevokedAccounts(env, now));
  return json({ revoked: true, installations }, 202);
}

/** Deletes at Composio the sign-ins of four revoked accounts not yet cleared, the ones tried longest ago first, with at
 *  most `budget` requests: the Workers free plan allows 50 subrequests per invocation, and the hourly sweep may take 40.
 *  One page of 50 per account, so a listing costs exactly one; an account with more is finished over later runs. */
export async function clearRevokedAccounts(env: Env, now = Date.now(), budget = 8) {
  const { results } = await env.DB.prepare(
    "SELECT account_id FROM revoked_accounts WHERE cleared_at IS NULL ORDER BY COALESCE(attempted_at, 0), revoked_at LIMIT 4",
  ).all<{ account_id: string }>().catch((error: unknown) => {
    const why = error instanceof Error ? error.message : String(error);
    // Before migration 0006 there is no revoked_accounts table, and the hourly run beside this must still finish.
    if (!why.includes("no such table")) console.warn(JSON.stringify({ message: "revoked account cleanup failed", status: null, error: why }));
    return { results: [] };
  });
  for (const { account_id: accountId } of results) {
    if (budget < 1) return;
    const failed = (status: number | null) => console.warn(JSON.stringify({ message: "revoked account cleanup failed", accountId, status }));
    try {
      await env.DB.prepare("UPDATE revoked_accounts SET attempted_at = ? WHERE account_id = ?").bind(now, accountId).run();
      budget -= 1;
      const listed = await composioRequest(env, `/connected_accounts?${new URLSearchParams({ limit: "50", user_ids: accountUser(accountId) })}`);
      if (!listed.ok) {
        failed(listed.status);
        continue;
      }
      const items = connectedAccountsPageSchema.parse(await listed.json()).items;
      if (!items.length) {
        await env.DB.prepare("UPDATE revoked_accounts SET cleared_at = ? WHERE account_id = ?").bind(now, accountId).run();
        continue;
      }
      // Never another person's sign-in, even if Composio ignored user_ids; such a listing also never clears the account.
      const ids = items.flatMap((account) => account.user_id === accountUser(accountId) && account.id ? [account.id] : []);
      const skipped = items.filter((account) => account.user_id !== accountUser(accountId)).length;
      if (skipped) console.warn(JSON.stringify({ message: "revoked account cleanup skipped another user's sign-ins", skipped }));
      for (const id of ids.slice(0, budget)) {
        budget -= 1;
        const removed = await composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE" });
        await removed.body?.cancel();
        // 404: another run deleted it first.
        if (!removed.ok && removed.status !== 404) failed(removed.status);
      }
    } catch {
      failed(null);
    }
  }
}
