// The connected-apps service (cloudflare/composio-broker) with its own fake D1 and fake Composio, served over loopback
// HTTP so a real OpenMausBot server can register with it, create triggers and long-poll events. Nothing leaves the
// machine: Composio calls from the Worker are answered by the broker's test harness.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The broker sources are Worker code outside this program's type world; loaded at run time only. */
const HARNESS = new URL("../../cloudflare/composio-broker/src/test-harness.ts", import.meta.url).href;

interface FakeAccount { id: string; user_id: string; toolkit: { slug: string }; status: string; alias?: string }
interface Harness {
  d1: { db: { prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] } }; rows<T>(sql: string, ...values: unknown[]): T[] };
  env: { COMPOSIO_WEBHOOK_SECRET?: string; CLOUD_GRANT_SECRET?: string };
  composio: { accounts: FakeAccount[]; instances: Map<string, { id: string; trigger_name: string; trigger_config: Record<string, unknown>; disabled_at: string | null }>; calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>; fetchImpl: typeof fetch };
  fetch(path: string, init?: RequestInit): Promise<Response>;
  install(): Promise<{ id: string; token: string; userId: string }>;
  deliver(envelope: Record<string, unknown>, sign?: Record<string, unknown>): Promise<Response>;
}
interface HarnessModule {
  brokerHarness(): Harness;
  message(triggerId: string, userId: string | undefined, data?: Record<string, unknown>, id?: string): Record<string, unknown>;
  cloudGrant(machineId: string): string;
  GMAIL_TYPE: Record<string, unknown>;
}

export interface BrokerFake {
  url: string;
  harness: Harness;
  /** Registers an installation the way the desktop app does, for a server started with its token. */
  install(): Promise<{ id: string; token: string; userId: string }>;
  installationIds(): string[];
  account(userId: string, toolkit?: string, alias?: string): string;
  expire(accountId: string): Promise<Response>;
  /** One signed Composio delivery for a trigger, as the live project subscription sends it. */
  deliver(triggerId: string, data: Record<string, unknown>, id?: string): Promise<Response>;
  userFor(installationId: string): string;
  /** Today's queued count for an installation, set directly, to reach the daily limit without 500 deliveries. */
  setQueuedToday(installationId: string, queued: number): void;
  cloudMachine(installationId: string): string | null;
  cloudGrant(machineId: string): string;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startBrokerFake(): Promise<BrokerFake> {
  const mod = await import(/* @vite-ignore */ HARNESS) as HarnessModule;
  const harness = mod.brokerHarness();
  const realFetch = globalThis.fetch;
  const session = (id: string, userId: string) => ({
    session_id: id,
    mcp: { url: `https://mcp.composio.dev/${id}` },
    config: { user_id: userId, multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } },
  });
  let sessions = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "backend.composio.dev") return realFetch(input, init);
    const path = url.pathname.replace(/^\/api\/v3(\.1)?/, "");
    const method = init?.method ?? "GET";
    if (path === "/auth_configs") return Response.json({ items: [], next_cursor: null });
    if (method === "POST" && path === "/tool_router/session") {
      const request = JSON.parse(String(init?.body ?? "{}")) as { user_id?: string };
      return Response.json(session(`trs_${++sessions}`, request.user_id ?? ""), { status: 201 });
    }
    const lookup = path.match(/^\/tool_router\/session\/([^/]+)$/)?.[1];
    if (method === "GET" && lookup) return Response.json({ error: "gone" }, { status: 404 });
    if (/^\/tool_router\/session\/[^/]+\/toolkits$/.test(path)) return Response.json({ items: [], next_cursor: null });
    return harness.composio.fetchImpl(input, init);
  }) as typeof fetch;

  const server: Server = createServer(async (req, res) => {
    try {
      const raw = await body(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const response = await harness.fetch(req.url ?? "/", { method: req.method, headers, ...(raw.length ? { body: raw } : {}) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let accounts = 0;
  const userFor = (installationId: string) => `omb_${installationId.replaceAll("-", "")}`;
  return {
    url,
    harness,
    install: () => harness.install(),
    installationIds: () => harness.d1.rows<{ id: string }>("SELECT id FROM installations ORDER BY created_at").map((row) => row.id),
    account(userId, toolkit = "gmail", alias) {
      const id = `ca_${toolkit}_${++accounts}`;
      harness.composio.accounts.push({ id, user_id: userId, toolkit: { slug: toolkit }, status: "ACTIVE", ...(alias ? { alias } : {}) });
      return id;
    },
    async expire(accountId) {
      const account = harness.composio.accounts.find((candidate) => candidate.id === accountId);
      if (account) account.status = "EXPIRED";
      return harness.deliver({
        type: "composio.connected_account.expired",
        timestamp: new Date().toISOString(),
        metadata: {},
        data: { id: accountId, user_id: account?.user_id, toolkit: { slug: account?.toolkit.slug ?? "gmail" }, status_reason: "token revoked" },
      });
    },
    deliver: (triggerId, data, id) => {
      const owner = harness.d1.rows<{ composio_user_id: string }>(
        "SELECT i.composio_user_id FROM trigger_bindings b JOIN installations i ON i.id = b.installation_id WHERE b.composio_trigger_id = ?", triggerId)[0];
      return harness.deliver(mod.message(triggerId, owner?.composio_user_id, data, id ?? `msg_${crypto.randomUUID()}`));
    },
    userFor,
    setQueuedToday(installationId, queued) {
      harness.d1.db.prepare(
        "INSERT INTO app_event_days (day, installation_id, queued) VALUES (?, ?, ?) ON CONFLICT (day, installation_id) DO UPDATE SET queued = excluded.queued",
      ).run(new Date().toISOString().slice(0, 10), installationId, queued);
    },
    cloudMachine: (installationId) => harness.d1.rows<{ cloud_machine_id: string | null }>("SELECT cloud_machine_id FROM installations WHERE id = ?", installationId)[0]?.cloud_machine_id ?? null,
    cloudGrant: (machineId) => mod.cloudGrant(machineId),
    async close() {
      globalThis.fetch = realFetch;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
