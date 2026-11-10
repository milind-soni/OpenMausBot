// Erases one installation: what it holds in D1, and what it created at Composio. Composio goes first and the
// installation row last, so a failed Composio call leaves the token working for a retry.
import { z } from "zod";

import { base64Bytes, hmacKey, SIGNATURE_TOLERANCE_S } from "./app-events";
import {
  ACCOUNT_ID,
  actingUser,
  composioRequest,
  json,
  listConnectedAccounts,
  readBoundedBody,
  upstreamError,
  utf8,
  type InstallationRow,
} from "./common";
import { deleteRemote, listRemoteInstances, otherBindings } from "./triggers";

/** Workers on the free plan get 50 subrequests and 50 D1 queries per request: a larger erase is finished by further calls. */
const DELETES_PER_CALL = 30;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const STAFF_ERASE_SIGNATURE = /^v1=([A-Za-z0-9_-]{43})$/;
const staffEraseSchema = z.union([
  z.object({ installationId: z.string().regex(INSTALLATION_ID) }).strict(),
  z.object({ machineId: z.string().regex(MACHINE_ID) }).strict(),
]);

export function staffEraseMessage(timestamp: string, body: string) {
  return `omb-broker-erase:v1\n${timestamp}\n${body}`;
}

/** The users among `users` no other live installation acts as. Only their connected accounts may be deleted: a desktop
 *  and its Cloud that share a Composio user lose each other's apps otherwise. */
async function usersNoOneElseActsAs(env: Env, installationId: string, users: string[]) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT COALESCE(shared_user_id, composio_user_id) AS user FROM installations
     WHERE id != ?1 AND disabled_at IS NULL AND COALESCE(shared_user_id, composio_user_id) IN (?2, ?3)`,
  ).bind(installationId, users[0], users[users.length - 1]).all<{ user: string }>();
  const inUse = new Set(results.map((row) => row.user));
  return users.filter((user) => !inUse.has(user));
}

async function removeBoundTriggers(env: Env, installationId: string) {
  const { results } = await env.DB.prepare(
    `SELECT b.composio_trigger_id AS id, EXISTS (
       SELECT 1 FROM trigger_bindings o WHERE o.composio_trigger_id = b.composio_trigger_id AND o.installation_id != b.installation_id
     ) AS shared
     FROM trigger_bindings b WHERE b.installation_id = ? ORDER BY b.composio_trigger_id LIMIT ?`,
  ).bind(installationId, DELETES_PER_CALL).all<{ id: string; shared: number }>();
  const removed: string[] = [];
  let failure: string | undefined;
  for (const { id, shared } of results) {
    const result = shared ? "done" : await deleteRemote(env, id);
    if (typeof result === "object") {
      failure = result.error;
      break;
    }
    removed.push(id);
  }
  if (removed.length) {
    await env.DB.prepare(`DELETE FROM trigger_bindings WHERE installation_id = ?1 AND composio_trigger_id IN (${removed.map((_, index) => `?${index + 2}`).join(", ")})`)
      .bind(installationId, ...removed).run();
  }
  return { failure, more: results.length === DELETES_PER_CALL, deletes: results.filter((row) => !row.shared).length };
}

/** "done", "more" when this call's allowance ran out, or the 502 to answer with. */
async function eraseAtComposio(env: Env, installationId: string, users: string[]): Promise<"done" | "more" | Response> {
  const bound = await removeBoundTriggers(env, installationId);
  if (bound.failure) return json({ error: bound.failure }, 502);
  if (bound.more) return "more";
  let deletes = bound.deletes;
  for (const user of users) {
    for (const instance of await listRemoteInstances(env, user)) {
      if (deletes >= DELETES_PER_CALL) return "more";
      if (await otherBindings(env, installationId, instance.id, false) > 0) continue;
      const result = await deleteRemote(env, instance.id);
      if (typeof result === "object") return json({ error: result.error }, 502);
      deletes += 1;
    }
    for (const account of await listConnectedAccounts(env, user, [])) {
      if (!account.id || !ACCOUNT_ID.test(account.id) || (account.user_id && account.user_id !== user)) continue;
      if (deletes >= DELETES_PER_CALL) return "more";
      const response = await composioRequest(env, `/connected_accounts/${encodeURIComponent(account.id)}?revoke_on_delete=true`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        return json({ error: await upstreamError(response, `Composio could not delete a connected account (${response.status})`) }, 502);
      }
      await response.body?.cancel();
      deletes += 1;
    }
  }
  return "done";
}

/** 200 once nothing is left and the token is dead; 202 to call again; an error leaves the token working. */
export async function eraseInstallation(installation: InstallationRow, env: Env, by: "owner" | "staff") {
  const { id } = installation;
  // Before the check below: a code still out could hand a user being erased to another installation.
  await env.DB.prepare("DELETE FROM user_shares WHERE from_installation = ?1 OR for_installation = ?1").bind(id).run();
  const users = [...new Set([actingUser(installation), installation.composio_user_id])];
  const erasable = await usersNoOneElseActsAs(env, id, users);
  if (erasable.length) {
    await env.DB.prepare("DELETE FROM user_shares WHERE composio_user_id IN (?1, ?2)").bind(erasable[0], erasable[erasable.length - 1]).run();
  }
  const outcome = await eraseAtComposio(env, id, erasable);
  if (outcome === "more") return json({ erased: false, more: true }, 202);
  if (outcome !== "done") return outcome;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM trigger_bindings WHERE installation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM events WHERE installation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM event_drops WHERE installation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM app_event_days WHERE installation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_shares WHERE from_installation = ?1 OR for_installation = ?1").bind(id),
    env.DB.prepare("DELETE FROM installations WHERE id = ?").bind(id),
  ]);
  console.log(JSON.stringify({ message: "installation erased", installationId: id, by }));
  return json({ erased: true, sharedUserKept: erasable.length < users.length });
}

/** POST /v1/admin/erase {installationId} or {machineId}, for a customer who asks us to: signed with CLOUD_GRANT_SECRET
 *  over staffEraseMessage(timestamp, body), which the secret's other uses never sign. */
export async function staffErase(request: Request, env: Env, now = Date.now()) {
  const secret = env.CLOUD_GRANT_SECRET;
  if (!secret) return json({ error: "not found" }, 404);
  const timestamp = request.headers.get("x-omb-admin-timestamp") ?? "";
  const signature = base64Bytes(request.headers.get("x-omb-admin-signature")?.match(STAFF_ERASE_SIGNATURE)?.[1] ?? "", true);
  if (!signature || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) {
    return json({ error: "unauthorized" }, 401);
  }
  const bytes = await readBoundedBody(request, 1024);
  if (!bytes) return json({ error: "request body is too large" }, 413);
  const raw = new TextDecoder().decode(bytes);
  if (!await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(staffEraseMessage(timestamp, raw)))) {
    return json({ error: "unauthorized" }, 401);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const parsed = staffEraseSchema.safeParse(value);
  if (!parsed.success) return json({ error: "send {installationId} or {machineId}" }, 400);
  const target = parsed.data;
  const installation = "installationId" in target
    ? await env.DB.prepare("SELECT * FROM installations WHERE id = ?").bind(target.installationId).first<InstallationRow>()
    : await env.DB.prepare("SELECT * FROM installations WHERE cloud_machine_id = ?").bind(target.machineId).first<InstallationRow>();
  if (!installation) return json({ error: "no such installation" }, 404);
  return eraseInstallation(installation, env, "staff");
}
