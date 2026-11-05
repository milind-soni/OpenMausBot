// A phone signed in to a MausBot account reaches that account's connected apps: the Cloud Admin signs a 24-hour grant
// naming the account and the phone's installation, and every installation bound to one account acts as the account's
// Composio user until its grant runs out.
import { z } from "zod";

import { base64Bytes, cloudGrantSchema, hmacKey } from "./app-events";
import { DAY_MS, json, readJsonBody, utcDay, utf8, type ConnectedAccountResponse, type InstallationRow } from "./common";
import { userDigest } from "./sharing";

export const ACCOUNT_GRANT = /^v1\.acct\.([A-Za-z0-9][A-Za-z0-9_-]{2,127})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;
/** The Admin mints 24-hour grants; 300 s covers its clock running ahead of ours. */
const MAX_GRANT_AHEAD_MS = DAY_MS + 300_000;
export const ACCOUNT_APP_LIMIT = 3;
const ACCOUNT_DAILY_TOOL_CALLS = 300;
export const PHONE_CONNECT_CALLBACK = "openmausbot://connected-apps/done";

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
  // One statement, so a revoke can never land between the checks and the write.
  const bound = await env.DB.prepare(
    `UPDATE installations SET account_id = ?2, account_until = ?3, shared_user_id = ?4,
       session_id = CASE WHEN account_id IS NULL THEN NULL ELSE session_id END
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

/** A 402 once the account has ACCOUNT_APP_LIMIT apps signed in besides `slug`; another sign-in to an app it has is fine. */
export function appLimitRefusal(accounts: ConnectedAccountResponse[], slug: string): Response | null {
  const apps = [...new Set(accounts.filter((account) => /^active$/i.test(account.status ?? ""))
    .map((account) => account.toolkit?.slug?.toLowerCase() ?? "").filter((app) => app && app !== slug))].sort();
  if (apps.length < ACCOUNT_APP_LIMIT) return null;
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
    return json({ error: "invalid JSON body" }, 400);
  }
  const calls = [messages].flat().filter((message) => (message as { method?: unknown } | null)?.method === "tools/call").length;
  if (!calls) return null;
  const configured = Number(env.ACCOUNT_DAILY_TOOL_CALLS);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : ACCOUNT_DAILY_TOOL_CALLS;
  // One statement, so the account's phones calling at once can never pass the cap together.
  const counted = calls <= limit && await env.DB.prepare(
    `INSERT INTO account_tool_calls (account_id, day, calls) VALUES (?1, ?2, ?3)
     ON CONFLICT (account_id) DO UPDATE SET
       calls = CASE WHEN day = excluded.day THEN calls + excluded.calls ELSE excluded.calls END, day = excluded.day
     WHERE day != excluded.day OR calls + excluded.calls <= ?4
     RETURNING calls`,
  ).bind(installation.account_id, utcDay(now), calls, limit).first();
  if (counted) return null;
  return json({ error: `A free MausBot account makes up to ${limit} app actions a day. Try again tomorrow, or get MausBot Cloud for more.`, code: "daily_limit" }, 429);
}
