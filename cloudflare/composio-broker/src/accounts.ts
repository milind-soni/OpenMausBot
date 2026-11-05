// A phone signed in to a MausBot account reaches that account's connected apps: the Cloud Admin signs a 24-hour grant
// naming the account and the phone's installation, and every installation bound to one account acts as the account's
// Composio user until its grant runs out.
import { z } from "zod";

import { base64Bytes, hmacKey } from "./app-events";
import { json, readJsonBody, utf8, type InstallationRow } from "./common";
import { userDigest } from "./sharing";

export const ACCOUNT_GRANT = /^v1\.acct\.([A-Za-z0-9][A-Za-z0-9_-]{2,127})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;
const grantSchema = z.object({ grant: z.string().max(256) }).strict();

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
  const parsed = grantSchema.safeParse(await readJsonBody(request, 1024).catch(() => null));
  const grant = parsed.success ? await verifyAccountGrant(parsed.data.grant, env.CLOUD_GRANT_SECRET) : null;
  if (!grant || grant.installationId !== installation.id || grant.exp * 1000 <= now) {
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
  return json({ accountUntil: grant.exp * 1000, appLimit: 3, user: await userDigest({ ...installation, shared_user_id: user }) });
}
