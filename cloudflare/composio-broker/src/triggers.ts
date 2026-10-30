import { z } from "zod";

import {
  ACCOUNT_ID,
  actingUser,
  composioRequest,
  eventLimits,
  json,
  listConnectedAccounts,
  readJsonBody,
  upstreamError,
  utcDay,
  type EventInstallation,
} from "./common";

export const TRIGGER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const TRIGGER_SLUG = /^[A-Za-z0-9_]{1,128}$/;
const TOOLKIT_SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/;
/** Keeps one catalog request under the free plan's 50 subrequests. */
const MAX_TYPE_TOOLKITS = 10;
const MAX_TYPE_PAGES = 4;
const MAX_INSTANCE_PAGES = 10;
const TYPE_CACHE_MS = 60 * 60_000;
const TYPE_CACHE_LIMIT = 500;
const MAX_CREATE_BODY = 16 * 1024;

const triggerTypeSchema = z.object({
  slug: z.string().regex(TRIGGER_SLUG),
  name: z.string().nullish(),
  description: z.string().nullish(),
  instructions: z.string().nullish(),
  type: z.string().nullish(),
  toolkit: z.object({ slug: z.string().nullish() }).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
  version: z.string().nullish(),
  requires_webhook_endpoint_setup: z.boolean().nullish(),
});
const triggerTypePageSchema = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().nullish(),
});
const upsertResponseSchema = z.object({ trigger_id: z.string().regex(TRIGGER_ID) });
const remoteInstanceSchema = z.object({
  id: z.string().regex(TRIGGER_ID),
  trigger_name: z.string().nullish(),
  connected_account_id: z.string().nullish(),
  user_id: z.string().nullish(),
  trigger_config: z.record(z.string(), z.unknown()).nullish(),
  disabled_at: z.union([z.string(), z.number()]).nullish(),
});
type RemoteInstance = z.infer<typeof remoteInstanceSchema>;
const remoteInstancePageSchema = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().nullish(),
});
const createSchema = z.object({
  slug: z.string().regex(TRIGGER_SLUG),
  connectedAccountId: z.string().regex(ACCOUNT_ID),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
const updateSchema = z.object({ enabled: z.boolean() }).strict();

export interface TriggerType {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  instructions?: string;
  /** Composio's delivery: "webhook" is near-instant, "poll" checks on Composio's interval. */
  type?: string;
  config: Record<string, unknown>;
  payload: Record<string, unknown>;
  version?: string;
}

interface BindingRow {
  composio_trigger_id: string;
  toolkit: string;
  trigger_slug: string;
  connected_account_id: string;
  created_at: number;
  disabled_at: number | null;
}

type RemoteResult = "done" | "missing" | { error: string };

/** The catalog is the same for every installation. Cache API calls do nothing on a workers.dev host, so each
 *  isolate keeps its own copy. */
const typeCache = new Map<string, { value: TriggerType[] | TriggerType | null; expiresAt: number }>();

function cachedType<T extends TriggerType[] | TriggerType | null>(key: string): T | undefined {
  const entry = typeCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.value as T;
  typeCache.delete(key);
  return undefined;
}

function rememberType(key: string, value: TriggerType[] | TriggerType | null) {
  typeCache.delete(key);
  typeCache.set(key, { value, expiresAt: Date.now() + TYPE_CACHE_MS });
  for (const oldest of typeCache.keys()) {
    if (typeCache.size <= TYPE_CACHE_LIMIT) break;
    typeCache.delete(oldest);
  }
}

export function forgetTriggerTypes() {
  typeCache.clear();
}

/** Types that need the project's own webhook endpoint per toolkit can never fire through the shared subscription. */
function usableType(item: unknown): TriggerType | null {
  const parsed = triggerTypeSchema.safeParse(item);
  if (!parsed.success || parsed.data.requires_webhook_endpoint_setup === true) return null;
  const type = parsed.data;
  const toolkit = type.toolkit?.slug?.toLowerCase();
  if (!toolkit) return null;
  return {
    slug: type.slug.toUpperCase(),
    toolkit,
    name: type.name ?? type.slug,
    description: type.description ?? "",
    ...(type.instructions ? { instructions: type.instructions } : {}),
    ...(type.type ? { type: type.type } : {}),
    config: type.config ?? {},
    payload: type.payload ?? {},
    ...(type.version ? { version: type.version } : {}),
  };
}

async function typesForToolkit(env: Env, toolkit: string): Promise<TriggerType[]> {
  const key = `toolkit:${toolkit}`;
  const hit = cachedType<TriggerType[]>(key);
  if (hit) return hit;
  const types: TriggerType[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TYPE_PAGES; page += 1) {
    const params = new URLSearchParams({ toolkit_slugs: toolkit, limit: "50", toolkit_versions: "latest" });
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(env, `/triggers_types?${params}`);
    if (!response.ok) throw new Error(await upstreamError(response, `Event types unavailable (${response.status})`));
    const body = triggerTypePageSchema.parse(await response.json());
    for (const item of body.items) {
      const type = usableType(item);
      if (type?.toolkit === toolkit) types.push(type);
    }
    const next = body.next_cursor || undefined;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  rememberType(key, types);
  return types;
}

export async function triggerType(env: Env, slug: string): Promise<TriggerType | null> {
  const key = `type:${slug.toUpperCase()}`;
  const hit = cachedType<TriggerType | null>(key);
  if (hit !== undefined) return hit;
  const response = await composioRequest(env, `/triggers_types/${encodeURIComponent(slug)}?toolkit_versions=latest`);
  // Composio answers 400, not 404, for a slug it does not know.
  if (response.status === 400 || response.status === 404) {
    await response.body?.cancel();
    rememberType(key, null);
    return null;
  }
  if (!response.ok) throw new Error(await upstreamError(response, `Event type unavailable (${response.status})`));
  const type = usableType(await response.json());
  rememberType(key, type);
  return type;
}

export async function listTriggerTypes(url: URL, installation: EventInstallation, env: Env) {
  const requested = url.searchParams.get("toolkits");
  let toolkits: string[];
  if (requested !== null) {
    toolkits = [...new Set(requested.split(",").map((slug) => slug.trim().toLowerCase()).filter(Boolean))];
    if (toolkits.length > MAX_TYPE_TOOLKITS) return json({ error: `at most ${MAX_TYPE_TOOLKITS} toolkits per request` }, 400);
  } else {
    const accounts = await listConnectedAccounts(env, actingUser(installation), []);
    toolkits = [...new Set(accounts
      .filter((account) => /^active$/i.test(account.status ?? ""))
      .map((account) => account.toolkit?.slug?.toLowerCase() ?? "")
      .filter(Boolean))].sort();
  }
  if (toolkits.some((slug) => !TOOLKIT_SLUG.test(slug))) return json({ error: "invalid toolkit slug" }, 400);
  const loaded = toolkits.slice(0, MAX_TYPE_TOOLKITS);
  const entries = await Promise.all(loaded.map(async (toolkit) => {
    try {
      return [toolkit, { types: await typesForToolkit(env, toolkit) }] as const;
    } catch (error) {
      return [toolkit, { error: error instanceof Error ? error.message : String(error) }] as const;
    }
  }));
  return json({ toolkits: Object.fromEntries(entries), notLoaded: toolkits.slice(MAX_TYPE_TOOLKITS) });
}

export async function getTriggerType(slug: string, env: Env) {
  const type = await triggerType(env, slug);
  return type ? json(type) : json({ error: "unknown or unsupported event type" }, 404);
}

export async function setRemoteEnabled(env: Env, triggerId: string, enabled: boolean): Promise<RemoteResult> {
  const response = await composioRequest(env, `/trigger_instances/manage/${encodeURIComponent(triggerId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: enabled ? "enable" : "disable" }),
  });
  // 409: the instance is already in that state.
  if (response.ok || response.status === 409) {
    await response.body?.cancel();
    return "done";
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return "missing";
  }
  return { error: await upstreamError(response, `Composio could not ${enabled ? "enable" : "disable"} the trigger (${response.status})`) };
}

async function deleteRemote(env: Env, triggerId: string): Promise<RemoteResult> {
  const response = await composioRequest(env, `/trigger_instances/manage/${encodeURIComponent(triggerId)}`, { method: "DELETE" });
  if (response.ok || response.status === 404) {
    await response.body?.cancel();
    return response.ok ? "done" : "missing";
  }
  return { error: await upstreamError(response, `Composio could not delete the trigger (${response.status})`) };
}

async function listRemoteInstances(env: Env, userId: string): Promise<RemoteInstance[]> {
  const instances: RemoteInstance[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INSTANCE_PAGES; page += 1) {
    const params = new URLSearchParams({ user_ids: userId, show_disabled: "true", limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(env, `/trigger_instances/active?${params}`);
    if (!response.ok) throw new Error(await upstreamError(response, `Trigger lookup failed (${response.status})`));
    const body = remoteInstancePageSchema.parse(await response.json());
    for (const item of body.items) {
      const parsed = remoteInstanceSchema.safeParse(item);
      if (parsed.success && (!parsed.data.user_id || parsed.data.user_id === userId)) instances.push(parsed.data);
    }
    const next = body.next_cursor || undefined;
    if (!next || seen.has(next)) return instances;
    seen.add(next);
    cursor = next;
  }
  throw new Error("Trigger inventory exceeded the pagination safety limit");
}

async function binding(env: Env, installationId: string, triggerId: string) {
  return env.DB.prepare(
    "SELECT composio_trigger_id, toolkit, trigger_slug, connected_account_id, created_at, disabled_at FROM trigger_bindings WHERE installation_id = ? AND composio_trigger_id = ?",
  ).bind(installationId, triggerId).first<BindingRow>();
}

/** Bindings other installations hold on the same instance: a desktop and its Cloud that act as one Composio user may
 *  both listen to it. The remote instance is changed only for the last one. */
async function otherBindings(env: Env, installationId: string, triggerId: string, enabledOnly: boolean) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM trigger_bindings WHERE composio_trigger_id = ? AND installation_id != ?${enabledOnly ? " AND disabled_at IS NULL" : ""}`,
  ).bind(triggerId, installationId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Composio returns the existing instance (and re-enables it) for a config it already has, so several local triggers
 *  can share one binding. A config change is a new create followed by deleting the old instance once no local
 *  trigger uses it: moving a shared binding in place would cut off the other triggers. */
export async function createTrigger(request: Request, installation: EventInstallation, env: Env, now = Date.now()) {
  const parsed = createSchema.safeParse(await readJsonBody(request, MAX_CREATE_BODY));
  if (!parsed.success) return json({ error: "slug, connectedAccountId and config (an object) are required" }, 400);
  const { slug, connectedAccountId, config } = parsed.data;
  // Ownership before anything else reaches Composio's trigger API.
  const accounts = await listConnectedAccounts(env, actingUser(installation), []);
  const account = accounts.find((candidate) => candidate.id === connectedAccountId);
  const toolkit = account?.toolkit?.slug?.toLowerCase();
  if (!account || !toolkit) return json({ error: "that connected account does not belong to this installation" }, 403);
  const type = await triggerType(env, slug);
  if (!type) return json({ error: `unknown or unsupported event type ${slug}` }, 404);
  if (type.toolkit !== toolkit) return json({ error: `${type.slug} is a ${type.toolkit} event, and that account is ${toolkit}` }, 400);
  const upsert = await composioRequest(env, `/trigger_instances/${encodeURIComponent(type.slug)}/upsert`, {
    method: "POST",
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      user_id: actingUser(installation),
      trigger_config: config,
      toolkit_versions: "latest",
    }),
  });
  if (!upsert.ok) {
    const error = await upstreamError(upsert, `Composio could not create the trigger (${upsert.status})`);
    return json({ error }, upsert.status === 400 || upsert.status === 422 ? 400 : 502);
  }
  const created = upsertResponseSchema.safeParse(await upsert.json().catch(() => null));
  if (!created.success) return json({ error: "Composio returned no trigger id" }, 502);
  const triggerId = created.data.trigger_id;
  await env.DB.prepare(
    `INSERT INTO trigger_bindings (installation_id, composio_trigger_id, toolkit, trigger_slug, connected_account_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (installation_id, composio_trigger_id) DO UPDATE SET
       toolkit = excluded.toolkit, trigger_slug = excluded.trigger_slug,
       connected_account_id = excluded.connected_account_id, disabled_at = NULL`,
  ).bind(installation.id, triggerId, toolkit, type.slug, connectedAccountId, now).run();
  return json({ triggerId, slug: type.slug, toolkit, connectedAccountId, enabled: true }, 201);
}

export async function updateTrigger(request: Request, triggerId: string, installation: EventInstallation, env: Env, now = Date.now()) {
  const parsed = updateSchema.safeParse(await readJsonBody(request, 1024));
  if (!parsed.success) {
    return json({ error: "send {enabled: true|false}; to change a config, create the new trigger and delete the old one" }, 400);
  }
  const { enabled } = parsed.data;
  if (!(await binding(env, installation.id, triggerId))) return json({ error: "no such trigger" }, 404);
  const remoteEnabled = enabled || (await otherBindings(env, installation.id, triggerId, true)) > 0;
  const result = await setRemoteEnabled(env, triggerId, remoteEnabled);
  if (result === "missing") return json({ error: "Composio no longer has this trigger; create it again", remote: "missing" }, 404);
  if (result !== "done") return json({ error: result.error }, 502);
  await env.DB.prepare("UPDATE trigger_bindings SET disabled_at = ? WHERE installation_id = ? AND composio_trigger_id = ?")
    .bind(enabled ? null : now, installation.id, triggerId)
    .run();
  return json({ triggerId, enabled });
}

/** Leaves this installation with no trigger `triggerId`: its binding, queued events and drop counts go, and the
 *  Composio instance goes once nothing else binds it. An instance of this installation's Composio user that no
 *  installation binds (an upsert whose binding was never saved) is deleted too. */
export async function deleteTrigger(triggerId: string, installation: EventInstallation, env: Env) {
  const bound = await binding(env, installation.id, triggerId);
  if (!bound) {
    if ((await otherBindings(env, installation.id, triggerId, false)) > 0) return json({ removed: 0 });
    const remote = await listRemoteInstances(env, actingUser(installation));
    if (!remote.some((instance) => instance.id === triggerId)) return json({ removed: 0 });
    const result = await deleteRemote(env, triggerId);
    return typeof result === "object" ? json({ error: result.error }, 502) : json({ removed: 1 });
  }
  if ((await otherBindings(env, installation.id, triggerId, false)) === 0) {
    const result = await deleteRemote(env, triggerId);
    if (typeof result === "object") return json({ error: result.error }, 502);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM trigger_bindings WHERE installation_id = ? AND composio_trigger_id = ?").bind(installation.id, triggerId),
    env.DB.prepare("DELETE FROM events WHERE installation_id = ? AND composio_trigger_id = ? AND acked_at IS NULL").bind(installation.id, triggerId),
    env.DB.prepare("DELETE FROM event_drops WHERE installation_id = ? AND composio_trigger_id = ?").bind(installation.id, triggerId),
  ]);
  return json({ removed: 1 });
}

/** This installation's bindings beside Composio's view of them, for the OMB server's reconciliation: a local trigger
 *  whose `remote.state` is "missing" is created again, an `unbound` instance (one no installation binds) is deleted,
 *  and an `enabled` that differs from `remote.state` is patched. */
export async function listTriggers(installation: EventInstallation, env: Env, now = Date.now()) {
  const [bindings, drops, usage] = await Promise.all([
    env.DB.prepare(
      "SELECT composio_trigger_id, toolkit, trigger_slug, connected_account_id, created_at, disabled_at FROM trigger_bindings WHERE installation_id = ? ORDER BY created_at, composio_trigger_id",
    ).bind(installation.id).all<BindingRow>(),
    env.DB.prepare("SELECT composio_trigger_id, reason, dropped, last_dropped_at FROM event_drops WHERE installation_id = ?")
      .bind(installation.id)
      .all<{ composio_trigger_id: string; reason: string; dropped: number; last_dropped_at: number }>(),
    env.DB.prepare(
      `SELECT
         COALESCE((SELECT queued FROM app_event_days WHERE day = ?2 AND installation_id = ?1), 0) AS events_today,
         (SELECT COUNT(*) FROM events WHERE installation_id = ?1 AND acked_at IS NULL) AS queued_events,
         COALESCE((SELECT SUM(bytes) FROM events WHERE installation_id = ?1 AND acked_at IS NULL), 0) AS queued_bytes`,
    ).bind(installation.id, utcDay(now)).first<{ events_today: number; queued_events: number; queued_bytes: number }>(),
  ]);
  let remote: RemoteInstance[] | null = null;
  let remoteError: string | undefined;
  try {
    remote = await listRemoteInstances(env, actingUser(installation));
  } catch (error) {
    remoteError = error instanceof Error ? error.message : String(error);
  }
  const remoteById = new Map((remote ?? []).map((instance) => [instance.id, instance]));
  const bound = new Set(bindings.results.map((row) => row.composio_trigger_id));
  for (const instance of remote ?? []) {
    if (!bound.has(instance.id) && (await otherBindings(env, installation.id, instance.id, false)) > 0) bound.add(instance.id);
  }
  const triggers = bindings.results.map((row) => {
    const instance = remoteById.get(row.composio_trigger_id);
    const dropped = Object.fromEntries(drops.results
      .filter((drop) => drop.composio_trigger_id === row.composio_trigger_id)
      .map((drop) => [drop.reason, { count: drop.dropped, lastAt: drop.last_dropped_at }]));
    return {
      triggerId: row.composio_trigger_id,
      slug: row.trigger_slug,
      toolkit: row.toolkit,
      connectedAccountId: row.connected_account_id,
      enabled: row.disabled_at === null,
      createdAt: row.created_at,
      remote: remote === null
        ? null
        : instance
          ? { state: instance.disabled_at ? "disabled" : "enabled", config: instance.trigger_config ?? {} }
          : { state: "missing" },
      dropped,
    };
  });
  const unbound = remote === null ? null : remote.filter((instance) => !bound.has(instance.id)).map((instance) => ({
    triggerId: instance.id,
    slug: instance.trigger_name ?? null,
    connectedAccountId: instance.connected_account_id ?? null,
    enabled: !instance.disabled_at,
  }));
  return json({
    triggers,
    unbound,
    ...(remoteError ? { remoteError } : {}),
    limits: eventLimits(installation),
    usage: {
      eventsToday: usage?.events_today ?? 0,
      queuedEvents: usage?.queued_events ?? 0,
      queuedBytes: usage?.queued_bytes ?? 0,
    },
  });
}
