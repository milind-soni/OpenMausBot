// Erases one installation: what it holds in D1, and what it created at Composio. Composio goes first and the
// installation row last, so a failed Composio call leaves the token working for a retry.
import {
  ACCOUNT_ID,
  actingUser,
  composioRequest,
  json,
  listConnectedAccounts,
  upstreamError,
  type InstallationRow,
} from "./common";
import { deleteRemote, listRemoteInstances, otherBindings } from "./triggers";

/** Workers on the free plan get 50 subrequests and 50 D1 queries per request: a larger erase is finished by further calls. */
const DELETES_PER_CALL = 30;
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
      if (instance.user_id !== user) continue;
      if (deletes >= DELETES_PER_CALL) return "more";
      if (await otherBindings(env, installationId, instance.id, false) > 0) continue;
      const result = await deleteRemote(env, instance.id);
      if (typeof result === "object") return json({ error: result.error }, 502);
      deletes += 1;
    }
    for (const account of await listConnectedAccounts(env, user, [])) {
      if (!account.id || !ACCOUNT_ID.test(account.id) || account.user_id !== user) continue;
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
export async function eraseInstallation(installation: InstallationRow, env: Env) {
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
  console.log(JSON.stringify({ message: "installation erased", installationId: id }));
  return json({ erased: true, sharedUserKept: erasable.length < users.length });
}
