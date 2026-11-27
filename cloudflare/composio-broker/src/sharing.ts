// One person's desktop and their own Cloud reach the same connected apps: the desktop's installation mints a one-time
// code naming the Cloud's installation, the person's app carries it to that Cloud over the Cloud's owner session, and
// the Cloud's installation adopts the desktop's Composio user with it. Composio ties every connected account to one
// user, and a Session can use only its own user's accounts, so the two act as one user rather than listing two.
import { z } from "zod";

import { actingUser, json, listConnectedAccounts, readJsonBody, sha256, type InstallationRow } from "./common";

/** Long enough for one send to My Cloud, which mints and redeems a code within seconds. */
export const SHARE_TTL_MS = 10 * 60_000;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[0-9a-f]{64}$/;
const shareSchema = z.object({ for: z.string().regex(INSTALLATION_ID) }).strict();
const adoptSchema = z.object({ code: z.string().regex(CODE) }).strict();

/** Equal on two installations exactly when they reach the same connected accounts; never the user id itself. */
export async function userDigest(installation: Pick<InstallationRow, "composio_user_id" | "shared_user_id">) {
  return (await sha256(`omb-composio-user:${actingUser(installation)}`)).slice(0, 24);
}

/** GET /v1/me */
export async function me(installation: InstallationRow) {
  // Before migration 0004 the row has no shared_user_id column and nothing can be shared: no user, so a desktop tries none.
  if (!("shared_user_id" in installation)) return json({ installationId: installation.id });
  return json({ installationId: installation.id, user: await userDigest(installation), shared: Boolean(installation.shared_user_id) });
}

function randomCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function limited(installation: InstallationRow, env: Env) {
  return !(await env.SESSION_LIMITER.limit({ key: installation.id })).success;
}

/** POST /v1/installation/share {for}: a code only the named installation can redeem, once, within SHARE_TTL_MS. */
export async function shareUser(request: Request, installation: InstallationRow, env: Env, now = Date.now()) {
  const parsed = shareSchema.safeParse(await readJsonBody(request, 1024));
  if (!parsed.success) return json({ error: "send {for: <installation id>}" }, 400);
  const target = parsed.data.for;
  if (target === installation.id) return json({ error: "an installation already reaches its own connected apps" }, 400);
  if (await limited(installation, env)) return json({ error: "too many connected-app requests" }, 429);
  const exists = await env.DB.prepare("SELECT id FROM installations WHERE id = ? AND disabled_at IS NULL").bind(target).first<{ id: string }>();
  if (!exists) return json({ error: "no such installation" }, 404);
  const code = randomCode();
  const expiresAt = now + SHARE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_shares WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO user_shares (code_hash, from_installation, for_installation, composio_user_id, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256(code), installation.id, target, actingUser(installation), expiresAt),
  ]);
  return json({ code, expiresAt }, 201);
}

/**
 * POST /v1/installation/adopt {code}: from now on this installation acts as the user the code shares. Refused while it
 * has connected accounts of its own, which its Sessions could no longer use: they stay reachable, and the person
 * connects the shared apps here instead. Either way the code is spent.
 */
export async function adoptSharedUser(request: Request, installation: InstallationRow, env: Env, now = Date.now()): Promise<{ ok: boolean; response: Response }> {
  const refuse = (response: Response) => ({ ok: false, response });
  const parsed = adoptSchema.safeParse(await readJsonBody(request, 1024));
  if (!parsed.success) return refuse(json({ error: "send {code}" }, 400));
  if (await limited(installation, env)) return refuse(json({ error: "too many connected-app requests" }, 429));
  const share = await env.DB.prepare(
    "DELETE FROM user_shares WHERE code_hash = ? AND for_installation = ? RETURNING composio_user_id, expires_at",
  ).bind(await sha256(parsed.data.code), installation.id).first<{ composio_user_id: string; expires_at: number }>();
  if (!share || share.expires_at < now) return refuse(json({ error: "This sharing code is no longer valid." }, 404));
  if (share.composio_user_id === actingUser(installation)) {
    return { ok: true, response: json({ shared: true, user: await userDigest(installation) }) };
  }
  let own: Awaited<ReturnType<typeof listConnectedAccounts>>;
  try {
    own = await listConnectedAccounts(env, actingUser(installation), []);
  } catch {
    return refuse(json({ error: "Connected apps could not be checked. Try again later." }, 503));
  }
  const active = own.filter((account) => /^active$/i.test(account.status ?? ""));
  if (active.length) {
    const toolkits = [...new Set(active.map((account) => account.toolkit?.slug?.toLowerCase() ?? "").filter(Boolean))].sort();
    return refuse(json({ error: "This installation has connected apps of its own.", code: "has_connections", toolkits }, 409));
  }
  await env.DB.prepare("UPDATE installations SET shared_user_id = ?, session_id = NULL WHERE id = ?")
    .bind(share.composio_user_id, installation.id).run();
  const adopted = { ...installation, shared_user_id: share.composio_user_id };
  return { ok: true, response: json({ shared: true, user: await userDigest(adopted) }) };
}
