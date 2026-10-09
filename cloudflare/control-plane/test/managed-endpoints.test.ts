import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudflareAPI, CloudflareAPIError, type CloudflareFetch } from "../src/cloudflare-api";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { cleanupEndpointRow, sweepManagedEndpointCleanup } from "../src/endpoints";
import { createWorker } from "../src/index";
import { forgetCachedCapacity } from "../src/tunnel-capacity";

const BASE_URL = "https://auth.openmausbot.test";
const CONNECTOR_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-only-connector-token.signature";
/** Rows written straight to D1 use the primary account's suffix: an endpoint
 * whose hostname is not under its account's suffix refuses to act. */
const HOST_SUFFIX = env.COMPANION_HOST_SUFFIX;
const PRIMARY_ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID;

interface CallOptions {
  body?: unknown;
  contentType?: string;
  env?: Env;
  method?: string;
  rawBody?: string;
  token?: string;
}

type TestWorker = ReturnType<typeof createWorker>;

async function call(worker: TestWorker, path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers.set("content-type", options.contentType ?? "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    body,
    headers,
    method: options.method ?? "GET",
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, options.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const STATEMENT = Symbol("statement");

interface CountedStatement {
  label: string;
  statement: D1PreparedStatement;
}

/** "SELECT installation_endpoints", "UPDATE installations", ... */
function statementLabel(sql: string): string {
  const words = sql.trim().split(/\s+/);
  const verb = words[0]?.toUpperCase() ?? "";
  const table = verb === "UPDATE" ? words[1] : /\b(?:FROM|INTO)\s+"?(\w+)/i.exec(sql)?.[1];
  return `${verb} ${table ?? "?"}`;
}

/** An env whose D1 binding records every round trip it makes. A batch is one
 * round trip, as in production, where D1 runs it as a single request. */
function countingD1() {
  const trips: string[][] = [];
  const wrap = (statement: D1PreparedStatement, label: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === STATEMENT) return { label, statement: target } satisfies CountedStatement;
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), label);
      if (property === "first" || property === "all" || property === "run" || property === "raw") {
        return (...args: unknown[]) => {
          trips.push([label]);
          return (target[property] as (...rest: unknown[]) => unknown).apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), statementLabel(sql));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          const counted = statements.map((each) => (each as unknown as Record<symbol, CountedStatement>)[STATEMENT]);
          trips.push(counted.map((each) => each.label));
          return target.batch(counted.map((each) => each.statement));
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB: db } as Env, trips };
}

async function runScheduledCleanup(
  worker: TestWorker,
  vars: Record<string, string> = {},
): Promise<void> {
  const controller = createScheduledController({
    cron: "*/5 * * * *",
    scheduledTime: Date.now(),
  });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, { ...env, ...vars } as Env, ctx);
  await waitOnExecutionContext(ctx);
}

async function signIn(worker: TestWorker, email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call(worker, "/api/auth/sign-in/email-otp", {
    body: { email, name: "Endpoint owner", otp },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("missing account bearer");
  const body = await response.json<{ user: { id: string } }>();
  return { token, userId: body.user.id };
}

async function createInstallation(
  worker: TestWorker,
  accountToken: string,
  clientInstanceId: string,
  appVersion?: string,
) {
  const response = await call(worker, "/v1/installations", {
    body: { clientInstanceId, name: "Managed Mac", platform: "darwin", appVersion },
    method: "POST",
    token: accountToken,
  });
  expect(response.status).toBe(201);
  return response.json<{
    credential: string;
    installation: { id: string };
  }>();
}

interface FakeTunnel {
  configSrc?: string;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  created_at?: string;
  id: string;
  name: string;
  status?: string;
}

interface FakeDNSRecord {
  content: string;
  id: string;
  name: string;
  proxied: boolean;
  type: string;
}

interface Gate {
  entered: Promise<void>;
  operation: string;
  release: () => void;
  wait: Promise<void>;
}

function jsonResult(result: unknown, status = 200): Response {
  return Response.json({ errors: [], messages: [], result, success: true }, { status });
}

function jsonPage(result: unknown[], page: number, perPage: number, totalCount: number): Response {
  return Response.json({
    errors: [],
    messages: [],
    result,
    result_info: { count: result.length, page, per_page: perPage, total_count: totalCount },
    success: true,
  });
}

function tunnelJSON(tunnel: FakeTunnel) {
  const { configSrc, ...fields } = tunnel;
  return { ...fields, config_src: configSrc ?? "cloudflare", deleted_at: null };
}

function jsonNotFound(): Response {
  return Response.json({
    errors: [{ code: 1_003, message: "not found" }],
    messages: [],
    result: null,
    success: false,
  }, { status: 404 });
}

class FakeCloudflare {
  readonly calls: Array<{ authorization: string | null; body: unknown; method: string; url: string }> = [];
  readonly configurations = new Map<string, unknown>();
  readonly dns = new Map<string, FakeDNSRecord>();
  readonly failures = new Set<string>();
  readonly failuresAfterApply = new Set<string>();
  /** Provider error codes returned (HTTP 400) for an operation. */
  readonly providerErrors = new Map<string, number>();
  readonly rateLimited = new Set<string>();
  /** Operations the API token lacks a permission for (HTTP 403, code 10000). */
  readonly forbidden = new Set<string>();
  /** Retry-After header sent with a rate-limited response, if any. */
  rateLimitRetryAfter: string | null = null;
  readonly afterHooks = new Map<string, () => void>();
  readonly tunnels = new Map<string, FakeTunnel>();
  dnsTotalCount: number | null = null;
  tunnelTotalCount: number | null = null;
  /** Answer the account-wide tunnel listing without `result_info`. */
  omitTunnelTotal = false;
  private counter = 1;
  private gate: Gate | null = null;

  /** Tunnel and DNS record IDs are unique across accounts in D1, so a second
   * fake account mints its own (`b0000000-...`, `dns-b...`). */
  constructor(private readonly idPrefix = "1") {}

  pauseNext(operation: string): { entered: Promise<void>; release: () => void } {
    let markEntered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.gate = { entered, operation, release, wait };
    this.markGateEntered = markEntered;
    return { entered, release };
  }

  private markGateEntered: () => void = () => undefined;

  private async before(operation: string): Promise<Response | null> {
    if (this.gate?.operation === operation) {
      const gate = this.gate;
      this.gate = null;
      this.markGateEntered();
      await gate.wait;
    }
    if (this.rateLimited.has(operation)) {
      return Response.json({
        errors: [{ code: 971, message: "Please wait and consider throttling your request speed" }],
        messages: [],
        result: null,
        success: false,
      }, {
        headers: this.rateLimitRetryAfter === null ? {} : { "retry-after": this.rateLimitRetryAfter },
        status: 429,
      });
    }
    if (this.forbidden.has(operation)) {
      return Response.json({
        errors: [{ code: 10_000, message: "Authentication error" }],
        messages: [],
        result: null,
        success: false,
      }, { status: 403 });
    }
    const providerError = this.providerErrors.get(operation);
    if (providerError !== undefined) {
      return Response.json({
        errors: [{ code: providerError, message: "quota" }],
        messages: [],
        result: null,
        success: false,
      }, { status: 400 });
    }
    if (this.failures.has(operation)) {
      return Response.json({
        errors: [{ code: 10_000, message: `${CONNECTOR_TOKEN} must stay redacted` }],
        messages: [],
        result: null,
        success: false,
      }, { status: 500 });
    }
    return null;
  }

  private nextTunnelId(): string {
    const tail = this.counter.toString(16).padStart(12, "0");
    this.counter += 1;
    return `${this.idPrefix}0000000-0000-4000-8000-${tail}`;
  }

  private after(operation: string): void {
    this.afterHooks.get(operation)?.();
    if (this.failuresAfterApply.has(operation)) {
      throw new Error(`simulated ambiguous ${operation} result`);
    }
  }

  readonly fetch: CloudflareFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    let body: unknown = null;
    if (typeof init.body === "string") body = JSON.parse(init.body) as unknown;
    this.calls.push({
      authorization: headers.get("authorization"),
      body,
      method,
      url: url.toString(),
    });

    if (method === "GET" && url.pathname.endsWith("/cfd_tunnel") && !url.searchParams.has("name")) {
      const failed = await this.before("scan_tunnels");
      if (failed) return failed;
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const all = [...this.tunnels.values()];
      const slice = all.slice((page - 1) * perPage, page * perPage).map(tunnelJSON);
      if (this.omitTunnelTotal) return jsonResult(slice);
      return jsonPage(slice, page, perPage, this.tunnelTotalCount ?? all.length);
    }
    if (method === "GET" && url.pathname.endsWith("/cfd_tunnel")) {
      const failed = await this.before("list_tunnels");
      if (failed) return failed;
      const tunnel = this.tunnels.get(url.searchParams.get("name") ?? "");
      return jsonResult(tunnel ? [tunnelJSON(tunnel)] : []);
    }
    if (method === "GET" && /\/cfd_tunnel\/[^/]+$/.test(url.pathname)) {
      const failed = await this.before("get_tunnel");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      const tunnel = [...this.tunnels.values()].find((candidate) => candidate.id === id);
      return tunnel ? jsonResult(tunnelJSON(tunnel)) : jsonNotFound();
    }
    if (method === "POST" && url.pathname.endsWith("/cfd_tunnel")) {
      const failed = await this.before("create_tunnel");
      if (failed) return failed;
      if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string") {
        throw new Error("unexpected tunnel body");
      }
      const tunnel: FakeTunnel = {
        conns_active_at: null,
        conns_inactive_at: null,
        created_at: new Date().toISOString(),
        id: this.nextTunnelId(),
        name: body.name,
        status: "inactive",
      };
      this.tunnels.set(tunnel.name, tunnel);
      this.after("create_tunnel");
      return jsonResult(tunnelJSON(tunnel));
    }
    if (method === "PUT" && url.pathname.endsWith("/configurations")) {
      const failed = await this.before("configure_tunnel");
      if (failed) return failed;
      const tunnelId = url.pathname.split("/").at(-2) ?? "";
      this.configurations.set(tunnelId, body);
      if (!body || typeof body !== "object" || !("config" in body)) throw new Error("unexpected config body");
      return jsonResult({ config: body.config });
    }
    if (method === "GET" && url.pathname.endsWith("/dns_records") && !url.searchParams.has("name.exact")) {
      const failed = await this.before("count_dns");
      if (failed) return failed;
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      const all = [...this.dns.values()];
      return jsonPage(all.slice(0, perPage), 1, perPage, this.dnsTotalCount ?? all.length);
    }
    if (method === "GET" && url.pathname.endsWith("/dns_records")) {
      const failed = await this.before("list_dns");
      if (failed) return failed;
      const record = this.dns.get(url.searchParams.get("name.exact") ?? "");
      return jsonResult(record ? [record] : []);
    }
    if (method === "GET" && url.pathname.includes("/dns_records/")) {
      const id = url.pathname.split("/").at(-1);
      const record = [...this.dns.values()].find((candidate) => candidate.id === id);
      return record ? jsonResult(record) : jsonNotFound();
    }
    if (method === "POST" && url.pathname.endsWith("/dns_records")) {
      const failed = await this.before("create_dns");
      if (failed) return failed;
      if (
        !body
        || typeof body !== "object"
        || !("name" in body)
        || !("content" in body)
        || typeof body.name !== "string"
        || typeof body.content !== "string"
      ) throw new Error("unexpected DNS body");
      const record: FakeDNSRecord = {
        content: body.content,
        id: `dns-${this.idPrefix}${this.counter++}`,
        name: body.name,
        proxied: true,
        type: "CNAME",
      };
      this.dns.set(record.name, record);
      this.after("create_dns");
      return jsonResult(record);
    }
    if (method === "PATCH" && url.pathname.includes("/dns_records/")) {
      const failed = await this.before("update_dns");
      if (failed) return failed;
      if (
        !body
        || typeof body !== "object"
        || !("name" in body)
        || !("content" in body)
        || typeof body.name !== "string"
        || typeof body.content !== "string"
      ) throw new Error("unexpected DNS update body");
      const record: FakeDNSRecord = {
        content: body.content,
        id: url.pathname.split("/").at(-1) ?? "dns-missing",
        name: body.name,
        proxied: true,
        type: "CNAME",
      };
      this.dns.set(record.name, record);
      this.after("update_dns");
      return jsonResult(record);
    }
    if (method === "GET" && url.pathname.endsWith("/token")) {
      const failed = await this.before("get_token");
      if (failed) return failed;
      return jsonResult(CONNECTOR_TOKEN);
    }
    if (method === "DELETE" && url.pathname.includes("/dns_records/")) {
      const failed = await this.before("delete_dns");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      for (const [name, record] of this.dns) {
        if (record.id === id) this.dns.delete(name);
      }
      this.after("delete_dns");
      return Response.json({ result: { id } });
    }
    if (method === "DELETE" && url.pathname.includes("/cfd_tunnel/")) {
      const failed = await this.before("delete_tunnel");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      for (const [name, tunnel] of this.tunnels) {
        if (tunnel.id === id) this.tunnels.delete(name);
      }
      return jsonResult({ id });
    }
    throw new Error(`unexpected Cloudflare request: ${method} ${url.pathname}`);
  };
}

function isCapacityRead(entry: { method: string; url: string }): boolean {
  const url = new URL(entry.url);
  return entry.method === "GET" && (
    (url.pathname.endsWith("/cfd_tunnel") && !url.searchParams.has("name"))
    || (url.pathname.endsWith("/dns_records") && !url.searchParams.has("name.exact"))
  );
}

/** Provider calls made by provisioning or cleanup, excluding the cron's
 * two read-only capacity requests. */
function cleanupCalls(cloudflare: FakeCloudflare) {
  return cloudflare.calls.filter((entry) => !isCapacityRead(entry));
}

describe("Cloudflare API response contracts", () => {
  it("does not rebind the Worker fetch receiver", async () => {
    let receiver: unknown = "not-called";
    const fetcher: CloudflareFetch = function (this: unknown) {
      // oxlint-disable-next-line typescript/no-this-alias -- the test records the receiver
      receiver = this;
      return Promise.resolve(jsonResult([]));
    };
    const api = new CloudflareAPI(readConfig(env).cloudflare, fetcher);

    await expect(api.listTunnels("receiver-probe")).resolves.toEqual([]);
    expect(receiver).toBeUndefined();
  });

  it("keeps redirects manual and rejects them without forwarding credentials", async () => {
    const fetcher = vi.fn<CloudflareFetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        headers: { location: "https://redirect.invalid/capture-token" },
        status: 302,
      });
    });
    const api = new CloudflareAPI(readConfig(env).cloudflare, fetcher);

    await expect(api.listTunnels("redirect-probe")).rejects.toMatchObject({
      code: "cf_http_302",
      status: 302,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves the network error contract for genuine fetch rejection", async () => {
    const api = new CloudflareAPI(readConfig(env).cloudflare, async () => {
      throw new TypeError("simulated connection failure");
    });

    await expect(api.listTunnels("network-probe")).rejects.toMatchObject({
      code: "cf_network",
      status: null,
    });
  });

  it("accepts the documented result-only DNS delete response and validates its ID", async () => {
    const api = new CloudflareAPI(readConfig(env).cloudflare, async () => (
      Response.json({ result: { id: "dns-record-1" } })
    ));
    await expect(api.deleteDNSRecord("dns-record-1")).resolves.toBeUndefined();

    const mismatched = new CloudflareAPI(readConfig(env).cloudflare, async () => (
      Response.json({ result: { id: "other-record" } })
    ));
    const mismatchError = await mismatched.deleteDNSRecord("dns-record-1")
      .then(() => null, (error: unknown) => error);
    expect(mismatchError).toBeInstanceOf(CloudflareAPIError);
    expect(mismatchError).toMatchObject({
      code: "cf_invalid_response",
    });
  });

  it("keeps result-only success narrow and preserves provider error parsing", async () => {
    const resultOnly = new CloudflareAPI(readConfig(env).cloudflare, async () => (
      Response.json({ result: { id: "10000000-0000-4000-8000-000000000001" } })
    ));
    await expect(resultOnly.deleteTunnel("10000000-0000-4000-8000-000000000001"))
      .rejects.toMatchObject({ code: "cf_http_200" });

    const failed = new CloudflareAPI(readConfig(env).cloudflare, async () => Response.json({
      errors: [{ code: 10_000 }],
      result: null,
    }, { status: 500 }));
    await expect(failed.deleteDNSRecord("dns-record-1")).rejects.toMatchObject({
      code: "cf_api_10000",
      status: 500,
    });
  });
});

describe("installation check-in round trips", () => {
  const CHECK_IN = [
    ["SELECT installation_credentials"],
    ["UPDATE installation_credentials", "UPDATE installations"],
  ];
  const checkIns = (installationId: string) => env.DB.prepare(
    `SELECT c.last_used_at, i.last_seen_at
       FROM installation_credentials c JOIN installations i ON i.id = c.installation_id
      WHERE i.id = ?`,
  ).bind(installationId).first<{ last_seen_at: number | null; last_used_at: number | null }>();

  it("reads the endpoint in the same D1 batch that records the check-in", async () => {
    const worker = createWorker(new FakeCloudflare().fetch);
    const owner = await signIn(worker, "lookup-trips@example.com");
    const installation = await createInstallation(worker, owner.token, "lookup-trips");
    const id = installation.installation.id;
    const counted = countingD1();
    const lookup = async () => {
      counted.trips.length = 0;
      const response = await call(worker, "/v1/installations/self/endpoint", {
        env: counted.env,
        token: installation.credential,
      });
      return { body: await response.text(), status: response.status, trips: [...counted.trips] };
    };
    // The read stays after the writes, so it runs in the same order as before.
    const trips = [
      ["SELECT installation_credentials"],
      ["UPDATE installation_credentials", "UPDATE installations", "SELECT installation_endpoints"],
    ];

    expect(await lookup()).toEqual({ body: '{"endpoint":null}', status: 200, trips });

    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);
    await env.DB.batch([
      env.DB.prepare("UPDATE installation_credentials SET last_used_at = 1 WHERE installation_id = ?").bind(id),
      env.DB.prepare("UPDATE installations SET last_seen_at = 1 WHERE id = ?").bind(id),
    ]);
    const ready = await env.DB.prepare(
      `SELECT hostname, generation, updated_at, last_reconciled_at
         FROM installation_endpoints WHERE installation_id = ?`,
    ).bind(id).first<{ generation: number; hostname: string; last_reconciled_at: number; updated_at: number }>();
    if (!ready) throw new Error("endpoint row missing");
    const checkedInFrom = Date.now();
    expect(await lookup()).toEqual({
      body: JSON.stringify({
        endpoint: {
          url: `https://${ready.hostname}`,
          hostname: ready.hostname,
          status: "ready",
          generation: ready.generation,
          updatedAt: ready.updated_at,
          lastReconciledAt: ready.last_reconciled_at,
          lastErrorCode: null,
        },
      }),
      status: 200,
      trips,
    });
    const seen = await checkIns(id);
    expect(seen?.last_used_at).toBeGreaterThanOrEqual(checkedInFrom);
    expect(seen?.last_seen_at).toBeGreaterThanOrEqual(checkedInFrom);

    await env.DB.prepare("UPDATE installation_endpoints SET status = 'deleted' WHERE installation_id = ?")
      .bind(id).run();
    expect(await lookup()).toEqual({ body: '{"endpoint":null}', status: 200, trips });
  });

  it("rejects a wrong or revoked credential after one read and records nothing", async () => {
    const worker = createWorker(new FakeCloudflare().fetch);
    const owner = await signIn(worker, "lookup-denied@example.com");
    const installation = await createInstallation(worker, owner.token, "lookup-denied");
    const id = installation.installation.id;
    const counted = countingD1();
    const lookup = async (token: string) => {
      counted.trips.length = 0;
      const response = await call(worker, "/v1/installations/self/endpoint", { env: counted.env, token });
      return { status: response.status, trips: [...counted.trips] };
    };
    const before = await checkIns(id);

    // Same lookup ID with a different secret: the row is found, the hash is not.
    const credential = installation.credential;
    const wrongSecret = `${credential.slice(0, -1)}${credential.endsWith("A") ? "B" : "A"}`;
    expect(await lookup(wrongSecret)).toEqual({ status: 401, trips: [["SELECT installation_credentials"]] });
    expect(await lookup("invalid")).toEqual({ status: 401, trips: [] });
    expect((await call(worker, `/v1/installations/${id}`, { method: "DELETE", token: owner.token })).status)
      .toBe(204);
    expect(await lookup(credential)).toEqual({ status: 401, trips: [["SELECT installation_credentials"]] });
    expect(await checkIns(id)).toEqual(before);
  });

  it("leaves the check-in of other installation routes unchanged", async () => {
    const worker = createWorker(new FakeCloudflare().fetch);
    const owner = await signIn(worker, "lookup-others@example.com");
    const installation = await createInstallation(worker, owner.token, "lookup-others");
    const counted = countingD1();

    expect((await call(worker, "/v1/installations/self", {
      env: counted.env,
      token: installation.credential,
    })).status).toBe(200);
    expect(counted.trips).toEqual(CHECK_IN);

    // A new endpoint. With one account there is nothing to choose: the
    // capacity row is read once, for the allocation gate, after the insert.
    counted.trips.length = 0;
    expect((await call(worker, "/v1/installations/self/endpoint", {
      env: counted.env,
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);
    expect(counted.trips.slice(0, 7)).toEqual([
      ...CHECK_IN,
      ["INSERT installation_action_rate_limits"],
      ["SELECT installation_endpoints"],
      ["INSERT installation_endpoints"],
      ["SELECT installation_endpoints"],
      ["SELECT managed_endpoint_account_capacity"],
    ]);
    expect(counted.trips.filter(([label]) => label === "SELECT managed_endpoint_account_capacity")).toHaveLength(1);
    counted.trips.length = 0;
    expect((await call(worker, "/v1/installations/self/endpoint", {
      env: counted.env,
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);
    expect(counted.trips.slice(0, 2)).toEqual(CHECK_IN);
    // Re-provisioning a ready endpoint reads its row instead of first trying
    // to insert one: one round trip fewer than before accounts.
    expect(counted.trips).toHaveLength(14);
  });

  it("records a reported app version with one write, and only when it changed", async () => {
    const worker = createWorker(new FakeCloudflare().fetch);
    const owner = await signIn(worker, "version-trips@example.com");
    const installation = await createInstallation(worker, owner.token, "version-trips", "0.1.102");
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);
    const counted = countingD1();
    const provision = async (body: unknown) => {
      counted.trips.length = 0;
      expect((await call(worker, "/v1/installations/self/endpoint", {
        body,
        env: counted.env,
        method: "POST",
        token: installation.credential,
      })).status).toBe(200);
      return [...counted.trips];
    };
    const version = async () => (await env.DB.prepare("SELECT app_version, updated_at FROM installations WHERE id = ?")
      .bind(installation.installation.id).first<{ app_version: string; updated_at: number }>());
    const registered = await version();

    expect(await provision({ appVersion: "0.1.102" })).toHaveLength(14);
    expect(await provision({})).toHaveLength(14);
    const changed = await provision({ appVersion: "0.1.103" });
    expect(changed).toHaveLength(15);
    // Check-in, the attempt limit, then the one write.
    expect(changed[3]).toEqual(["UPDATE installations"]);
    expect(await version()).toEqual({ app_version: "0.1.103", updated_at: registered?.updated_at });
  });
});

describe("managed companion endpoints", () => {
  it("allocates an opaque one-label endpoint, returns a raw connector token, and reconciles idempotently", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-success@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-success");

    const first = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("access-control-allow-origin")).toBeNull();
    const firstPayload = await first.json<{
      connectorToken: string;
      endpoint: { generation: number; hostname: string; status: string; url: string };
    }>();
    expect(firstPayload.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(firstPayload.endpoint).toMatchObject({ status: "ready" });
    const [opaqueLabel, ...suffixLabels] = firstPayload.endpoint.hostname.split(".");
    expect(opaqueLabel).toMatch(/^c-[0-9a-f]{32}$/);
    expect(suffixLabels.join(".")).toBe(readConfig(env).cloudflare.companionHostSuffix);
    expect(firstPayload.endpoint.url).toBe(`https://${firstPayload.endpoint.hostname}`);

    const tunnel = [...cloudflare.tunnels.values()][0];
    if (!tunnel) throw new Error("fake tunnel missing");
    expect(cloudflare.configurations.get(tunnel.id)).toEqual({
      config: {
        ingress: [
          { hostname: firstPayload.endpoint.hostname, service: "http://127.0.0.1:8812" },
          { service: "http_status:404" },
        ],
      },
    });
    expect(cloudflare.dns.get(firstPayload.endpoint.hostname)).toMatchObject({
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      type: "CNAME",
    });

    const stored = await env.DB.prepare(
      "SELECT * FROM installation_endpoints WHERE installation_id = ?",
    ).bind(installation.installation.id).first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      status: "ready",
      tunnel_id: tunnel.id,
      last_error_code: null,
    });
    expect(JSON.stringify(stored)).not.toContain(CONNECTOR_TOKEN);
    expect(JSON.stringify(stored)).not.toContain("managed-success@example.com");

    const createCallsBefore = cloudflare.calls.filter((entry) => entry.method === "POST").length;
    const second = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(second.status).toBe(200);
    const secondPayload = await second.json<{
      connectorToken: string;
      endpoint: { generation: number; url: string };
    }>();
    expect(secondPayload.endpoint.url).toBe(firstPayload.endpoint.url);
    expect(secondPayload.endpoint.generation).toBe(firstPayload.endpoint.generation + 1);
    expect(secondPayload.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(cloudflare.calls.filter((entry) => entry.method === "POST").length).toBe(createCallsBefore);

    const get = await call(worker, "/v1/installations/self/endpoint", {
      token: installation.credential,
    });
    const getText = await get.text();
    expect(get.status).toBe(200);
    expect(getText).toContain(firstPayload.endpoint.url);
    expect(getText).not.toContain(CONNECTOR_TOKEN);
  });

  it("keeps account and installation bearer boundaries separate and isolates installations", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const firstOwner = await signIn(worker, "managed-first@example.com");
    const secondOwner = await signIn(worker, "managed-second@example.com");
    const first = await createInstallation(worker, firstOwner.token, "managed-boundary-first");
    const second = await createInstallation(worker, secondOwner.token, "managed-boundary-second");

    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: firstOwner.token,
    })).status).toBe(401);
    expect((await call(worker, "/v1/installations/self/endpoint", { token: "invalid" })).status).toBe(401);

    const firstResponse = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: first.credential,
    });
    const secondResponse = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: second.credential,
    });
    const firstURL = (await firstResponse.json<{ endpoint: { url: string } }>()).endpoint.url;
    const secondURL = (await secondResponse.json<{ endpoint: { url: string } }>()).endpoint.url;
    expect(firstURL).not.toBe(secondURL);
  });

  it("adopts matching resources after an interrupted allocation without creating duplicates", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-adopt@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-adopt");
    const tunnelName = "omb-c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hostname = `c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.${HOST_SUFFIX}`;
    const tunnel: FakeTunnel = {
      id: "20000000-0000-4000-8000-000000000001",
      name: tunnelName,
    };
    cloudflare.tunnels.set(tunnelName, tunnel);
    cloudflare.dns.set(hostname, {
      content: `${tunnel.id}.cfargotunnel.com`,
      id: "dns-adopted",
      name: hostname,
      proxied: true,
      type: "CNAME",
    });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(installation.installation.id, hostname, tunnelName, now, now).run();

    const response = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(response.status).toBe(200);
    expect(cloudflare.calls.some((entry) => entry.method === "POST")).toBe(false);
    const row = await env.DB.prepare(
      "SELECT tunnel_id, dns_record_id, status FROM installation_endpoints WHERE installation_id = ?",
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(row).toEqual({ dns_record_id: "dns-adopted", status: "ready", tunnel_id: tunnel.id });
  });

  it("serializes concurrent provisioning with a D1 lease", async () => {
    const cloudflare = new FakeCloudflare();
    const gate = cloudflare.pauseNext("list_tunnels");
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-concurrency@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-concurrency");

    const firstPromise = call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    await gate.entered;
    const second = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toBe("2");
    await expect(second.json()).resolves.toEqual({ error: "endpoint_busy" });
    gate.release();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
  });

  it("never rolls back resources after an expired lease is taken over", async () => {
    const cloudflare = new FakeCloudflare();
    const gate = cloudflare.pauseNext("get_token");
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-takeover@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-takeover");

    const staleRequest = call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    await gate.entered;
    await env.DB.prepare(
      `UPDATE installation_endpoints
          SET lease_expires_at = ?
        WHERE installation_id = ?`,
    ).bind(Date.now() - 1, installation.installation.id).run();

    const successor = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(successor.status).toBe(200);
    gate.release();
    expect((await staleRequest).status).toBe(502);

    const row = await env.DB.prepare(
      `SELECT generation, lease_owner, status, tunnel_id, dns_record_id
         FROM installation_endpoints WHERE installation_id = ?`,
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      generation: number;
      lease_owner: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(row).toMatchObject({
      dns_record_id: expect.any(String),
      generation: 2,
      lease_owner: null,
      status: "ready",
      tunnel_id: expect.any(String),
    });
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
    expect(cloudflare.calls.some((entry) => entry.method === "DELETE")).toBe(false);
  });

  it("retains and adopts a DNS create that committed before its response failed", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failuresAfterApply.add("create_dns");
    cloudflare.failures.add("get_token");
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-ambiguous-create@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-ambiguous-create");

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(response.status).toBe(502);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
    expect(cloudflare.calls.filter((entry) => (
      entry.method === "POST" && new URL(entry.url).pathname.endsWith("/dns_records")
    ))).toHaveLength(1);
    const row = await env.DB.prepare(
      "SELECT dns_record_id, tunnel_id, status FROM installation_endpoints WHERE installation_id = ?",
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(row).toMatchObject({
      dns_record_id: expect.any(String),
      status: "error",
      tunnel_id: expect.any(String),
    });

    cloudflare.failures.clear();
    cloudflare.failuresAfterApply.clear();
    const retried = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(retried.status).toBe(200);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
    expect(cloudflare.calls.filter((entry) => (
      entry.method === "POST" && new URL(entry.url).pathname.endsWith("/dns_records")
    ))).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("adopts a DNS update that committed before its response failed", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failuresAfterApply.add("update_dns");
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-ambiguous-update@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-ambiguous-update");
    const hostname = `c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.${HOST_SUFFIX}`;
    const tunnel: FakeTunnel = {
      id: "30000000-0000-4000-8000-000000000001",
      name: "omb-c-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    cloudflare.tunnels.set(tunnel.name, tunnel);
    cloudflare.dns.set(hostname, {
      content: "old-target.example.test",
      id: "dns-ambiguous-update",
      name: hostname,
      proxied: false,
      type: "CNAME",
    });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, tunnel_id, dns_record_id,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      installation.installation.id,
      hostname,
      tunnel.name,
      tunnel.id,
      "dns-ambiguous-update",
      now,
      now,
    ).run();

    const response = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(response.status).toBe(200);
    expect(cloudflare.dns.get(hostname)).toMatchObject({
      content: `${tunnel.id}.cfargotunnel.com`,
      id: "dns-ambiguous-update",
      proxied: true,
    });
  });

  it("rolls back resources created by a failed attempt and redacts provider details", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failures.add("get_token");
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-rollback@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-rollback");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "endpoint_unavailable" });
    expect(cloudflare.tunnels.size).toBe(0);
    expect(cloudflare.dns.size).toBe(0);
    const failedRow = await env.DB.prepare(
      `SELECT tunnel_id, dns_record_id, status, last_error_code
         FROM installation_endpoints WHERE installation_id = ?`,
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(failedRow).toEqual({
      dns_record_id: null,
      last_error_code: "cf_api_10000",
      status: "error",
      tunnel_id: null,
    });
    const logText = logged.mock.calls.flat().join(" ");
    expect(logText).toContain("cf_api_10000");
    expect(logText).not.toContain(CONNECTOR_TOKEN);
    expect(logText).not.toContain(env.CLOUDFLARE_API_TOKEN);
    expect(logText).not.toContain("managed-rollback@example.com");
    logged.mockRestore();

    cloudflare.failures.clear();
    const retried = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(retried.status).toBe(200);
  });

  it("preserves partial cleanup state for an idempotent DELETE retry", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-delete@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-delete");
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);

    cloudflare.failures.add("delete_tunnel");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await call(worker, "/v1/installations/self/endpoint", {
      method: "DELETE",
      token: installation.credential,
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: "endpoint_cleanup_pending" });
    const partial = await env.DB.prepare(
      `SELECT dns_record_id, tunnel_id, status, last_error_code
         FROM installation_endpoints WHERE installation_id = ?`,
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(partial).toMatchObject({
      dns_record_id: null,
      last_error_code: "cf_api_10000",
      status: "deleting",
      tunnel_id: expect.any(String),
    });

    cloudflare.failures.clear();
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "DELETE",
      token: installation.credential,
    })).status).toBe(204);
    const callsBeforeIdempotentDelete = cloudflare.calls.length;
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "DELETE",
      token: installation.credential,
    })).status).toBe(204);
    expect(cloudflare.calls.length).toBe(callsBeforeIdempotentDelete);
    await expect((await call(worker, "/v1/installations/self/endpoint", {
      token: installation.credential,
    })).json()).resolves.toEqual({ endpoint: null });
    vi.restoreAllMocks();
  });

  it("retains metadata and refuses to delete a repurposed DNS record", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-repurposed-dns@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-repurposed-dns");
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);

    const [hostname, record] = [...cloudflare.dns.entries()][0] ?? [];
    if (!hostname || !record) throw new Error("fake DNS record missing");
    cloudflare.dns.set(hostname, {
      ...record,
      content: "203.0.113.50",
      name: "repurposed.openmausbot.test",
      proxied: false,
      type: "A",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(worker, "/v1/installations/self/endpoint", {
      method: "DELETE",
      token: installation.credential,
    });
    expect(response.status).toBe(503);
    expect(cloudflare.calls.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(cloudflare.dns.get(hostname)).toMatchObject({
      content: "203.0.113.50",
      name: "repurposed.openmausbot.test",
      type: "A",
    });
    const retained = await env.DB.prepare(
      `SELECT dns_record_id, tunnel_id, status, last_error_code
         FROM installation_endpoints WHERE installation_id = ?`,
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(retained).toMatchObject({
      dns_record_id: record.id,
      last_error_code: "dns_record_identity_conflict",
      status: "deleting",
      tunnel_id: expect.any(String),
    });
    vi.restoreAllMocks();
  });

  it("retains metadata and refuses to delete a repurposed tunnel", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-repurposed-tunnel@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-repurposed-tunnel");
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);

    const [stableName, tunnel] = [...cloudflare.tunnels.entries()][0] ?? [];
    if (!stableName || !tunnel) throw new Error("fake tunnel missing");
    tunnel.name = "repurposed-tunnel";
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(worker, "/v1/installations/self/endpoint", {
      method: "DELETE",
      token: installation.credential,
    });
    expect(response.status).toBe(503);
    expect(cloudflare.calls.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(cloudflare.tunnels.get(stableName)).toMatchObject({
      id: tunnel.id,
      name: "repurposed-tunnel",
    });
    expect(cloudflare.dns.size).toBe(1);
    const retained = await env.DB.prepare(
      `SELECT dns_record_id, tunnel_id, status, last_error_code
         FROM installation_endpoints WHERE installation_id = ?`,
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(retained).toMatchObject({
      dns_record_id: expect.any(String),
      last_error_code: "tunnel_identity_conflict",
      status: "deleting",
      tunnel_id: tunnel.id,
    });
    vi.restoreAllMocks();
  });

  it("revokes credentials before cloud cleanup and lets the scheduled sweep retry retained state", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-revoke@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-revoke");
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(200);

    cloudflare.failures.add("delete_dns");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const revoked = await call(worker, `/v1/installations/${installation.installation.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(revoked.status).toBe(204);
    expect((await call(worker, "/v1/installations/self", { token: installation.credential })).status).toBe(401);
    const retained = await env.DB.prepare(
      "SELECT dns_record_id, status FROM installation_endpoints WHERE installation_id = ?",
    ).bind(installation.installation.id).first<{ dns_record_id: string | null; status: string }>();
    expect(retained).toMatchObject({ dns_record_id: expect.any(String), status: "deleting" });

    cloudflare.failures.clear();
    await env.DB.prepare(
      `UPDATE installation_endpoints
          SET last_cleanup_attempt_at = ?
        WHERE installation_id = ?`,
    ).bind(Date.now() - 6 * 60 * 1_000, installation.installation.id).run();
    await runScheduledCleanup(worker);
    const cleaned = await env.DB.prepare(
      "SELECT dns_record_id, tunnel_id, status FROM installation_endpoints WHERE installation_id = ?",
    ).bind(installation.installation.id).first<{
      dns_record_id: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(cleaned).toEqual({ dns_record_id: null, status: "deleted", tunnel_id: null });
    vi.restoreAllMocks();
  });

  it("bounds each scheduled cleanup sweep by the configured row limit", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 25 }, (_, index) => {
      const opaque = index.toString(16).padStart(32, "0");
      const hostname = `c-${opaque}.${HOST_SUFFIX}`;
      const tunnelName = `omb-c-${opaque}`;
      const tunnelId = `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
      cloudflare.tunnels.set(tunnelName, { id: tunnelId, name: tunnelName });
      cloudflare.dns.set(hostname, {
        content: `${tunnelId}.cfargotunnel.com`,
        id: `dns-budget-${index}`,
        name: hostname,
        proxied: true,
        type: "CNAME",
      });
      return env.DB.prepare(
        `INSERT INTO installation_endpoints
          (installation_id, hostname, tunnel_name, status, delete_requested_at, created_at, updated_at)
         VALUES (?, ?, ?, 'deleting', ?, ?, ?)`,
      ).bind(
        `orphan-${index}`,
        hostname,
        tunnelName,
        now - index,
        now,
        now - index,
      );
    }));
    const counts = async () => (await env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM installation_endpoints GROUP BY status ORDER BY status",
    ).all<{ count: number; status: string }>()).results;

    // Workers Free deployments set OMB_CLEANUP_SWEEP_LIMIT=4: forty cleanup
    // calls plus the two capacity reads stay under 50 subrequests.
    await runScheduledCleanup(worker, { OMB_CLEANUP_SWEEP_LIMIT: "4" });
    expect(await counts()).toEqual([
      { count: 4, status: "deleted" },
      { count: 21, status: "deleting" },
    ]);
    expect(cleanupCalls(cloudflare)).toHaveLength(40);
    expect(cloudflare.calls.filter(isCapacityRead)).toHaveLength(2);

    // On Workers Paid (OMB_CLEANUP_SWEEP_LIMIT=20, the code default) a run
    // processes twenty rows at ten calls each: about 200 of the token's 1,200
    // requests per five minutes. wrangler.jsonc ships 4 until Paid is confirmed.
    cloudflare.calls.length = 0;
    await runScheduledCleanup(worker, { OMB_CLEANUP_SWEEP_LIMIT: "20" });
    expect(await counts()).toEqual([
      { count: 24, status: "deleted" },
      { count: 1, status: "deleting" },
    ]);
    expect(cleanupCalls(cloudflare)).toHaveLength(200);
    expect(cloudflare.calls.filter(isCapacityRead)).toHaveLength(2);
  });

  it("backs off scheduled cleanup retries and flags old rows for operator attention", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, status, cleanup_attempts,
         last_cleanup_attempt_at, delete_requested_at, last_error_code, created_at, updated_at)
       VALUES (?, ?, ?, 'deleting', 2, ?, ?, 'dns_record_identity_conflict', ?, ?)`,
    ).bind(
      "orphan-backoff",
      `c-${"a".repeat(32)}.${HOST_SUFFIX}`,
      `omb-c-${"a".repeat(32)}`,
      now - 14 * 60 * 1_000,
      now - 25 * 60 * 60 * 1_000,
      now - 25 * 60 * 60 * 1_000,
      now - 14 * 60 * 1_000,
    ).run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);
    expect(cleanupCalls(cloudflare)).toHaveLength(0);
    expect(logged).not.toHaveBeenCalled();

    await env.DB.prepare(
      "UPDATE installation_endpoints SET last_cleanup_attempt_at = ? WHERE installation_id = ?",
    ).bind(now - 16 * 60 * 1_000, "orphan-backoff").run();
    await runScheduledCleanup(worker);

    expect(cleanupCalls(cloudflare)).toHaveLength(2);
    const row = await env.DB.prepare(
      "SELECT status, cleanup_attempts FROM installation_endpoints WHERE installation_id = ?",
    ).bind("orphan-backoff").first<{ cleanup_attempts: number; status: string }>();
    expect(row).toEqual({ cleanup_attempts: 3, status: "deleted" });
    const attentionLog = logged.mock.calls
      .flat()
      .find((entry) => typeof entry === "string" && entry.includes("requires operator attention"));
    expect(attentionLog).toBeTruthy();
    expect(JSON.parse(attentionLog ?? "{}")).toMatchObject({
      message: "managed endpoint cleanup requires operator attention",
      staleCandidateCount: 1,
      maxCleanupAttempts: 2,
      errorCodes: ["dns_record_identity_conflict"],
    });
    logged.mockRestore();
  });

  it("enforces endpoint action limits and the global body bound before Cloudflare calls", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "managed-limits@example.com");
    const installation = await createInstallation(worker, owner.token, "managed-limits");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO installation_action_rate_limits
        (installation_id, action, window_started_at, attempts, updated_at)
       VALUES (?, 'reconcile_endpoint', ?, 20, ?)`,
    ).bind(installation.installation.id, now, now).run();

    const limited = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    });
    expect(limited.status).toBe(429);
    expect(cloudflare.calls).toHaveLength(0);

    const oversized = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      rawBody: "x".repeat(17 * 1024),
      token: installation.credential,
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "request_too_large" });
    expect(cloudflare.calls).toHaveLength(0);
  });

  it("rejects invalid Cloudflare secret configuration without exposing it", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const invalidEnv: Env = { ...env, CLOUDFLARE_API_TOKEN: "too-short" };
    const request = new Request(`${BASE_URL}/healthz`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, invalidEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"misconfigured"}');
    expect(cloudflare.calls).toHaveLength(0);
  });
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface EndpointState {
  dns_record_id: string | null;
  hostname: string;
  provider_account: string;
  last_error_code: string | null;
  reclaim_requested_at: number | null;
  status: string;
  tunnel_id: string | null;
  tunnel_name: string;
}

async function endpointState(installationId: string): Promise<EndpointState> {
  const row = await env.DB.prepare(
    `SELECT status, tunnel_id, tunnel_name, hostname, provider_account, dns_record_id,
            reclaim_requested_at, last_error_code
       FROM installation_endpoints WHERE installation_id = ?`,
  ).bind(installationId).first<EndpointState>();
  if (!row) throw new Error("endpoint row missing");
  return row;
}

async function provisioned(
  worker: TestWorker,
  cloudflare: FakeCloudflare,
  accountToken: string,
  clientInstanceId: string,
) {
  const installation = await createInstallation(worker, accountToken, clientInstanceId);
  const response = await call(worker, "/v1/installations/self/endpoint", {
    method: "POST",
    token: installation.credential,
  });
  expect(response.status).toBe(200);
  const payload = await response.json<{ endpoint: { url: string } }>();
  const id = installation.installation.id;
  const state = await endpointState(id);
  const tunnel = cloudflare.tunnels.get(state.tunnel_name);
  if (!tunnel) throw new Error("fake tunnel missing");
  return { credential: installation.credential, id, state, tunnel, url: payload.endpoint.url };
}

/** Make an installation and its endpoint look untouched for `ageMs`. */
async function quiet(installationId: string, ageMs: number): Promise<void> {
  const at = Date.now() - ageMs;
  await env.DB.batch([
    env.DB.prepare("UPDATE installations SET created_at = ?, last_seen_at = ? WHERE id = ?")
      .bind(at, at, installationId),
    env.DB.prepare(
      `UPDATE installation_endpoints
          SET created_at = ?, updated_at = ?, last_reconciled_at = ?
        WHERE installation_id = ?`,
    ).bind(at, at, at, installationId),
  ]);
}

function neverRan(tunnel: FakeTunnel, createdDaysAgo: number): void {
  Object.assign(tunnel, {
    conns_active_at: null,
    conns_inactive_at: null,
    created_at: iso(Date.now() - createdDaysAgo * DAY_MS),
    status: "inactive",
  });
}

function offlineFor(tunnel: FakeTunnel, days: number): void {
  Object.assign(tunnel, {
    conns_active_at: null,
    conns_inactive_at: iso(Date.now() - days * DAY_MS),
    created_at: iso(Date.now() - 90 * DAY_MS),
    status: "down",
  });
}

function connected(tunnel: FakeTunnel, status = "healthy"): void {
  Object.assign(tunnel, {
    conns_active_at: iso(Date.now() - 60 * DAY_MS),
    conns_inactive_at: null,
    created_at: iso(Date.now() - 90 * DAY_MS),
    status,
  });
}

function deleteURLs(cloudflare: FakeCloudflare): string[] {
  return cloudflare.calls.filter((entry) => entry.method === "DELETE").map((entry) => entry.url);
}

function loggedJSON(spy: { mock: { calls: unknown[][] } }, message: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .flat()
    .filter((entry): entry is string => typeof entry === "string" && entry.includes(message))
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    .filter((entry) => entry.message === message);
}

describe("idle tunnel reclaim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reclaims idle tunnels through verified cleanup and leaves live or recently seen ones alone", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-owner@example.com");
    const neverConnected = await provisioned(worker, cloudflare, owner.token, "reclaim-never");
    const offline = await provisioned(worker, cloudflare, owner.token, "reclaim-offline");
    const healthy = await provisioned(worker, cloudflare, owner.token, "reclaim-healthy");
    const degraded = await provisioned(worker, cloudflare, owner.token, "reclaim-degraded");
    const recentlyDown = await provisioned(worker, cloudflare, owner.token, "reclaim-recent-down");
    const recentlySeen = await provisioned(worker, cloudflare, owner.token, "reclaim-recent-seen");
    const recentlyReconciled = await provisioned(worker, cloudflare, owner.token, "reclaim-recent-reconcile");
    const mismatched = await provisioned(worker, cloudflare, owner.token, "reclaim-mismatch");
    const all = [
      neverConnected, offline, healthy, degraded, recentlyDown, recentlySeen, recentlyReconciled, mismatched,
    ];
    for (const each of all) await quiet(each.id, 30 * DAY_MS);
    neverRan(neverConnected.tunnel, 8);
    offlineFor(offline.tunnel, 22);
    connected(healthy.tunnel);
    connected(degraded.tunnel, "degraded");
    // Below the seven-day floor of OMB_TUNNEL_OFFLINE_RECLAIM_DAYS, so never
    // idle whatever wrangler.jsonc configures.
    offlineFor(recentlyDown.tunnel, 5);
    neverRan(recentlySeen.tunnel, 30);
    neverRan(recentlyReconciled.tunnel, 30);
    neverRan(mismatched.tunnel, 30);
    // The stored ID no longer names the listed tunnel: ownership is unproven.
    await env.DB.prepare("UPDATE installation_endpoints SET tunnel_id = ? WHERE installation_id = ?")
      .bind("70000000-0000-4000-8000-000000000001", mismatched.id).run();
    // The app checked in an hour ago, or reconciled its endpoint yesterday.
    await env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?")
      .bind(Date.now() - 60 * 60 * 1_000, recentlySeen.id).run();
    await env.DB.prepare("UPDATE installation_endpoints SET updated_at = ? WHERE installation_id = ?")
      .bind(Date.now() - DAY_MS, recentlyReconciled.id).run();
    cloudflare.calls.length = 0;
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);

    for (const reclaimed of [neverConnected, offline]) {
      expect(await endpointState(reclaimed.id)).toMatchObject({
        dns_record_id: null,
        status: "deleted",
        tunnel_id: null,
      });
      expect(cloudflare.tunnels.has(reclaimed.state.tunnel_name)).toBe(false);
      expect(cloudflare.dns.has(reclaimed.state.hostname)).toBe(false);
    }
    const deletes = deleteURLs(cloudflare);
    expect(deletes).toHaveLength(4);
    for (const kept of [healthy, degraded, recentlyDown, recentlySeen, recentlyReconciled, mismatched]) {
      expect(await endpointState(kept.id)).toMatchObject({ reclaim_requested_at: null, status: "ready" });
      expect(cloudflare.tunnels.has(kept.state.tunnel_name)).toBe(true);
      expect(cloudflare.dns.has(kept.state.hostname)).toBe(true);
      expect(deletes.some((url) => url.includes(kept.tunnel.id))).toBe(false);
      expect(deletes.some((url) => url.includes(kept.state.dns_record_id ?? "missing"))).toBe(false);
    }
    const [scan] = loggedJSON(logged, "managed endpoint tunnel scan");
    expect(scan).toMatchObject({
      eligible: 2,
      // Provider-idle, but recently seen, recently reconciled, or mismatched.
      idle: { never_connected: 4, offline: 1 },
      managed: 8,
      marked: 2,
      reclaimMode: "on",
      unmatched: 0,
    });
    expect(loggedJSON(logged, "managed endpoint cleanup sweep")[0]).toMatchObject({ deleted: 2 });
    logged.mockRestore();

    // The installation was never signed out. Its next reconcile gets a fresh
    // tunnel behind the same hostname, so a paired phone keeps its address.
    await expect((await call(worker, "/v1/installations/self/endpoint", {
      token: neverConnected.credential,
    })).json()).resolves.toEqual({ endpoint: null });
    const returned = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: neverConnected.credential,
    });
    expect(returned.status).toBe(200);
    const payload = await returned.json<{ connectorToken: string; endpoint: { url: string } }>();
    expect(payload.endpoint.url).toBe(neverConnected.url);
    expect(payload.connectorToken).toBe(CONNECTOR_TOKEN);
    const recreated = cloudflare.tunnels.get(neverConnected.state.tunnel_name);
    expect(recreated?.id).toBeDefined();
    expect(recreated?.id).not.toBe(neverConnected.tunnel.id);
    expect(await endpointState(neverConnected.id)).toMatchObject({
      reclaim_requested_at: null,
      status: "ready",
      tunnel_id: recreated?.id,
    });
  });

  it("only logs candidates in observe mode and bounds marks per run", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-observe@example.com");
    const idle = await provisioned(worker, cloudflare, owner.token, "reclaim-observe");
    await quiet(idle.id, 30 * DAY_MS);
    neverRan(idle.tunnel, 30);
    cloudflare.calls.length = 0;
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker, { OMB_TUNNEL_RECLAIM: "observe" });

    expect(await endpointState(idle.id)).toMatchObject({ reclaim_requested_at: null, status: "ready" });
    expect(deleteURLs(cloudflare)).toHaveLength(0);
    expect(loggedJSON(logged, "managed endpoint tunnel scan")[0]).toMatchObject({
      eligible: 1,
      idle: { never_connected: 1, offline: 0 },
      marked: 0,
      reclaimMode: "observe",
    });
    logged.mockRestore();
  });

  it("never touches tunnels it cannot tie to an endpoint row", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const stale = iso(Date.now() - 90 * DAY_MS);
    cloudflare.tunnels.set("omb-c-ffffffffffffffffffffffffffffffff", {
      created_at: stale,
      id: "40000000-0000-4000-8000-000000000001",
      name: "omb-c-ffffffffffffffffffffffffffffffff",
      status: "inactive",
    });
    cloudflare.tunnels.set("another-service", {
      configSrc: "local",
      conns_inactive_at: stale,
      created_at: stale,
      id: "40000000-0000-4000-8000-000000000002",
      name: "another-service",
      status: "down",
    });
    // Over one scan page of unrelated tunnels: the cursor walks and wraps.
    for (let index = 0; index < 130; index += 1) {
      const name = `team-tunnel-${index}`;
      cloudflare.tunnels.set(name, {
        id: `50000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        name,
        status: "healthy",
      });
    }
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);
    const page = async () => (await env.DB.prepare(
      "SELECT scan_page, tunnel_count FROM managed_endpoint_account_capacity WHERE provider_account = ?",
    ).bind(PRIMARY_ACCOUNT).first<{ scan_page: number; tunnel_count: number }>());
    expect(await page()).toEqual({ scan_page: 2, tunnel_count: 132 });
    await runScheduledCleanup(worker);
    expect(await page()).toEqual({ scan_page: 1, tunnel_count: 132 });

    expect(deleteURLs(cloudflare)).toHaveLength(0);
    expect(cloudflare.tunnels.size).toBe(132);
    const scans = loggedJSON(logged, "managed endpoint tunnel scan");
    expect(scans.map((scan) => [scan.page, scan.returned, scan.managed, scan.unmatched])).toEqual([
      [1, 100, 1, 1],
      [2, 32, 0, 0],
    ]);
    logged.mockRestore();
  });

  it("never deletes a row its owner took back after the sweep chose it", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-race@example.com");
    const taken = await provisioned(worker, cloudflare, owner.token, "reclaim-race");
    await quiet(taken.id, 30 * DAY_MS);
    const markedAt = Date.now() - 60_000;
    await env.DB.prepare(
      `UPDATE installation_endpoints
          SET status = 'deleting', reclaim_requested_at = ?, delete_requested_at = ?
        WHERE installation_id = ?`,
    ).bind(markedAt, markedAt, taken.id).run();
    // The sweep has chosen the row. Before it claims it, the owner's app
    // provisions again and takes the row back.
    const back = await call(worker, "/v1/installations/self/endpoint", { method: "POST", token: taken.credential });
    expect(back.status).toBe(200);
    expect(await endpointState(taken.id)).toMatchObject({ status: "ready" });
    cloudflare.calls.length = 0;

    const outcome = await cleanupEndpointRow(env, readConfig(env), taken.id, cloudflare.fetch, "race-test", true);

    expect(outcome.result).toBe("skipped");
    expect(await endpointState(taken.id)).toMatchObject({ status: "ready" });
    expect(cloudflare.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("cancels a pending reclaim when the tunnel reconnects or the installation checks in", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-cancel@example.com");
    const reconnected = await provisioned(worker, cloudflare, owner.token, "reclaim-reconnected");
    const checkedIn = await provisioned(worker, cloudflare, owner.token, "reclaim-checked-in");
    const revoked = await provisioned(worker, cloudflare, owner.token, "reclaim-revoked");
    for (const each of [reconnected, checkedIn, revoked]) await quiet(each.id, 30 * DAY_MS);
    // Marked by an earlier run (or by hand: migration 0006 backfills the
    // marker onto operator-marked rows of active installations).
    const markedAt = Date.now() - 60_000;
    for (const each of [reconnected, checkedIn, revoked]) {
      await env.DB.prepare(
        `UPDATE installation_endpoints
            SET status = 'deleting', reclaim_requested_at = ?, delete_requested_at = ?
          WHERE installation_id = ?`,
      ).bind(markedAt, markedAt, each.id).run();
    }
    connected(reconnected.tunnel);
    neverRan(checkedIn.tunnel, 30);
    await env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?")
      .bind(Date.now(), checkedIn.id).run();
    // Revocation always wins, even over a live connector.
    connected(revoked.tunnel);
    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), revoked.id).run();
    cloudflare.calls.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);

    for (const kept of [reconnected, checkedIn]) {
      expect(await endpointState(kept.id)).toMatchObject({
        dns_record_id: kept.state.dns_record_id,
        reclaim_requested_at: null,
        status: "ready",
        tunnel_id: kept.tunnel.id,
      });
      expect(cloudflare.tunnels.has(kept.state.tunnel_name)).toBe(true);
      expect(cloudflare.dns.has(kept.state.hostname)).toBe(true);
    }
    expect(deleteURLs(cloudflare).some((url) => (
      url.includes(reconnected.tunnel.id) || url.includes(checkedIn.tunnel.id)
    ))).toBe(false);
    expect(await endpointState(revoked.id)).toMatchObject({ status: "deleted", tunnel_id: null });
    expect(cloudflare.tunnels.has(revoked.state.tunnel_name)).toBe(false);
    vi.restoreAllMocks();
  });

  it("stops a reclaim that is already underway when the tunnel reconnects mid-cleanup", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-midway@example.com");
    const midway = await provisioned(worker, cloudflare, owner.token, "reclaim-midway");
    await quiet(midway.id, 30 * DAY_MS);
    neverRan(midway.tunnel, 30);
    // The connector comes back between the DNS delete and the tunnel delete.
    cloudflare.afterHooks.set("delete_dns", () => connected(midway.tunnel));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);

    expect(cloudflare.tunnels.get(midway.state.tunnel_name)?.id).toBe(midway.tunnel.id);
    expect(deleteURLs(cloudflare).some((url) => url.includes(midway.tunnel.id))).toBe(false);
    expect(await endpointState(midway.id)).toMatchObject({
      dns_record_id: null,
      last_error_code: "reclaim_cancelled",
      reclaim_requested_at: null,
      status: "error",
      tunnel_id: midway.tunnel.id,
    });

    // The next reconcile adopts the surviving tunnel and restores its DNS.
    cloudflare.afterHooks.clear();
    const tunnelCreates = () => cloudflare.calls.filter((entry) => (
      entry.method === "POST" && new URL(entry.url).pathname.endsWith("/cfd_tunnel")
    )).length;
    const createsBefore = tunnelCreates();
    const repaired = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: midway.credential,
    });
    expect(repaired.status).toBe(200);
    expect(tunnelCreates()).toBe(createsBefore);
    expect(cloudflare.dns.get(midway.state.hostname)?.content).toBe(`${midway.tunnel.id}.cfargotunnel.com`);
    vi.restoreAllMocks();
  });

  it("lets a returning installation take back a pending reclaim but not an owner deletion", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-return@example.com");
    const reclaimed = await provisioned(worker, cloudflare, owner.token, "reclaim-return");
    const ownerDeleting = await provisioned(worker, cloudflare, owner.token, "owner-deleting");
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE installation_endpoints
          SET status = 'deleting', reclaim_requested_at = ?, delete_requested_at = ?
        WHERE installation_id = ?`,
    ).bind(now, now, reclaimed.id).run();
    await env.DB.prepare(
      `UPDATE installation_endpoints
          SET status = 'deleting', delete_requested_at = ?
        WHERE installation_id = ?`,
    ).bind(now, ownerDeleting.id).run();
    cloudflare.calls.length = 0;

    const back = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: reclaimed.credential,
    });
    expect(back.status).toBe(200);
    await expect(back.json()).resolves.toMatchObject({ endpoint: { url: reclaimed.url } });
    expect(await endpointState(reclaimed.id)).toMatchObject({
      reclaim_requested_at: null,
      status: "ready",
      tunnel_id: reclaimed.tunnel.id,
    });
    expect(cloudflare.calls.some((entry) => entry.method === "POST" || entry.method === "DELETE")).toBe(false);

    const blocked = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: ownerDeleting.credential,
    });
    expect(blocked.status).toBe(409);
    expect(await endpointState(ownerDeleting.id)).toMatchObject({ status: "deleting" });
  });

  it("lets the owner delete an endpoint that has a pending reclaim, even if it reconnected", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "reclaim-owner-delete@example.com");
    const endpoint = await provisioned(worker, cloudflare, owner.token, "reclaim-owner-delete");
    await quiet(endpoint.id, 30 * DAY_MS);
    const markedAt = Date.now() - 60_000;
    await env.DB.prepare(
      `UPDATE installation_endpoints
          SET status = 'deleting', reclaim_requested_at = ?, delete_requested_at = ?
        WHERE installation_id = ?`,
    ).bind(markedAt, markedAt, endpoint.id).run();
    connected(endpoint.tunnel);

    const deleted = await call(worker, "/v1/installations/self/endpoint", {
      method: "DELETE",
      token: endpoint.credential,
    });
    expect(deleted.status).toBe(204);
    expect(await endpointState(endpoint.id)).toMatchObject({
      dns_record_id: null,
      reclaim_requested_at: null,
      status: "deleted",
      tunnel_id: null,
    });
    expect(cloudflare.tunnels.has(endpoint.state.tunnel_name)).toBe(false);
  });

  it("stops starting cleanup rows once Cloudflare rate-limits the token", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 12 }, (_, index) => {
      const opaque = (index + 0x100).toString(16).padStart(32, "0");
      return env.DB.prepare(
        `INSERT INTO installation_endpoints
          (installation_id, hostname, tunnel_name, status, delete_requested_at, created_at, updated_at)
         VALUES (?, ?, ?, 'deleting', ?, ?, ?)`,
      ).bind(`orphan-limited-${index}`, `c-${opaque}.${HOST_SUFFIX}`, `omb-c-${opaque}`, now, now, now);
    }));
    cloudflare.rateLimited.add("list_tunnels");
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);

    const attempted = await env.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(last_error_code) AS code
         FROM installation_endpoints WHERE cleanup_attempts > 0`,
    ).first<{ code: string; count: number }>();
    expect(attempted?.count).toBeGreaterThan(0);
    expect(attempted?.count).toBeLessThanOrEqual(5);
    expect(attempted?.code).toBe("cf_rate_limited");
    expect(loggedJSON(logged, "managed endpoint cleanup sweep")[0]).toMatchObject({ rateLimited: true });
    vi.restoreAllMocks();
  });
});

/** When Cloudflare last refused the account a new resource; no row is never. */
async function capacityRejectedAt(account: string = PRIMARY_ACCOUNT): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT capacity_rejected_at FROM managed_endpoint_account_capacity WHERE provider_account = ?",
  ).bind(account).first<{ capacity_rejected_at: number | null }>();
  return row?.capacity_rejected_at ?? null;
}

describe("managed endpoint provider capacity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an exhausted tunnel quota as endpoint_capacity and answers locally while it lasts", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "capacity-owner@example.com");
    const established = await provisioned(worker, cloudflare, owner.token, "capacity-established");
    const first = await createInstallation(worker, owner.token, "capacity-first");
    const second = await createInstallation(worker, owner.token, "capacity-second");
    cloudflare.providerErrors.set("create_tunnel", 1_045);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const rejected = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: first.credential,
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("600");
    await expect(rejected.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(first.installation.id)).toMatchObject({
      last_error_code: "cf_api_1045",
      status: "error",
      tunnel_id: null,
    });
    expect(loggedJSON(logged, "managed endpoint reconcile failed")[0]).toMatchObject({
      capacity: true,
      errorCode: "cf_api_1045",
    });

    // A second new allocation is answered without touching the shared API.
    const callsBefore = cloudflare.calls.length;
    const deferred = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: second.credential,
    });
    expect(deferred.status).toBe(503);
    await expect(deferred.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(cloudflare.calls.length).toBe(callsBefore);

    // An installation that already holds a tunnel still reconciles normally.
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: established.credential,
    })).status).toBe(200);

    const health = await call(worker, "/healthz");
    const healthBody = await health.json<{ capacity: { providerRejectedAt: number | null; status: string } }>();
    expect(healthBody.capacity.status).toBe("full");
    expect(healthBody.capacity.providerRejectedAt).toEqual(expect.any(Number));

    // Cleanup that frees a resource reopens allocation before the gate expires.
    cloudflare.providerErrors.clear();
    const now = Date.now();
    cloudflare.tunnels.set(`omb-c-${"e".repeat(32)}`, {
      id: "60000000-0000-4000-8000-000000000001",
      name: `omb-c-${"e".repeat(32)}`,
    });
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, status, delete_requested_at, created_at, updated_at)
       VALUES ('orphan-capacity', ?, ?, 'deleting', ?, ?, ?)`,
    ).bind(`c-${"e".repeat(32)}.${HOST_SUFFIX}`, `omb-c-${"e".repeat(32)}`, now, now, now).run();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runScheduledCleanup(worker);
    expect(await capacityRejectedAt()).toBeNull();
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: second.credential,
    })).status).toBe(200);
    vi.restoreAllMocks();
  });

  it("reports a quota rejection and its clearing in /healthz without waiting for the cached copy", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "capacity-health@example.com");
    const installation = await createInstallation(worker, owner.token, "capacity-health");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    type Health = { capacity: { providerRejectedAt: number | null; status: string } };
    const health = async () => (await (await call(worker, "/healthz")).json<Health>()).capacity;

    expect(await health()).toMatchObject({ providerRejectedAt: null, status: "unknown" });
    cloudflare.providerErrors.set("create_tunnel", 1_045);
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: installation.credential,
    })).status).toBe(503);
    expect(await health()).toMatchObject({ providerRejectedAt: expect.any(Number), status: "full" });

    // The sweep alone (no scan) frees a resource and clears the rejection.
    cloudflare.providerErrors.clear();
    const now = Date.now();
    const tunnelName = `omb-c-${"f".repeat(32)}`;
    cloudflare.tunnels.set(tunnelName, { id: "60000000-0000-4000-8000-000000000002", name: tunnelName });
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, status, delete_requested_at, created_at, updated_at)
       VALUES ('orphan-health', ?, ?, 'deleting', ?, ?, ?)`,
    ).bind(`c-${"f".repeat(32)}.${HOST_SUFFIX}`, tunnelName, now, now, now).run();
    const swept = await sweepManagedEndpointCleanup(env, readConfig(env), cloudflare.fetch, crypto.randomUUID());
    expect(swept.deleted).toBe(1);
    expect(await health()).toMatchObject({ providerRejectedAt: null, status: "unknown" });
    vi.restoreAllMocks();
  });

  it("treats the DNS record quota as capacity and keeps other failures as endpoint_unavailable", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "capacity-dns@example.com");
    const dnsFull = await createInstallation(worker, owner.token, "capacity-dns");
    const other = await createInstallation(worker, owner.token, "capacity-other");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    cloudflare.providerErrors.set("create_dns", 81_045);
    const rejected = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: dnsFull.credential,
    });
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toEqual({ error: "endpoint_capacity" });
    // The tunnel this attempt created was rolled back rather than left idle.
    expect(cloudflare.tunnels.size).toBe(0);

    cloudflare.providerErrors.clear();
    await env.DB.prepare(
      "UPDATE managed_endpoint_account_capacity SET capacity_rejected_at = NULL WHERE provider_account = ?",
    ).bind(PRIMARY_ACCOUNT).run();
    cloudflare.failures.add("create_tunnel");
    const unavailable = await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: other.credential,
    });
    expect(unavailable.status).toBe(502);
    await expect(unavailable.json()).resolves.toEqual({ error: "endpoint_unavailable" });
    expect(await capacityRejectedAt()).toBeNull();
    vi.restoreAllMocks();
  });

  it("reports a Cloudflare API 429 as endpoint_rate_limited with a bounded Retry-After", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "rate-limited@example.com");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cloudflare.rateLimited.add("create_tunnel");

    // [Cloudflare's Retry-After, what the desktop is told]
    const cases: Array<[string | null, string]> = [
      [null, "60"],
      ["120", "120"],
      ["1", "30"],
      ["3600", "300"],
      ["Wed, 21 Oct 2026 07:28:00 GMT", "60"],
    ];
    for (const [index, [providerRetryAfter, expected]] of cases.entries()) {
      cloudflare.rateLimitRetryAfter = providerRetryAfter;
      const installation = await createInstallation(worker, owner.token, `rate-limited-${index}`);
      const limited = await call(worker, "/v1/installations/self/endpoint", {
        method: "POST",
        token: installation.credential,
      });
      expect(limited.status).toBe(503);
      expect(limited.headers.get("retry-after")).toBe(expected);
      await expect(limited.json()).resolves.toEqual({ error: "endpoint_rate_limited" });
      expect(await endpointState(installation.installation.id)).toMatchObject({
        last_error_code: "cf_rate_limited",
        status: "error",
      });
    }
    expect(loggedJSON(logged, "managed endpoint reconcile failed")[0]).toMatchObject({
      capacity: false,
      errorCode: "cf_rate_limited",
    });
    // A rate limit is not a quota: it must not close the capacity gate.
    expect(await capacityRejectedAt()).toBeNull();

    // Once Cloudflare stops pushing back, the next attempt provisions.
    cloudflare.rateLimited.clear();
    const recovered = await createInstallation(worker, owner.token, "rate-limited-recovered");
    expect((await call(worker, "/v1/installations/self/endpoint", {
      method: "POST",
      token: recovered.credential,
    })).status).toBe(200);
    vi.restoreAllMocks();
  });

  it("alerts above 90% of the configured limits and reports usage in /healthz without secrets", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    cloudflare.tunnelTotalCount = 950;
    cloudflare.dnsTotalCount = 400;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);
    const alerts = loggedJSON(errors, "managed endpoint capacity high");
    expect(alerts).toEqual([expect.objectContaining({
      alert: "managed_endpoint_capacity",
      full: false,
      limit: 1000,
      resource: "tunnels",
      thresholdPercent: 90,
      usagePercent: 95,
      used: 950,
    })]);

    const response = await call(worker, "/healthz");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      service: "openmausbot-control-plane",
      capacity: {
        checkedAt: expect.any(Number),
        dnsRecords: { limit: 1000, used: 400 },
        providerRejectedAt: null,
        reclaim: { mode: "on", pending: 0 },
        status: "high",
        tunnels: { limit: 1000, used: 950 },
      },
    });
    for (const secret of [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ZONE_ID]) {
      expect(text).not.toContain(secret);
    }

    // A raised limit silences the alert; reaching it reports full.
    errors.mockClear();
    await runScheduledCleanup(worker, { OMB_TUNNEL_LIMIT: "2000" });
    expect(loggedJSON(errors, "managed endpoint capacity high")).toEqual([]);
    cloudflare.tunnelTotalCount = 1000;
    cloudflare.dnsTotalCount = 990;
    await runScheduledCleanup(worker);
    expect(loggedJSON(errors, "managed endpoint capacity high")).toEqual([
      expect.objectContaining({ full: true, resource: "tunnels", used: 1000 }),
      expect.objectContaining({ full: false, resource: "dns_records", used: 990 }),
    ]);
    const full = await (await call(worker, "/healthz")).json<{ capacity: { status: string } }>();
    expect(full.capacity.status).toBe("full");
    vi.restoreAllMocks();
  });
});

// ── Several Cloudflare accounts ─────────────────────────────────────────

const ENDPOINT_PATH = "/v1/installations/self/endpoint";
const SECOND_ACCOUNT_ID = "2b".repeat(16);
const SECOND_ZONE_ID = "3c".repeat(16);
const SECOND_SUFFIX = "mausbot.si";
const SECOND_TOKEN_SECRET = "CLOUDFLARE_API_TOKEN_MAUSBOT_SI";
const SECOND_TOKEN = "test-only-mausbot-si-api-token-with-no-real-access";

interface AccountsFixture {
  env: Env;
  first: FakeCloudflare;
  second: FakeCloudflare;
  vars: Record<string, string>;
  /** Requests no configured account owns, or that carry another account's token. */
  violations: string[];
  worker: TestWorker;
}

/** The primary account plus mausbot.si in a second account, each with its
 * own fake API behind a router that checks every request's token. */
function twoAccounts(entry: Record<string, unknown> = {}): AccountsFixture {
  const first = new FakeCloudflare();
  const second = new FakeCloudflare("b");
  const violations: string[] = [];
  const owners = new Map([
    [`accounts/${PRIMARY_ACCOUNT}`, { fake: first, token: env.CLOUDFLARE_API_TOKEN }],
    [`zones/${env.CLOUDFLARE_ZONE_ID}`, { fake: first, token: env.CLOUDFLARE_API_TOKEN }],
    [`accounts/${SECOND_ACCOUNT_ID}`, { fake: second, token: SECOND_TOKEN }],
    [`zones/${SECOND_ZONE_ID}`, { fake: second, token: SECOND_TOKEN }],
  ]);
  const fetch: CloudflareFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const scope = /^\/client\/v4\/((?:accounts|zones)\/[^/]+)\//.exec(url.pathname)?.[1] ?? "";
    const owner = owners.get(scope);
    if (!owner) {
      violations.push(`no configured account owns ${url.pathname}`);
      return Response.json({ errors: [{ code: 10_000 }], result: null, success: false }, { status: 403 });
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${owner.token}`) {
      violations.push(`another account's token was sent to ${scope}`);
    }
    return owner.fake.fetch(input, init);
  };
  const vars = {
    CLOUDFLARE_ENDPOINT_ACCOUNTS: JSON.stringify([{
      accountId: SECOND_ACCOUNT_ID,
      zoneId: SECOND_ZONE_ID,
      companionHostSuffix: SECOND_SUFFIX,
      apiTokenSecret: SECOND_TOKEN_SECRET,
      ...entry,
    }]),
    [SECOND_TOKEN_SECRET]: SECOND_TOKEN,
  };
  return { env: { ...env, ...vars } as Env, first, second, vars, violations, worker: createWorker(fetch) };
}

interface SnapshotFields {
  capacity_rejected_at?: number | null;
  capacity_rejected_code?: string | null;
  checked_at?: number | null;
  dns_record_count?: number | null;
  dormant_endpoints?: number;
  tunnel_count?: number | null;
}

/** An account's capacity row as a scan (scanned now unless told otherwise)
 * and any refusal left it. */
async function setSnapshot(account: string, fields: SnapshotFields): Promise<void> {
  const row = {
    capacity_rejected_at: null,
    capacity_rejected_code: null,
    checked_at: Date.now(),
    dns_record_count: null,
    dormant_endpoints: 0,
    tunnel_count: null,
    ...fields,
  };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO managed_endpoint_account_capacity
       (provider_account, tunnel_count, dns_record_count, dormant_endpoints, checked_at,
        capacity_rejected_at, capacity_rejected_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).bind(
    account,
    row.tunnel_count,
    row.dns_record_count,
    row.dormant_endpoints,
    row.checked_at,
    row.capacity_rejected_at,
    row.capacity_rejected_code,
  ).run();
}

/** The primary account is out of tunnels and has refused one; the second has room. */
async function primaryRefusing(): Promise<void> {
  await setSnapshot(PRIMARY_ACCOUNT, {
    capacity_rejected_at: Date.now(),
    capacity_rejected_code: "cf_tunnel_quota",
    tunnel_count: 1000,
  });
  await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 10 });
}

async function provisionIn(
  fixture: AccountsFixture,
  accountToken: string,
  clientInstanceId: string,
  options: { appVersion?: string; body?: unknown } = {},
) {
  const installation = await createInstallation(fixture.worker, accountToken, clientInstanceId, options.appVersion);
  const response = await call(fixture.worker, ENDPOINT_PATH, {
    body: options.body,
    env: fixture.env,
    method: "POST",
    token: installation.credential,
  });
  return { credential: installation.credential, id: installation.installation.id, response };
}

/** What a finished idle reclaim leaves: no tunnel or record, while the row
 * keeps its hostname and account for the owner's return. */
async function reclaimedEarlier(fake: FakeCloudflare, installationId: string): Promise<EndpointState> {
  const state = await endpointState(installationId);
  fake.tunnels.delete(state.tunnel_name);
  fake.dns.delete(state.hostname);
  const at = Date.now() - DAY_MS;
  await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = 'deleted', tunnel_id = NULL, dns_record_id = NULL,
            reclaim_requested_at = ?, delete_requested_at = ?
      WHERE installation_id = ?`,
  ).bind(at, at, installationId).run();
  return state;
}

/** A row the sweep deletes (its installation is gone) whose tunnel and
 * record are live in `fake`. */
async function orphanIn(
  fake: FakeCloudflare,
  account: string,
  suffix: string,
  opaque: string,
  deleteRequestedAt = Date.now(),
) {
  const installationId = `orphan-${opaque}`;
  const tunnelName = `omb-c-${opaque}`;
  const hostname = `c-${opaque}.${suffix}`;
  const tunnelId = `${opaque.slice(0, 8)}-0000-4000-8000-${opaque.slice(-12)}`;
  fake.tunnels.set(tunnelName, { id: tunnelId, name: tunnelName });
  fake.dns.set(hostname, {
    content: `${tunnelId}.cfargotunnel.com`,
    id: `dns-${opaque}`,
    name: hostname,
    proxied: true,
    type: "CNAME",
  });
  await env.DB.prepare(
    `INSERT INTO installation_endpoints
      (installation_id, provider_account, hostname, tunnel_name, status, delete_requested_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'deleting', ?, ?, ?)`,
  ).bind(installationId, account, hostname, tunnelName, deleteRequestedAt, deleteRequestedAt, deleteRequestedAt).run();
  return { hostname, installationId, tunnelName };
}

const ON_SECOND_ACCOUNT = /^c-[0-9a-f]{32}\.mausbot\.si$/;

describe("managed endpoints in several Cloudflare accounts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a new endpoint in the account with the most room, with that account's token only", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-room@example.com");
    // Room: 10 tunnels in the primary account, 990 in the second.
    await setSnapshot(PRIMARY_ACCOUNT, { dns_record_count: 400, tunnel_count: 990 });
    await setSnapshot(SECOND_ACCOUNT_ID, { dns_record_count: 4, tunnel_count: 10 });

    const created = await provisionIn(fixture, owner.token, "accounts-room");
    expect(created.response.status).toBe(200);
    const payload = await created.response.json<{
      connectorToken: string;
      endpoint: { hostname: string; url: string };
    }>();
    expect(payload.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(payload.endpoint.hostname).toMatch(ON_SECOND_ACCOUNT);
    expect(payload.endpoint.url).toBe(`https://${payload.endpoint.hostname}`);
    const state = await endpointState(created.id);
    expect(state).toMatchObject({
      hostname: payload.endpoint.hostname,
      provider_account: SECOND_ACCOUNT_ID,
      status: "ready",
    });
    const tunnel = fixture.second.tunnels.get(state.tunnel_name);
    expect(tunnel?.id).toBe(state.tunnel_id);
    expect(fixture.second.dns.get(payload.endpoint.hostname)).toMatchObject({
      content: `${tunnel?.id}.cfargotunnel.com`,
      proxied: true,
    });
    expect(fixture.first.calls).toEqual([]);
    expect(fixture.violations).toEqual([]);
  });

  it("moves a new endpoint in the same request when its account answers 429 at the tunnel cap", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-cap@example.com");
    // At the last scan the primary account had the most room. It has filled
    // since, and Cloudflare now answers its tunnel creation with a 429.
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 500 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 900 });
    fixture.first.tunnelTotalCount = 1000;
    fixture.first.rateLimited.add("create_tunnel");
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const moved = await provisionIn(fixture, owner.token, "accounts-cap");
    expect(moved.response.status).toBe(200);
    const payload = await moved.response.json<{ endpoint: { hostname: string } }>();
    expect(payload.endpoint.hostname).toMatch(ON_SECOND_ACCOUNT);
    expect(await endpointState(moved.id)).toMatchObject({
      hostname: payload.endpoint.hostname,
      provider_account: SECOND_ACCOUNT_ID,
      status: "ready",
    });
    // Nothing is left in the full account: list, refused create, tunnel
    // count, and the two lookups that prove the row may move.
    expect(fixture.first.tunnels.size).toBe(0);
    expect(fixture.first.dns.size).toBe(0);
    expect(fixture.first.calls.map((entry) => entry.method)).toEqual(["GET", "POST", "GET", "GET", "GET"]);
    const gate = await env.DB.prepare(
      `SELECT capacity_rejected_at, capacity_rejected_code
         FROM managed_endpoint_account_capacity WHERE provider_account = ?`,
    ).bind(PRIMARY_ACCOUNT).first();
    expect(gate).toEqual({ capacity_rejected_at: expect.any(Number), capacity_rejected_code: "cf_tunnel_quota" });
    expect(loggedJSON(logged, "managed endpoint relocated")).toEqual([
      expect.objectContaining({ from: HOST_SUFFIX, to: SECOND_SUFFIX }),
    ]);

    // The full account is closed, so the next new installation goes straight
    // to the second one.
    const callsBefore = fixture.first.calls.length;
    const next = await provisionIn(fixture, owner.token, "accounts-cap-next");
    expect(next.response.status).toBe(200);
    expect(await endpointState(next.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID });
    expect(fixture.first.calls).toHaveLength(callsBefore);
    expect(fixture.violations).toEqual([]);
  });

  it("treats a 429 at the tunnel cap as capacity when there is only one account", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "single-cap@example.com");
    const first = await createInstallation(worker, owner.token, "single-cap-first");
    const second = await createInstallation(worker, owner.token, "single-cap-second");
    cloudflare.tunnelTotalCount = 1000;
    cloudflare.rateLimited.add("create_tunnel");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const refused = await call(worker, ENDPOINT_PATH, { method: "POST", token: first.credential });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("600");
    await expect(refused.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(first.installation.id)).toMatchObject({
      last_error_code: "cf_tunnel_quota",
      provider_account: PRIMARY_ACCOUNT,
      status: "error",
      tunnel_id: null,
    });
    expect(loggedJSON(errors, "managed endpoint reconcile failed")).toEqual([expect.objectContaining({
      capacity: true,
      errorCode: "cf_tunnel_quota",
      hostSuffix: HOST_SUFFIX,
    })]);
    expect(await capacityRejectedAt()).toEqual(expect.any(Number));
    expect(cloudflare.tunnels.size).toBe(0);

    // Further new allocations are answered without spending API budget.
    const callsBefore = cloudflare.calls.length;
    const deferred = await call(worker, ENDPOINT_PATH, { method: "POST", token: second.credential });
    expect(deferred.status).toBe(503);
    await expect(deferred.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(cloudflare.calls).toHaveLength(callsBefore);
    const health = await (await call(worker, "/healthz")).json<{
      capacity: { providerRejectedAt: number | null; status: string };
    }>();
    expect(health.capacity).toMatchObject({ providerRejectedAt: expect.any(Number), status: "full" });
  });

  it("uses a fresh scan to classify a create 429 when the tunnel count is rate limited too", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "cap-from-scan@example.com");
    const installation = await createInstallation(worker, owner.token, "cap-from-scan");
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 1000 });
    cloudflare.rateLimited.add("create_tunnel");
    cloudflare.rateLimited.add("scan_tunnels");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const refused = await call(worker, ENDPOINT_PATH, { method: "POST", token: installation.credential });
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(installation.installation.id)).toMatchObject({ last_error_code: "cf_tunnel_quota" });

    // So does a count that comes back without a total.
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 1000 });
    cloudflare.rateLimited.delete("scan_tunnels");
    cloudflare.omitTunnelTotal = true;
    const untotalled = await createInstallation(worker, owner.token, "cap-from-scan-untotalled");
    const refusedAgain = await call(worker, ENDPOINT_PATH, { method: "POST", token: untotalled.credential });
    expect(refusedAgain.status).toBe(503);
    await expect(refusedAgain.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(untotalled.installation.id)).toMatchObject({ last_error_code: "cf_tunnel_quota" });
  });

  it("judges a create 429 by the scan less what cleanup has deleted since", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "cap-after-sweep@example.com");
    const installation = await createInstallation(worker, owner.token, "cap-after-sweep");
    // The cron's scan finds the account at its tunnel limit; its sweep then
    // deletes a revoked endpoint's tunnel and record.
    const orphan = await orphanIn(cloudflare, PRIMARY_ACCOUNT, HOST_SUFFIX, "a".repeat(32));
    cloudflare.tunnelTotalCount = 1000;
    cloudflare.dnsTotalCount = 500;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runScheduledCleanup(worker);
    expect(await endpointState(orphan.installationId)).toMatchObject({ status: "deleted" });
    expect(await env.DB.prepare(
      "SELECT tunnel_count, dns_record_count FROM managed_endpoint_account_capacity WHERE provider_account = ?",
    ).bind(PRIMARY_ACCOUNT).first()).toEqual({ dns_record_count: 499, tunnel_count: 999 });

    // Minutes later the token is rate limited: creation and the count both
    // answer 429. The account has a free tunnel, so that is no quota.
    cloudflare.rateLimited.add("create_tunnel");
    cloudflare.rateLimited.add("scan_tunnels");
    const limited = await call(worker, ENDPOINT_PATH, { method: "POST", token: installation.credential });
    expect(limited.status).toBe(503);
    await expect(limited.json()).resolves.toEqual({ error: "endpoint_rate_limited" });
    expect(await endpointState(installation.installation.id)).toMatchObject({ last_error_code: "cf_rate_limited" });
    expect(await capacityRejectedAt()).toBeNull();
  });

  it("keeps a 429 below the tunnel cap a rate limit that closes nothing and moves nothing", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-throttled@example.com");
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 500 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 900 });
    fixture.first.tunnelTotalCount = 500;
    fixture.first.rateLimited.add("create_tunnel");
    fixture.first.rateLimitRetryAfter = "120";
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const throttled = await provisionIn(fixture, owner.token, "accounts-throttled");
    expect(throttled.response.status).toBe(503);
    expect(throttled.response.headers.get("retry-after")).toBe("120");
    await expect(throttled.response.json()).resolves.toEqual({ error: "endpoint_rate_limited" });
    const state = await endpointState(throttled.id);
    expect(state).toMatchObject({ last_error_code: "cf_rate_limited", provider_account: PRIMARY_ACCOUNT, status: "error" });
    expect(state.hostname.endsWith(`.${HOST_SUFFIX}`)).toBe(true);
    expect(await capacityRejectedAt(PRIMARY_ACCOUNT)).toBeNull();

    // When the count is rate limited as well, a missing scan cannot prove
    // the cap either.
    fixture.first.rateLimited.add("scan_tunnels");
    await env.DB.prepare("DELETE FROM managed_endpoint_account_capacity").run();
    const unproven = await provisionIn(fixture, owner.token, "accounts-unproven");
    expect(unproven.response.status).toBe(503);
    await expect(unproven.response.json()).resolves.toEqual({ error: "endpoint_rate_limited" });
    expect(await endpointState(unproven.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });
    expect(await capacityRejectedAt(PRIMARY_ACCOUNT)).toBeNull();
    expect(fixture.second.calls).toEqual([]);
    expect(fixture.violations).toEqual([]);
  });

  it("never moves an endpoint that handed out its address", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-stay@example.com");
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 10 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 900 });
    const kept = await provisionIn(fixture, owner.token, "accounts-stay-ready");
    const away = await provisionIn(fixture, owner.token, "accounts-stay-away");
    expect([kept.response.status, away.response.status]).toEqual([200, 200]);
    const keptState = await endpointState(kept.id);
    const awayState = await reclaimedEarlier(fixture.first, away.id);
    expect(keptState.provider_account).toBe(PRIMARY_ACCOUNT);
    await primaryRefusing();
    fixture.first.providerErrors.set("create_tunnel", 1_045);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Renewal adopts the endpoint's own tunnel in its own account.
    const renewed = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: kept.credential });
    expect(renewed.status).toBe(200);
    await expect(renewed.json()).resolves.toMatchObject({ endpoint: { hostname: keptState.hostname } });
    expect(await endpointState(kept.id)).toMatchObject({
      provider_account: PRIMARY_ACCOUNT,
      status: "ready",
      tunnel_id: keptState.tunnel_id,
    });

    // A reclaimed endpoint waits for a slot in its own account rather than
    // taking a new address elsewhere.
    const waiting = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: away.credential });
    expect(waiting.status).toBe(503);
    await expect(waiting.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(away.id)).toMatchObject({
      hostname: awayState.hostname,
      provider_account: PRIMARY_ACCOUNT,
      status: "deleted",
    });
    expect(fixture.second.calls).toEqual([]);

    // Cleanup frees a resource in the primary account: the owner gets the
    // same address back there.
    await orphanIn(fixture.first, PRIMARY_ACCOUNT, HOST_SUFFIX, "d".repeat(32));
    fixture.first.providerErrors.clear();
    await runScheduledCleanup(fixture.worker, fixture.vars);
    expect(await capacityRejectedAt(PRIMARY_ACCOUNT)).toBeNull();
    const back = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: away.credential });
    expect(back.status).toBe(200);
    await expect(back.json()).resolves.toMatchObject({ endpoint: { url: `https://${awayState.hostname}` } });
    const returned = await endpointState(away.id);
    expect(returned).toMatchObject({ hostname: awayState.hostname, provider_account: PRIMARY_ACCOUNT, status: "ready" });
    expect(fixture.first.tunnels.get(awayState.tunnel_name)?.id).toBe(returned.tunnel_id);
    expect(fixture.second.tunnels.size).toBe(0);
    expect(fixture.violations).toEqual([]);
  });

  it("moves a row that never got an endpoint, but adopts a tunnel an interrupted request left", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-stuck@example.com");
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 1000 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 10 });
    fixture.first.tunnelTotalCount = 1000;
    fixture.first.rateLimited.add("create_tunnel");
    // Rows the primary account's 429s left in error before there was a second account.
    const stuck = await createInstallation(fixture.worker, owner.token, "accounts-stuck");
    const interrupted = await createInstallation(fixture.worker, owner.token, "accounts-interrupted");
    const now = Date.now();
    for (const [installation, opaque] of [[stuck, "5".repeat(32)], [interrupted, "6".repeat(32)]] as const) {
      await env.DB.prepare(
        `INSERT INTO installation_endpoints
          (installation_id, hostname, tunnel_name, status, last_error_code, created_at, updated_at)
         VALUES (?, ?, ?, 'error', 'cf_rate_limited', ?, ?)`,
      ).bind(installation.installation.id, `c-${opaque}.${HOST_SUFFIX}`, `omb-c-${opaque}`, now, now).run();
    }
    // An earlier create for the second row committed before its response was lost.
    const leftBehind: FakeTunnel = { id: "60000000-0000-4000-8000-000000000066", name: `omb-c-${"6".repeat(32)}` };
    fixture.first.tunnels.set(leftBehind.name, leftBehind);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const moved = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: stuck.credential });
    expect(moved.status).toBe(200);
    expect(await endpointState(stuck.installation.id)).toMatchObject({
      hostname: expect.stringMatching(ON_SECOND_ACCOUNT),
      provider_account: SECOND_ACCOUNT_ID,
      status: "ready",
    });

    const adopted = await call(fixture.worker, ENDPOINT_PATH, {
      env: fixture.env,
      method: "POST",
      token: interrupted.credential,
    });
    expect(adopted.status).toBe(200);
    expect(await endpointState(interrupted.installation.id)).toMatchObject({
      hostname: `c-${"6".repeat(32)}.${HOST_SUFFIX}`,
      provider_account: PRIMARY_ACCOUNT,
      status: "ready",
      tunnel_id: leftBehind.id,
    });
    expect(fixture.second.tunnels.size).toBe(1);
    expect(fixture.violations).toEqual([]);
  });

  it("gives an account with minAppVersion only to installations that report at least that release", async () => {
    const fixture = twoAccounts({ minAppVersion: "0.1.103" });
    const owner = await signIn(fixture.worker, "accounts-version@example.com");
    await primaryRefusing();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Registered by a release that cannot pair a desktop with mausbot.si: it
    // stays with the full account.
    const old = await provisionIn(fixture, owner.token, "accounts-version", { appVersion: "0.1.102" });
    expect(old.response.status).toBe(503);
    await expect(old.response.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(old.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });

    // The same installation, updated, says so with its next request and moves.
    const updated = await call(fixture.worker, ENDPOINT_PATH, {
      body: { appVersion: "0.1.103" },
      env: fixture.env,
      method: "POST",
      token: old.credential,
    });
    expect(updated.status).toBe(200);
    expect(await endpointState(old.id)).toMatchObject({
      hostname: expect.stringMatching(ON_SECOND_ACCOUNT),
      provider_account: SECOND_ACCOUNT_ID,
    });
    const recorded = await env.DB.prepare("SELECT app_version FROM installations WHERE id = ?")
      .bind(old.id).first<{ app_version: string | null }>();
    expect(recorded?.app_version).toBe("0.1.103");

    // A prerelease of the minimum, an unknown version, or none never qualifies.
    for (const [index, appVersion] of ["0.1.103-beta.1", "unknown", undefined].entries()) {
      const gated = await provisionIn(fixture, owner.token, `accounts-version-${index}`, {
        body: appVersion === undefined ? undefined : { appVersion },
      });
      expect(gated.response.status, appVersion).toBe(503);
      expect(await endpointState(gated.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });
    }
    expect(fixture.second.tunnels.size).toBe(1);
    expect(fixture.violations).toEqual([]);
  });

  it("rejects a malformed endpoint request body before any provider call", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-body@example.com");
    const installation = await createInstallation(fixture.worker, owner.token, "accounts-body", "0.1.102");
    const post = (options: CallOptions) => call(fixture.worker, ENDPOINT_PATH, {
      env: fixture.env,
      method: "POST",
      token: installation.credential,
      ...options,
    });

    for (const body of [{ appVersion: 103 }, { appVersion: " " }, { appVersion: "0.1.103", name: "Mac" }, ["0.1.103"]]) {
      const rejected = await post({ body });
      expect(rejected.status, JSON.stringify(body)).toBe(400);
      await expect(rejected.json()).resolves.toEqual({ error: "invalid_request" });
    }
    expect((await post({ rawBody: "{" })).status).toBe(400);
    const wrongType = await post({ contentType: "text/plain", rawBody: "appVersion=0.1.103" });
    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toEqual({ error: "unsupported_media_type" });
    expect(fixture.first.calls).toEqual([]);
    expect(fixture.second.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT 1 FROM installation_endpoints WHERE installation_id = ?")
      .bind(installation.installation.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT app_version FROM installations WHERE id = ?")
      .bind(installation.installation.id).first()).toEqual({ app_version: "0.1.102" });
  });

  it("gives a new account no endpoints until its first capacity scan", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-unscanned@example.com");
    fixture.first.tunnelTotalCount = 900;
    const before = await provisionIn(fixture, owner.token, "accounts-unscanned-before");
    expect(before.response.status).toBe(200);
    expect(await endpointState(before.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });

    // A scan over 30 minutes old does not count, however much room it saw.
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 900 });
    await setSnapshot(SECOND_ACCOUNT_ID, { checked_at: Date.now() - 31 * 60_000, tunnel_count: 0 });
    const stale = await provisionIn(fixture, owner.token, "accounts-unscanned-stale");
    expect(stale.response.status).toBe(200);
    expect(await endpointState(stale.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });
    expect(fixture.second.calls).toEqual([]);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runScheduledCleanup(fixture.worker, fixture.vars);
    const after = await provisionIn(fixture, owner.token, "accounts-unscanned-after");
    expect(after.response.status).toBe(200);
    expect(await endpointState(after.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID });
    expect(fixture.violations).toEqual([]);
  });

  it("keeps a slot for each dormant endpoint in its own account when ranking", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-dormant@example.com");
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 10 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 900 });
    const away = await provisionIn(fixture, owner.token, "accounts-dormant-away");
    expect(away.response.status).toBe(200);
    await reclaimedEarlier(fixture.first, away.id);
    // Both accounts have 100 tunnels of room; the primary owes one to the
    // reclaimed endpoint whose owner will come back.
    fixture.first.tunnelTotalCount = 900;
    fixture.second.tunnelTotalCount = 900;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(fixture.worker, fixture.vars);
    const snapshots = await env.DB.prepare(
      `SELECT provider_account, tunnel_count, dormant_endpoints
         FROM managed_endpoint_account_capacity ORDER BY provider_account`,
    ).all();
    expect(snapshots.results).toEqual([
      { dormant_endpoints: 1, provider_account: PRIMARY_ACCOUNT, tunnel_count: 900 },
      { dormant_endpoints: 0, provider_account: SECOND_ACCOUNT_ID, tunnel_count: 900 },
    ]);
    const next = await provisionIn(fixture, owner.token, "accounts-dormant-next");
    expect(next.response.status).toBe(200);
    expect(await endpointState(next.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID });
    expect(fixture.violations).toEqual([]);
  });

  it("scans, reclaims, and alerts per account, matching tunnels only to rows of their own account", async () => {
    const fixture = twoAccounts({ tunnelLimit: 10 });
    const owner = await signIn(fixture.worker, "accounts-scan@example.com");
    await primaryRefusing();
    const idle = await provisionIn(fixture, owner.token, "accounts-scan-idle");
    expect(idle.response.status).toBe(200);
    const state = await endpointState(idle.id);
    expect(state.provider_account).toBe(SECOND_ACCOUNT_ID);
    const tunnel = fixture.second.tunnels.get(state.tunnel_name);
    if (!tunnel) throw new Error("second account tunnel missing");
    await quiet(idle.id, 30 * DAY_MS);
    neverRan(tunnel, 30);
    // A tunnel of the same name in the other account is not this endpoint's.
    const impostor = { id: "70000000-0000-4000-8000-000000000077", name: state.tunnel_name };
    fixture.first.tunnels.set(impostor.name, impostor);
    neverRan(impostor, 90);
    fixture.first.tunnelTotalCount = 950;
    fixture.second.tunnelTotalCount = 9;
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(fixture.worker, fixture.vars);

    expect(await endpointState(idle.id)).toMatchObject({
      provider_account: SECOND_ACCOUNT_ID,
      status: "deleted",
      tunnel_id: null,
    });
    expect(fixture.second.tunnels.has(state.tunnel_name)).toBe(false);
    expect(fixture.second.dns.has(state.hostname)).toBe(false);
    expect(deleteURLs(fixture.second)).toHaveLength(2);
    expect(deleteURLs(fixture.first)).toEqual([]);
    expect(fixture.first.tunnels.get(impostor.name)?.id).toBe(impostor.id);
    expect(loggedJSON(logged, "managed endpoint tunnel scan")).toEqual([
      expect.objectContaining({ hostSuffix: HOST_SUFFIX, managed: 1, marked: 0, tunnelCount: 950, unmatched: 1 }),
      expect.objectContaining({ hostSuffix: SECOND_SUFFIX, managed: 1, marked: 1, tunnelCount: 9, unmatched: 0 }),
    ]);
    const snapshots = await env.DB.prepare(
      "SELECT provider_account, tunnel_count FROM managed_endpoint_account_capacity ORDER BY provider_account",
    ).all();
    // The second account's scan saw 9; the sweep then deleted the reclaimed tunnel.
    expect(snapshots.results).toEqual([
      { provider_account: PRIMARY_ACCOUNT, tunnel_count: 950 },
      { provider_account: SECOND_ACCOUNT_ID, tunnel_count: 8 },
    ]);
    expect(loggedJSON(errors, "managed endpoint capacity high")).toEqual([
      expect.objectContaining({ hostSuffix: HOST_SUFFIX, limit: 1000, resource: "tunnels", used: 950 }),
      expect.objectContaining({ hostSuffix: SECOND_SUFFIX, limit: 10, resource: "tunnels", used: 9 }),
    ]);
    // The primary account is refusing and the second is high, so the pool a
    // new installation sees is high.
    expect(loggedJSON(errors, "managed endpoint pool capacity high")).toEqual([{
      message: "managed endpoint pool capacity high",
      alert: "managed_endpoint_pool_capacity",
      requestId: expect.any(String),
      status: "high",
      accounts: [
        { hostSuffix: HOST_SUFFIX, newEndpoints: true, status: "full" },
        { hostSuffix: SECOND_SUFFIX, newEndpoints: true, status: "high" },
      ],
    }]);
    expect(fixture.violations).toEqual([]);
  });

  it("deletes in the endpoint's own account and zone, and a 429 stops only that account's cleanup", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-delete@example.com");
    await primaryRefusing();
    const removed = await provisionIn(fixture, owner.token, "accounts-delete-owner");
    const revoked = await provisionIn(fixture, owner.token, "accounts-delete-revoked");
    for (const each of [removed, revoked]) {
      expect(await endpointState(each.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID, status: "ready" });
    }

    expect((await call(fixture.worker, ENDPOINT_PATH, {
      env: fixture.env,
      method: "DELETE",
      token: removed.credential,
    })).status).toBe(204);
    expect((await call(fixture.worker, `/v1/installations/${revoked.id}`, {
      env: fixture.env,
      method: "DELETE",
      token: owner.token,
    })).status).toBe(204);
    for (const each of [removed, revoked]) {
      expect(await endpointState(each.id)).toMatchObject({ dns_record_id: null, status: "deleted", tunnel_id: null });
    }
    expect(fixture.second.tunnels.size).toBe(0);
    expect(fixture.second.dns.size).toBe(0);
    expect(deleteURLs(fixture.second)).toHaveLength(4);
    expect(fixture.first.calls).toEqual([]);

    // The sweep: the primary account's API pushes back, the second's rows still go.
    const base = Date.now() - 60_000;
    for (let index = 0; index < 6; index += 1) {
      const opaque = (prefix: number) => (prefix + index).toString(16).padStart(32, "0");
      await orphanIn(fixture.first, PRIMARY_ACCOUNT, HOST_SUFFIX, opaque(0xa0), base + index);
      await orphanIn(fixture.second, SECOND_ACCOUNT_ID, SECOND_SUFFIX, opaque(0xb0), base + 10 + index);
    }
    fixture.first.rateLimited.add("list_tunnels");
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(fixture.worker, fixture.vars);

    const outcome = await env.DB.prepare(
      `SELECT provider_account, status, COUNT(*) AS count, SUM(cleanup_attempts) AS attempts
         FROM installation_endpoints WHERE installation_id LIKE 'orphan-%'
        GROUP BY provider_account, status ORDER BY provider_account, status`,
    ).all();
    // Five rows were already under way when the first 429 came back; the
    // sixth was never started.
    expect(outcome.results).toEqual([
      { attempts: 5, count: 6, provider_account: PRIMARY_ACCOUNT, status: "deleting" },
      { attempts: 6, count: 6, provider_account: SECOND_ACCOUNT_ID, status: "deleted" },
    ]);
    expect(loggedJSON(logged, "managed endpoint cleanup sweep")[0]).toMatchObject({ deleted: 6, rateLimited: true });
    expect(fixture.violations).toEqual([]);
  });

  it("leaves an endpoint of an unconfigured account untouched and reports how many there are", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "accounts-unknown@example.com");
    const installation = await createInstallation(worker, owner.token, "accounts-unknown");
    const retired = "9".repeat(32);
    const opaque = "7".repeat(32);
    const tunnelId = "80000000-0000-4000-8000-000000000088";
    const now = Date.now();
    // Created in an account that has since been removed from the configuration.
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, provider_account, hostname, tunnel_name, tunnel_id, dns_record_id,
         status, last_reconciled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'dns-retired', 'ready', ?, ?, ?)`,
    ).bind(installation.installation.id, retired, `c-${opaque}.retired.example`, `omb-c-${opaque}`, tunnelId, now, now, now).run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const provisioned = await call(worker, ENDPOINT_PATH, { method: "POST", token: installation.credential });
    expect(provisioned.status).toBe(502);
    await expect(provisioned.json()).resolves.toEqual({ error: "endpoint_unavailable" });
    expect(loggedJSON(errors, "managed endpoint reconcile failed")).toEqual([
      expect.objectContaining({ errorCode: "endpoint_account_unavailable" }),
    ]);
    const deleted = await call(worker, ENDPOINT_PATH, { method: "DELETE", token: installation.credential });
    expect(deleted.status).toBe(503);
    await expect(deleted.json()).resolves.toEqual({ error: "endpoint_cleanup_pending" });
    expect(await endpointState(installation.installation.id)).toMatchObject({
      dns_record_id: "dns-retired",
      last_error_code: "endpoint_account_unavailable",
      provider_account: retired,
      status: "deleting",
      tunnel_id: tunnelId,
    });
    expect(cloudflare.calls).toEqual([]);

    // Requested earlier and past its backoff, the row would come first; with
    // room for one row the sweep still cleans the row it can, and the cron
    // reports a count.
    await env.DB.prepare(
      "UPDATE installation_endpoints SET delete_requested_at = ?, last_cleanup_attempt_at = ? WHERE installation_id = ?",
    ).bind(now - 60_000, now - DAY_MS, installation.installation.id).run();
    const orphan = await orphanIn(cloudflare, PRIMARY_ACCOUNT, HOST_SUFFIX, "8".repeat(32), now + 1);
    errors.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runScheduledCleanup(worker, { OMB_CLEANUP_SWEEP_LIMIT: "1" });
    expect(await endpointState(orphan.installationId)).toMatchObject({ status: "deleted" });
    expect(await endpointState(installation.installation.id)).toMatchObject({
      last_error_code: "endpoint_account_unavailable",
      status: "deleting",
    });
    const alerts = loggedJSON(errors, "managed endpoints in an unconfigured account");
    expect(alerts).toEqual([{
      message: "managed endpoints in an unconfigured account",
      alert: "managed_endpoint_account_unconfigured",
      requestId: expect.any(String),
      endpoints: 1,
    }]);
    expect(cloudflare.calls.some((entry) => entry.url.includes(retired) || entry.url.includes(tunnelId))).toBe(false);
  });

  it("ignores a bad account entry with a redacted alert and keeps the rest working", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const vars = {
      CLOUDFLARE_ENDPOINT_ACCOUNTS: JSON.stringify([{
        accountId: SECOND_ACCOUNT_ID,
        zoneId: SECOND_ZONE_ID,
        companionHostSuffix: SECOND_SUFFIX,
        apiTokenSecret: "BETTER_AUTH_SECRET",
      }]),
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runScheduledCleanup(worker, vars);
    const alerts = loggedJSON(errors, "managed endpoint account configuration ignored");
    expect(alerts).toEqual([{
      message: "managed endpoint account configuration ignored",
      alert: "managed_endpoint_account_config",
      requestId: expect.any(String),
      issues: ["entry_1_shape"],
    }]);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(env.BETTER_AUTH_SECRET);
    expect(cloudflare.calls.every((entry) => entry.authorization === `Bearer ${env.CLOUDFLARE_API_TOKEN}`)).toBe(true);
    const health = await call(worker, "/healthz", { env: { ...env, ...vars } as Env });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true, capacity: { tunnels: { limit: 1000 } } });
  });

  it("reports the pool and each account in /healthz without account or zone IDs", async () => {
    const fixture = twoAccounts({ dnsRecordLimit: 200 });
    const now = Date.now();
    await setSnapshot(PRIMARY_ACCOUNT, { checked_at: now - 60_000, dns_record_count: 400, tunnel_count: 1000 });
    await setSnapshot(SECOND_ACCOUNT_ID, { checked_at: now - 120_000, dns_record_count: 12, tunnel_count: 10 });

    const response = await call(fixture.worker, "/healthz", { env: fixture.env });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      service: "openmausbot-control-plane",
      capacity: {
        status: "ok",
        checkedAt: now - 120_000,
        tunnels: { used: 1010, limit: 2000 },
        dnsRecords: { used: 412, limit: 1200 },
        providerRejectedAt: null,
        reclaim: { mode: "on", pending: 0 },
        accounts: [
          {
            hostSuffix: HOST_SUFFIX,
            newEndpoints: true,
            status: "full",
            checkedAt: now - 60_000,
            tunnels: { used: 1000, limit: 1000 },
            dnsRecords: { used: 400, limit: 1000 },
            providerRejectedAt: null,
            reclaimPending: 0,
          },
          {
            hostSuffix: SECOND_SUFFIX,
            newEndpoints: true,
            status: "ok",
            checkedAt: now - 120_000,
            tunnels: { used: 10, limit: 1000 },
            dnsRecords: { used: 12, limit: 200 },
            providerRejectedAt: null,
            reclaimPending: 0,
          },
        ],
      },
    });
    for (const secret of [
      PRIMARY_ACCOUNT,
      env.CLOUDFLARE_ZONE_ID,
      SECOND_ACCOUNT_ID,
      SECOND_ZONE_ID,
      env.CLOUDFLARE_API_TOKEN,
      SECOND_TOKEN,
    ]) {
      expect(text).not.toContain(secret);
    }

    // Only when every account is refusing is the pool full.
    await setSnapshot(PRIMARY_ACCOUNT, { capacity_rejected_at: now - 1_000, capacity_rejected_code: "cf_tunnel_quota", tunnel_count: 1000 });
    await setSnapshot(SECOND_ACCOUNT_ID, { capacity_rejected_at: now - 2_000, capacity_rejected_code: "cf_api_81045", tunnel_count: 200 });
    await forgetCachedCapacity(readConfig(fixture.env));
    const refusing = await (await call(fixture.worker, "/healthz", { env: fixture.env })).json<{
      capacity: { providerRejectedAt: number | null; status: string };
    }>();
    expect(refusing.capacity).toMatchObject({ providerRejectedAt: now - 1_000, status: "full" });
  });

  it("leaves a closed account out of the pool, so a full primary pages, and keeps its endpoints working", async () => {
    const fixture = twoAccounts({ dnsRecordLimit: 200, newEndpoints: false });
    const owner = await signIn(fixture.worker, "accounts-closed@example.com");
    // An endpoint the account took before it was closed.
    const kept = await createInstallation(fixture.worker, owner.token, "accounts-closed-kept");
    const opaque = "c".repeat(32);
    const hostname = `c-${opaque}.${SECOND_SUFFIX}`;
    const tunnel: FakeTunnel = { id: "b0000000-0000-4000-8000-0000000000cc", name: `omb-c-${opaque}` };
    fixture.second.tunnels.set(tunnel.name, tunnel);
    fixture.second.dns.set(hostname, {
      content: `${tunnel.id}.cfargotunnel.com`,
      id: "dns-closed-kept",
      name: hostname,
      proxied: true,
      type: "CNAME",
    });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, provider_account, hostname, tunnel_name, tunnel_id, dns_record_id,
         status, last_reconciled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'dns-closed-kept', 'ready', ?, ?, ?)`,
    ).bind(kept.installation.id, SECOND_ACCOUNT_ID, hostname, tunnel.name, tunnel.id, now, now, now).run();
    // The primary is full and refusing; the closed account has room.
    await primaryRefusing();
    await setSnapshot(SECOND_ACCOUNT_ID, { dns_record_count: 120, tunnel_count: 10 });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Even the newest release is not given the closed account.
    const refused = await provisionIn(fixture, owner.token, "accounts-closed-new", { appVersion: "0.1.104" });
    expect(refused.response.status).toBe(503);
    await expect(refused.response.json()).resolves.toEqual({ error: "endpoint_capacity" });
    expect(await endpointState(refused.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });
    expect(fixture.second.calls).toEqual([]);

    // Its own endpoint still renews there.
    const renewed = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: kept.credential });
    expect(renewed.status).toBe(200);
    await expect(renewed.json()).resolves.toMatchObject({ endpoint: { hostname } });
    expect(await endpointState(kept.installation.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID, tunnel_id: tunnel.id });

    // The pool a new installation sees is the open primary alone: full.
    const health = await (await call(fixture.worker, "/healthz", { env: fixture.env })).json<{ capacity: unknown }>();
    expect(health.capacity).toMatchObject({
      status: "full",
      tunnels: { used: 1000, limit: 1000 },
      dnsRecords: { limit: 1000 },
      providerRejectedAt: expect.any(Number),
      accounts: [
        expect.objectContaining({ hostSuffix: HOST_SUFFIX, newEndpoints: true, status: "full" }),
        expect.objectContaining({ hostSuffix: SECOND_SUFFIX, newEndpoints: false, status: "ok" }),
      ],
    });

    // And the cron pages on it.
    fixture.first.tunnelTotalCount = 1000;
    fixture.second.tunnelTotalCount = 10;
    await runScheduledCleanup(fixture.worker, fixture.vars);
    expect(loggedJSON(errors, "managed endpoint pool capacity high")).toEqual([expect.objectContaining({
      alert: "managed_endpoint_pool_capacity",
      status: "full",
      accounts: [
        { hostSuffix: HOST_SUFFIX, newEndpoints: true, status: "full" },
        { hostSuffix: SECOND_SUFFIX, newEndpoints: false, status: "ok" },
      ],
    })]);
    expect(fixture.violations).toEqual([]);
  });

  it("takes an account whose token Cloudflare refuses out of the ranking, moves its new endpoint, and pages", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-token@example.com");
    // The second account has the most room, but its token may only read tunnels.
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 900 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 10 });
    fixture.second.forbidden.add("create_tunnel");
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const moved = await provisionIn(fixture, owner.token, "accounts-token");
    expect(moved.response.status).toBe(200);
    const state = await endpointState(moved.id);
    expect(state).toMatchObject({ provider_account: PRIMARY_ACCOUNT, status: "ready" });
    expect(state.hostname.endsWith(`.${HOST_SUFFIX}`)).toBe(true);
    expect(fixture.second.tunnels.size).toBe(0);
    expect(loggedJSON(logged, "managed endpoint relocated")).toEqual([
      expect.objectContaining({ from: SECOND_SUFFIX, to: HOST_SUFFIX }),
    ]);
    expect(loggedJSON(errors, "managed endpoint account token refused")).toEqual([{
      message: "managed endpoint account token refused",
      alert: "managed_endpoint_account_refused",
      requestId: expect.any(String),
      hostSuffix: SECOND_SUFFIX,
      errorCode: "cf_api_10000",
    }]);
    expect(await env.DB.prepare(
      `SELECT capacity_rejected_at, capacity_rejected_code
         FROM managed_endpoint_account_capacity WHERE provider_account = ?`,
    ).bind(SECOND_ACCOUNT_ID).first()).toEqual({
      capacity_rejected_at: expect.any(Number),
      capacity_rejected_code: "cf_api_10000",
    });

    // The next new installation goes straight to the primary.
    const callsBefore = fixture.second.calls.length;
    const next = await provisionIn(fixture, owner.token, "accounts-token-next");
    expect(next.response.status).toBe(200);
    expect(await endpointState(next.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT });
    expect(fixture.second.calls).toHaveLength(callsBefore);
    expect(fixture.violations).toEqual([]);
  });

  it("closes an account whose token may not write DNS, answering its waiting endpoints as unavailable", async () => {
    const fixture = twoAccounts();
    const owner = await signIn(fixture.worker, "accounts-dns-token@example.com");
    await setSnapshot(PRIMARY_ACCOUNT, { tunnel_count: 900 });
    await setSnapshot(SECOND_ACCOUNT_ID, { tunnel_count: 10 });
    // An endpoint made there while its token still worked, since reclaimed.
    const away = await provisionIn(fixture, owner.token, "accounts-dns-token-away");
    expect(away.response.status).toBe(200);
    expect(await endpointState(away.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID });
    await reclaimedEarlier(fixture.second, away.id);
    fixture.second.forbidden.add("create_dns");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await provisionIn(fixture, owner.token, "accounts-dns-token");
    expect(failed.response.status).toBe(502);
    await expect(failed.response.json()).resolves.toEqual({ error: "endpoint_unavailable" });
    expect(await endpointState(failed.id)).toMatchObject({
      last_error_code: "cf_api_10000",
      provider_account: SECOND_ACCOUNT_ID,
      status: "error",
      tunnel_id: null,
    });
    // The tunnel this attempt created was rolled back.
    expect(fixture.second.tunnels.size).toBe(0);
    expect(await capacityRejectedAt(SECOND_ACCOUNT_ID)).toEqual(expect.any(Number));
    expect(loggedJSON(errors, "managed endpoint account token refused")).toEqual([
      expect.objectContaining({ alert: "managed_endpoint_account_refused", hostSuffix: SECOND_SUFFIX }),
    ]);

    // The reclaimed endpoint keeps its address and waits for its account,
    // answered locally with what the refusal got, not endpoint_capacity.
    const callsBefore = fixture.second.calls.length;
    const waiting = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: away.credential });
    expect(waiting.status).toBe(502);
    await expect(waiting.json()).resolves.toEqual({ error: "endpoint_unavailable" });
    expect(await endpointState(away.id)).toMatchObject({ provider_account: SECOND_ACCOUNT_ID, status: "deleted" });
    expect(fixture.second.calls).toHaveLength(callsBefore);

    // The row that never got an address moves on its next request, after
    // the two lookups that prove the closed account holds nothing for it.
    const retried = await call(fixture.worker, ENDPOINT_PATH, { env: fixture.env, method: "POST", token: failed.credential });
    expect(retried.status).toBe(200);
    expect(await endpointState(failed.id)).toMatchObject({ provider_account: PRIMARY_ACCOUNT, status: "ready" });
    expect(fixture.second.calls.slice(callsBefore).map((entry) => entry.method)).toEqual(["GET", "GET"]);
    expect(fixture.violations).toEqual([]);
  });

  it("pages on a refused token with one account and otherwise answers exactly as before", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "single-token@example.com");
    const first = await createInstallation(worker, owner.token, "single-token-first");
    const second = await createInstallation(worker, owner.token, "single-token-second");
    cloudflare.forbidden.add("create_tunnel");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const installation of [first, second]) {
      const callsBefore = cloudflare.calls.length;
      const refused = await call(worker, ENDPOINT_PATH, { method: "POST", token: installation.credential });
      expect(refused.status).toBe(502);
      await expect(refused.json()).resolves.toEqual({ error: "endpoint_unavailable" });
      expect(await endpointState(installation.installation.id)).toMatchObject({
        last_error_code: "cf_api_10000",
        status: "error",
      });
      // Nothing is gated: each request still asks Cloudflare.
      expect(cloudflare.calls.length).toBeGreaterThan(callsBefore);
    }
    expect(await capacityRejectedAt()).toBeNull();
    expect(loggedJSON(errors, "managed endpoint account token refused")).toEqual([
      expect.objectContaining({ alert: "managed_endpoint_account_refused", errorCode: "cf_api_10000", hostSuffix: HOST_SUFFIX }),
      expect.objectContaining({ alert: "managed_endpoint_account_refused", errorCode: "cf_api_10000", hostSuffix: HOST_SUFFIX }),
    ]);
  });

  it("never acts on a row whose hostname is not one opaque label under its account's suffix, and counts it", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createWorker(cloudflare.fetch);
    const owner = await signIn(worker, "accounts-renamed@example.com");
    const installation = await createInstallation(worker, owner.token, "accounts-renamed");
    // Rows made under a suffix the primary no longer has: an operator edited
    // COMPANION_HOST_SUFFIX. One is an idle endpoint, one a revoked one.
    const rows = [
      { id: installation.installation.id, opaque: "4".repeat(32), status: "ready", tunnelId: "40000000-0000-4000-8000-000000000044" },
      { id: "orphan-renamed", opaque: "5".repeat(32), status: "deleting", tunnelId: "50000000-0000-4000-8000-000000000055" },
    ];
    const longAgo = Date.now() - 30 * DAY_MS;
    for (const row of rows) {
      const tunnel: FakeTunnel = { id: row.tunnelId, name: `omb-c-${row.opaque}` };
      neverRan(tunnel, 30);
      cloudflare.tunnels.set(tunnel.name, tunnel);
      await env.DB.prepare(
        `INSERT INTO installation_endpoints
          (installation_id, hostname, tunnel_name, tunnel_id, status, last_reconciled_at,
           delete_requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        `c-${row.opaque}.old-suffix.example`,
        tunnel.name,
        tunnel.id,
        row.status,
        longAgo,
        row.status === "deleting" ? longAgo : null,
        longAgo,
        longAgo,
      ).run();
    }
    await quiet(installation.installation.id, 30 * DAY_MS);
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);

    // The scan never marks it, and the sweep never claims it.
    expect(await endpointState(installation.installation.id)).toMatchObject({ reclaim_requested_at: null, status: "ready" });
    expect(await env.DB.prepare(
      "SELECT status, cleanup_attempts FROM installation_endpoints WHERE installation_id = 'orphan-renamed'",
    ).first()).toEqual({ cleanup_attempts: 0, status: "deleting" });
    expect(loggedJSON(logged, "managed endpoint tunnel scan")).toEqual([
      expect.objectContaining({ managed: 2, marked: 0, unmatched: 2 }),
    ]);
    expect(cleanupCalls(cloudflare)).toEqual([]);
    expect(loggedJSON(errors, "managed endpoints in an unconfigured account")).toEqual([
      expect.objectContaining({ alert: "managed_endpoint_account_unconfigured", endpoints: 2 }),
    ]);
  });
});
