import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import worker from "./index";

/** D1 over node:sqlite with the real migrations: the same SQLite engine, so constraints, RETURNING and partial
 *  indexes behave as they do in D1. `migrations` limits how many migration files run. */
export function fakeD1(migrations = Infinity) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().slice(0, migrations)) {
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const sqlLog: string[] = [];
  function params(values: unknown[]) {
    return values.map((value) => {
      if (value === undefined) throw new TypeError("D1_TYPE_ERROR: undefined cannot be bound");
      return (typeof value === "boolean" ? Number(value) : value) as SQLInputValue;
    });
  }
  const plain = (row: unknown) => (row ? { ...(row as object) } : null);
  function execute(statement: StatementSync, values: unknown[]) {
    if (statement.columns().length) {
      return { success: true, results: statement.all(...params(values)).map(plain), meta: { changes: 0 } };
    }
    const result = statement.run(...params(values));
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  function prepared(sql: string, values: unknown[] = []) {
    const compile = () => {
      sqlLog.push(sql);
      return db.prepare(sql);
    };
    return {
      sql,
      values,
      bind: (...next: unknown[]) => prepared(sql, next),
      first: async <T>(column?: string) => {
        const row = plain(compile().get(...params(values))) as Record<string, unknown> | null;
        return (column ? row?.[column] ?? null : row) as T | null;
      },
      all: async () => execute(compile(), values),
      run: async () => execute(compile(), values),
      raw: async () => compile().all(...params(values)).map((row) => Object.values(row as object)),
    };
  }
  const D1 = {
    prepare: (sql: string) => prepared(sql),
    batch: async (statements: Array<ReturnType<typeof prepared>>) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          sqlLog.push(statement.sql);
          return execute(db.prepare(statement.sql), statement.values);
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => db.exec(sql),
  };
  const rows = <T = Record<string, unknown>>(sql: string, ...values: unknown[]) =>
    db.prepare(sql).all(...params(values)).map(plain) as T[];
  return { db, D1, rows, sqlLog };
}

interface FakeAccount { id: string; user_id: string; toolkit: { slug: string }; status: string }
interface FakeInstance {
  id: string;
  trigger_name: string;
  connected_account_id: string;
  user_id: string;
  trigger_config: Record<string, unknown>;
  disabled_at: string | null;
}
export interface FakeCall { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }

export const GMAIL_TYPE = {
  slug: "GMAIL_NEW_GMAIL_MESSAGE",
  name: "New Gmail message",
  description: "Fires on a new message",
  type: "poll",
  toolkit: { slug: "gmail", logo: "https://logos.composio.dev/gmail.png" },
  config: { type: "object", properties: { query: { type: "string" }, interval: { type: "number" } } },
  payload: { type: "object", properties: { sender: { type: "string" }, subject: { type: "string" } } },
  version: "20260901_00",
};

export interface FakeSession { id: string; user_id: string }

/** The slice of Composio's v3.1 API the broker calls, with the semantics the design relies on: an identical upsert
 *  returns (and re-enables) the existing instance, manage answers 409 for "already in that state", and a tool router
 *  Session reaches only its own user's connected accounts. */
export function fakeComposio() {
  const accounts: FakeAccount[] = [];
  const sessions = new Map<string, FakeSession>();
  const types: Array<Record<string, unknown>> = [
    GMAIL_TYPE,
    { slug: "GMAIL_EMAIL_SENT", name: "Email sent", description: "", type: "poll", toolkit: { slug: "gmail" }, config: {}, payload: {} },
    { slug: "GMAIL_OWN_ENDPOINT", name: "Needs setup", description: "", type: "webhook", toolkit: { slug: "gmail" }, requires_webhook_endpoint_setup: true },
    { slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", name: "Slack message", description: "", type: "webhook", toolkit: { slug: "slack" }, config: {}, payload: {} },
  ];
  const instances = new Map<string, FakeInstance>();
  const calls: FakeCall[] = [];
  const failures: Array<{ match: (call: FakeCall) => boolean; status: number }> = [];
  let next = 1;
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    if (url.hostname !== "backend.composio.dev") throw new Error(`unexpected fetch ${url}`);
    if (new Headers(init?.headers).get("x-api-key") !== "ak_test") return reply({ error: "bad key" }, 401);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v3(\.1)?/, "");
    const raw = typeof init?.body === "string" ? init.body
      : init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body) ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    const call: FakeCall = { method, path, query: url.searchParams, body };
    calls.push(call);
    const failure = failures.findIndex((candidate) => candidate.match(call));
    if (failure >= 0) {
      const [{ status }] = failures.splice(failure, 1);
      return reply({ error: { message: `injected ${status}` } }, status);
    }
    if (method === "GET" && path === "/connected_accounts") {
      const user = url.searchParams.get("user_ids");
      const slugs = url.searchParams.get("toolkit_slugs")?.split(",");
      return reply({ items: accounts.filter((account) => account.user_id === user && (!slugs || slugs.includes(account.toolkit.slug))), next_cursor: null });
    }
    if (method === "GET" && path === "/auth_configs") return reply({ items: [], next_cursor: null });
    const sessionPayload = (session: FakeSession) => ({
      session_id: session.id,
      mcp: { type: "http", url: `https://backend.composio.dev/tool_router/${session.id}/mcp` },
      config: { user_id: session.user_id, multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } },
    });
    if (method === "POST" && path === "/tool_router/session" && body) {
      const session = { id: `trs_${next++}`, user_id: String(body.user_id) };
      sessions.set(session.id, session);
      return reply(sessionPayload(session), 201);
    }
    const sessionPath = path.match(/^\/tool_router(?:\/session)?\/([^/]+)(\/toolkits|\/link|\/mcp)?$/);
    const session = sessionPath ? sessions.get(sessionPath[1]!) : undefined;
    if (sessionPath && !session) return reply({ error: { message: "Session not found" } }, 404);
    if (session && method === "GET" && !sessionPath![2]) return reply(sessionPayload(session));
    if (session && method === "GET" && sessionPath![2] === "/toolkits") {
      const wanted = url.searchParams.get("toolkits")?.split(",").filter(Boolean);
      const items = accounts.filter((account) => account.user_id === session.user_id && /^active$/i.test(account.status)
        && (!wanted || wanted.includes(account.toolkit.slug)))
        .map((account) => ({ slug: account.toolkit.slug, connected_account: { id: account.id, status: account.status } }));
      return reply({ items, next_cursor: null });
    }
    if (session && method === "POST" && sessionPath![2] === "/link") {
      return reply({ redirect_url: `https://backend.composio.dev/link/${session.id}/${String(body?.toolkit ?? "")}` });
    }
    if (session && method === "POST" && sessionPath![2] === "/mcp") {
      const rpc = (body ?? {}) as { id?: unknown; method?: unknown; params?: { name?: unknown } };
      if (rpc.method === "tools/call") {
        const mine = accounts.filter((account) => account.user_id === session.user_id && /^active$/i.test(account.status)).map((account) => account.id);
        return reply({ jsonrpc: "2.0", id: rpc.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ tool: rpc.params?.name, user: session.user_id, accounts: mine }) }] } });
      }
      if (rpc.method === "tools/list") return reply({ jsonrpc: "2.0", id: rpc.id ?? null, result: { tools: [{ name: "GMAIL_SEND_EMAIL", inputSchema: { type: "object" } }] } });
      return reply({ jsonrpc: "2.0", id: rpc.id ?? null, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-composio", version: "1" } } });
    }
    if (method === "GET" && path === "/triggers_types") {
      const toolkit = url.searchParams.get("toolkit_slugs");
      const all = types.filter((type) => (type.toolkit as { slug: string }).slug === toolkit);
      // Two per page, so the broker must follow the cursor.
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = all.slice(start, start + 2);
      return reply({ items: page, next_cursor: start + 2 < all.length ? String(start + 2) : null });
    }
    const typeSlug = path.match(/^\/triggers_types\/([^/]+)$/)?.[1];
    if (method === "GET" && typeSlug) {
      const type = types.find((candidate) => String(candidate.slug).toLowerCase() === decodeURIComponent(typeSlug).toLowerCase());
      return type ? reply(type) : reply({ error: { message: "Trigger type not found" } }, 400);
    }
    const upsertSlug = path.match(/^\/trigger_instances\/([^/]+)\/upsert$/)?.[1];
    if (method === "POST" && upsertSlug && body) {
      const account = accounts.find((candidate) => candidate.id === body.connected_account_id);
      if (!account || account.user_id !== body.user_id) return reply({ error: { message: "connected account not found for user" } }, 400);
      const config = JSON.stringify(body.trigger_config ?? {});
      const same = [...instances.values()].find((instance) =>
        instance.trigger_name === upsertSlug && instance.connected_account_id === account.id && JSON.stringify(instance.trigger_config) === config);
      if (same) {
        same.disabled_at = null;
        return reply({ trigger_id: same.id });
      }
      const id = `ti_${next++}`;
      instances.set(id, { id, trigger_name: upsertSlug, connected_account_id: account.id, user_id: account.user_id, trigger_config: JSON.parse(config), disabled_at: null });
      return reply({ trigger_id: id });
    }
    const manageId = path.match(/^\/trigger_instances\/manage\/([^/]+)$/)?.[1];
    if (manageId) {
      const instance = instances.get(manageId);
      if (!instance) return reply({ error: { message: "Trigger not found" } }, 404);
      if (method === "DELETE") {
        instances.delete(manageId);
        return reply({ status: "success" });
      }
      if (method === "PATCH") {
        const enable = body?.status === "enable";
        if (enable === (instance.disabled_at === null)) return reply({ error: { message: "already in that state" } }, 409);
        instance.disabled_at = enable ? null : new Date().toISOString();
        return reply({ status: "success" });
      }
    }
    if (method === "GET" && path === "/trigger_instances/active") {
      const user = url.searchParams.get("user_ids");
      const showDisabled = url.searchParams.get("show_disabled") === "true";
      return reply({ items: [...instances.values()].filter((instance) => instance.user_id === user && (showDisabled || !instance.disabled_at)), next_cursor: null });
    }
    return reply({ error: { message: `fake Composio has no ${method} ${path}` } }, 404);
  }
  return {
    accounts,
    types,
    instances,
    sessions,
    calls,
    fetchImpl,
    fail: (status: number, match: (call: FakeCall) => boolean) => failures.push({ match, status }),
    callsTo: (prefix: string) => calls.filter((call) => call.path.startsWith(prefix)),
  };
}

export const WEBHOOK_SECRET = "whsec_test_broker_secret";
export const CLOUD_GRANT_SECRET = "cloud-grant-test-secret-0123456789abcdef";
export const STATS_TOKEN = "stats-token-for-admin";

/** Signs as Composio does (@composio/core Triggers.verifyWebhook): base64 HMAC-SHA256 keyed with the secret's UTF-8
 *  bytes over `${id}.${timestamp}.${body}`, sent as `v1,<signature>`. Written with node:crypto, apart from the
 *  Worker's WebCrypto code it checks. */
export function composioSignature(secret: string, id: string, timestamp: string | number, body: string) {
  return createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function cloudGrant(machineId: string, secret = CLOUD_GRANT_SECRET) {
  return `v1.${machineId}.${createHmac("sha256", secret).update(`omb-connected-apps-cloud:v1\n${machineId}`).digest("base64url")}`;
}

/** A request body of `chunks` chunks of `chunkBytes` spaces, streamed without a Content-Length, that counts how much
 *  of it was read and whether the reader cancelled it. */
export function streamedBody(chunkBytes: number, chunks: number) {
  const read = { bytes: 0, cancelled: false };
  let left = chunks;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left-- <= 0) return controller.close();
      read.bytes += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      read.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { read, init: { method: "POST", body, duplex: "half" } as RequestInit };
}

export interface Installation { id: string; token: string; userId: string }

export function brokerHarness(options: { migrations?: number } = {}) {
  const d1 = fakeD1(options.migrations);
  const composio = fakeComposio();
  const limits = { events: true };
  const env = {
    DB: d1.D1,
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3",
    COMPOSIO_API_KEY: "ak_test",
    REGISTRATION_MODE: "open",
    COMPOSIO_WEBHOOK_SECRET: WEBHOOK_SECRET as string | undefined,
    CLOUD_GRANT_SECRET: CLOUD_GRANT_SECRET as string | undefined,
    STATS_TOKEN: STATS_TOKEN as string | undefined,
    CLOUD_ADMIN_URL: undefined as string | undefined,
    REGISTRATION_LIMITER: { limit: async () => ({ success: true }) },
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    EVENTS_LIMITER: { limit: async () => ({ success: limits.events }) },
  };
  const background: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => background.push(promise), passThroughOnException() {} };
  const fetchBroker = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://broker.test${path}`, init), env as never, ctx as never);

  let accountCount = 0;
  const harness = {
    d1,
    env,
    ctx,
    composio,
    limits,
    background,
    fetch: fetchBroker,
    async install(): Promise<Installation> {
      const response = await fetchBroker("/v1/installations", { method: "POST", body: "{}" });
      const body = await response.json() as { installationId: string; token: string };
      return { id: body.installationId, token: body.token, userId: `omb_${body.installationId.replaceAll("-", "")}` };
    },
    account(owner: Installation, toolkit = "gmail", status = "ACTIVE") {
      const id = `ca_${toolkit}_${++accountCount}`;
      composio.accounts.push({ id, user_id: owner.userId, toolkit: { slug: toolkit }, status });
      return id;
    },
    call(owner: Installation, path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${owner.token}`);
      if (init.body) headers.set("content-type", "application/json");
      return fetchBroker(path, { ...init, headers });
    },
    async createTrigger(owner: Installation, connectedAccountId: string, config: Record<string, unknown> = { query: "subject:order" }, slug = GMAIL_TYPE.slug) {
      const response = await harness.call(owner, "/v1/triggers", { method: "POST", body: JSON.stringify({ slug, connectedAccountId, config }) });
      return { response, body: await response.json() as { triggerId: string; error?: string } };
    },
    poll(owner: Installation, query = "", poller = "poller-main-0001") {
      return harness.call(owner, `/v1/events${query ? `?${query}` : ""}`, { headers: { "x-omb-poller": poller } });
    },
    /** One Composio delivery. `id` is both the webhook-id header and the envelope id unless `envelopeId` says otherwise. */
    deliver(envelope: Record<string, unknown>, sign: {
      id?: string;
      envelopeId?: string;
      secret?: string;
      timestamp?: number;
      signature?: (good: string) => string;
      tamper?: (body: string) => string;
    } = {}) {
      const id = sign.id ?? String(envelope.id ?? `msg_${crypto.randomUUID()}`);
      const body = JSON.stringify({ ...envelope, id: sign.envelopeId ?? id });
      const timestamp = sign.timestamp ?? Math.floor(Date.now() / 1000);
      const good = `v1,${composioSignature(sign.secret ?? WEBHOOK_SECRET, id, timestamp, body)}`;
      return fetchBroker("/v1/composio/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": sign.signature ? sign.signature(good) : good,
        },
        body: sign.tamper ? sign.tamper(body) : body,
      });
    },
    queued(installationId?: string) {
      return d1.rows<{ seq: number; installation_id: string; event_id: string; kind: string; composio_trigger_id: string | null; body: string; acked_at: number | null; bytes: number }>(
        `SELECT * FROM events WHERE acked_at IS NULL${installationId ? " AND installation_id = ?" : ""} ORDER BY seq`,
        ...(installationId ? [installationId] : []),
      );
    },
    day(installationId: string, day = new Date().toISOString().slice(0, 10)) {
      return d1.rows<Record<string, number>>("SELECT * FROM app_event_days WHERE day = ? AND installation_id = ?", day, installationId)[0];
    },
    drops(installationId: string) {
      return d1.rows<{ composio_trigger_id: string; reason: string; dropped: number }>(
        "SELECT composio_trigger_id, reason, dropped FROM event_drops WHERE installation_id = ? ORDER BY composio_trigger_id, reason",
        installationId,
      );
    },
  };
  return harness;
}

export function message(triggerId: string, userId: string | undefined, data: Record<string, unknown> = { subject: "Order #1042", sender: "j@example.test" }, id?: string) {
  return {
    ...(id ? { id } : {}),
    type: "composio.trigger.message",
    timestamp: new Date().toISOString(),
    metadata: {
      log_id: "log_1",
      trigger_slug: GMAIL_TYPE.slug,
      trigger_id: triggerId,
      connected_account_id: "ca_whatever",
      auth_config_id: "ac_1",
      ...(userId ? { user_id: userId } : {}),
    },
    data,
  };
}
