import { DEFAULT_OUTBOUND_POLICY } from "../../shared/outbound.ts";
import { readBotActivity } from "../activity.ts";
import { activityCsv, activityEntries, parseActivityWhat, readAdminActivityRange } from "../admin-activity.ts";
import { loadBrand } from "../brand.ts";
import { browserEngineStatus, ensureChrome, installAgentBrowserBinary, resolveAgentBrowserBinary } from "../browser-engine.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, instanceConfigs, type AppConfig } from "../config.ts";
import { boundRetentionDays, decisionsCsv, readDecisionRange, readDecisions, type DecisionRow } from "../decision-log.ts";
import { editionForMembers, editionStatus, entitled } from "../enterprise.ts";
import { fleetAvailable, fleetRequest, fleetSocketPath } from "../fleet-client.ts";
import { noteKeyAccepted, noteKeyRejected } from "../key-rejections.ts";
import type { OutboundCounts } from "../outbound-counts.ts";
import { loadPlanUsage, planAccountsFromInstances } from "../plan-usage.ts";
import { tregProviderApi } from "../included-services.ts";
import { checkProviderKey, PROVIDER_KEY_KINDS, providerBaseUrl, type ProviderKeyKind } from "../provider-key-check.ts";
import { checkTregKey } from "../research.ts";
import type { Store } from "../store.ts";
import { readThreadEvents } from "../thread-events.ts";
import { parseUsageRange } from "../usage-ledger.ts";
import type { ConfigStatus } from "./config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface StatusRouteDeps {
  store: Pick<Store, "bot" | "bots" | "tasks" | "groupByThread">;
  cfg: AppConfig;
  outboundCounts: Pick<OutboundCounts, "today">;
  staticDir: string | null;
  sharedWorkspaceFullAccessEnabled(): boolean;
  adminActivityRecording(): boolean;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  browserEngineInstall: { get(): Promise<void> | null; set(install: Promise<void> | null): void };
  browserEngineInstallError: { set(error: string | null): void };
  /** On a Team Cloud: false for someone else's private chat, whose words never reach this session's lists. */
  threadShown?(auth: RequestAuth): (threadId: string) => boolean;
}

/** A decision in a conversation the reader may not see keeps its when, which bot, which tool and what was decided (the
 * activity a team's admin sees), never its words or where. */
function readable(rows: DecisionRow[], shown: (threadId: string) => boolean): DecisionRow[] {
  return rows.map((row) => shown(row.threadId) ? row : { ...row, threadId: "", summary: undefined, rule: undefined, requestId: undefined });
}

export function createStatusRoutes(deps: StatusRouteDeps): RouteHandler {
  const {
    store, cfg, outboundCounts, staticDir: STATIC_DIR, sharedWorkspaceFullAccessEnabled, adminActivityRecording,
    configStatus, broadcast, browserEngineInstall, browserEngineInstallError,
  } = deps;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const shown = deps.threadShown?.(auth) ?? (() => true);
    // The packaged app's port fallback: the forked child proves it is ours by echoing its pid.
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "openmausbot", pid: process.pid, static: Boolean(STATIC_DIR), capabilities: {
        guardedMessages: 1, guardedRequests: 1, guardedFullAccess: 1, guardedOnBehalfOf: 1,
        ...(sharedWorkspaceFullAccessEnabled() ? { sharedWorkspaceFullAccess: 1 } : {}),
      } });
    }
    // JSON-only, so a form posted from another local page cannot start the install. One install at a time.
    if (method === "POST" && path === "/api/browser-engine/install") {
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (!browserEngineInstall.get()) {
        const status = browserEngineStatus();
        if (status.kind === "unavailable" && !status.installable) return json(res, 409, { error: status.reason });
        browserEngineInstallError.set(null);
        browserEngineInstall.set((async () => {
          const binary = resolveAgentBrowserBinary() ?? await installAgentBrowserBinary({ log: (line) => console.log(line) });
          await ensureChrome(binary, { log: (line) => console.log(line) });
        })().then(
          () => { browserEngineInstallError.set(null); },
          (error: unknown) => { browserEngineInstallError.set(error instanceof Error ? error.message : String(error)); },
        ).finally(() => {
          browserEngineInstall.set(null);
          broadcast({ kind: "config", ...configStatus() });
        }));
        broadcast({ kind: "config", ...configStatus() });
      }
      return json(res, 202, { installing: true });
    }
    // Admin scope plus the `admin` entitlement; the socket's own permissions decide whether this workspace may drive the agent.
    const fleetRoute = /^\/api\/fleet(?:\/(workspaces(?:\/([a-z0-9-]+)(?:\/(users|suspend|resume))?)?|upgrade))?$/.exec(path);
    if (fleetRoute) {
      if (!entitled("admin")) return json(res, 403, { error: "Workspaces need an enterprise licence with the admin feature." });
      const socket = fleetSocketPath();
      if (!fleetAvailable(socket)) return json(res, 404, { error: "No fleet agent on this server. Run `openmausbot fleet init --domain … --operator <this user>` as root." });
      const [, resource, slug, sub] = fleetRoute;
      let forward: { method: string; path: string; body?: unknown } | null = null;
      if (method === "GET" && !resource) forward = { method: "GET", path: "/workspaces" };
      else if (method === "POST" && resource === "workspaces") forward = { method: "POST", path: "/workspaces", body: await readBody(req, 256 * 1024) };
      else if (method === "POST" && resource === "upgrade") forward = { method: "POST", path: "/upgrade" };
      else if (slug && method === "POST" && (sub === "users" || sub === "suspend" || sub === "resume")) forward = { method: "POST", path: `/workspaces/${slug}/${sub}`, ...(sub === "users" ? { body: await readBody(req, 8192) } : {}) };
      else if (slug && method === "DELETE" && !sub) forward = { method: "DELETE", path: `/workspaces/${slug}`, body: await readBody(req, 8192) };
      if (!forward) return json(res, 405, { error: "no such fleet operation" });
      res.setHeader("cache-control", "no-store");
      try {
        const reply = await fleetRequest(socket, forward.method, forward.path, forward.body);
        return json(res, reply.status, reply.body ?? {});
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (method === "GET" && path === "/api/edition") {
      // A member learns what is entitled; when the key lapses is for admins.
      const status = editionStatus();
      return json(res, 200, auth.scopes.includes("admin") ? status : editionForMembers(status));
    }
    if (method === "GET" && path === "/api/brand") {
      return json(res, 200, loadBrand());
    }

    m = path.match(/^\/api\/threads\/([\w-]+)\/events$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const known =
        store.bots.some((b) => store.tasks(b.id).some((t) => t.threadId === threadId)) ||
        Boolean(store.groupByThread(threadId));
      if (!known) return json(res, 404, { error: "no such thread" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const limit = parsedLimit;
      return json(res, 200, readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, threadId, limit }));
    }

    // Subscription windows (5-hour and weekly). Unlisted, so it stays admin.
    if (method === "GET" && path === "/api/plan-usage") {
      res.setHeader("cache-control", "no-store");
      const report = await loadPlanUsage({
        accounts: planAccountsFromInstances(instanceConfigs(cfg)),
        refresh: url.searchParams.get("refresh") === "1",
      });
      return json(res, 200, report);
    }

    // One read-only request from this server; the verdict never carries the key.
    if (method === "POST" && path === "/api/keys/test") {
      const body = await readBody(req, 8192);
      const provider = body?.provider;
      if (provider === "treg") {
        if (body?.key !== undefined && typeof body.key !== "string") return json(res, 400, { error: "key must be a string" });
        const key = typeof body?.key === "string" ? body.key.trim() : cfg.treg?.key?.trim() || "";
        if (!key) return json(res, 400, { error: "No key to test. Paste one or save one first." });
        if (key.length > 512) return json(res, 400, { error: "That does not look like a treg key." });
        res.setHeader("cache-control", "no-store");
        return json(res, 200, await checkTregKey(key, { api: tregProviderApi() }));
      }
      if (!PROVIDER_KEY_KINDS.includes(provider as ProviderKeyKind)) {
        return json(res, 400, { error: `provider must be one of ${PROVIDER_KEY_KINDS.join(", ")}` });
      }
      const kind = provider as ProviderKeyKind;
      const saved = { anthropic: cfg.anthropic, openai: cfg.openai, openrouter: cfg.openrouter, openaiCompat: cfg.openaiCompat, mistral: cfg.mistral, cerebras: cfg.cerebras, groq: cfg.groq, meta: cfg.meta, xai: cfg.xai }[kind];
      if (body?.key !== undefined && typeof body.key !== "string") {
        return json(res, 400, { error: "key must be a string" });
      }
      const key = typeof body?.key === "string" ? body.key.trim() : saved?.key?.trim() || "";
      if (!key) return json(res, 400, { error: "No key to test. Paste one or save one first." });
      if (key.length > 512) return json(res, 400, { error: "That does not look like an API key." });
      const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : (saved && "url" in saved ? saved.url : undefined);
      res.setHeader("cache-control", "no-store");
      const verdict = await checkProviderKey({ provider: kind, key, url });
      if (kind !== "anthropic") {
        const base = providerBaseUrl(kind, url);
        if (verdict.ok) noteKeyAccepted(base, key);
        else if (verdict.reason === "rejected") noteKeyRejected(base, key);
      }
      return json(res, 200, verdict);
    }

    if (method === "GET" && path === "/api/decisions") {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      return json(res, 200, { decisions: readable(readDecisions(DATA_DIR, parsedLimit ?? 200), shown) });
    }
    if (method === "GET" && (path === "/api/admin-activity" || path === "/api/admin-activity.csv")) {
      const fromParam = url.searchParams.get("from") || new Date(Date.now() - 29 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const range = parseUsageRange(fromParam, url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be dates (YYYY-MM-DD), from no later than to, at most a year apart" });
      const what = parseActivityWhat(url.searchParams.get("what"));
      if (!what) return json(res, 400, { error: "what must be all, approvals, decisions, config, people, session, webhook, mcp, engine, bot, budget or visibility" });
      const entries = activityEntries(readable(readDecisionRange(DATA_DIR, range), shown), readAdminActivityRange(DATA_DIR, range), {
        what,
        who: (url.searchParams.get("who") ?? "").slice(0, 200),
      });
      if (path.endsWith(".csv")) {
        const stamp = (date: Date) => date.toISOString().slice(0, 10);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="activity-${stamp(range.from)}-${stamp(range.to)}.csv"`,
          "cache-control": "no-store",
        });
        res.end(activityCsv(entries));
        return;
      }
      const rawLimit = Number(url.searchParams.get("limit") ?? 500);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5_000) : 500;
      res.setHeader("cache-control", "no-store");
      return json(res, 200, {
        entries: entries.slice(0, limit),
        total: entries.length,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        retentionDays: boundRetentionDays(),
        recording: adminActivityRecording(),
      });
    }
    if (method === "GET" && path === "/api/decisions.csv") {
      const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
      const stamp = (date: Date) => date.toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="decisions-${stamp(range.from)}-${stamp(range.to)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(decisionsCsv(readable(readDecisionRange(DATA_DIR, range), shown)));
      return;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/activity$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const threadIds = [...new Set([bot.threadId, ...store.tasks(bot.id).map((task) => task.threadId)])].filter(shown);
      return json(res, 200, {
        rows: readBotActivity({ dataDir: DATA_DIR, eventsDir: EVENTS_DIR, botId: bot.id, threadIds, limit: parsedLimit ?? 300 }),
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/outbound$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { policy: bot.outbound ?? DEFAULT_OUTBOUND_POLICY, today: outboundCounts.today(bot.id) });
    }
    return PASS;
  };
}
