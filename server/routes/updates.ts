import type { EngineInstall } from "../contracts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UpdateProvider {
  instanceId: string;
  displayName: string;
  driverKind: string;
  cli?: string;
  cliDefault?: string;
  cliCandidates?: string[];
  readOnly?: boolean;
  policy?: unknown;
  install?: EngineInstall;
}

/** Only installed, locally owned CLIs. Never install an unused provider or
 * execute a command supplied by a renderer, a remote host, or model output. */
export function updateCandidates(providers: UpdateProvider[]) {
  const seen = new Set<string>();
  return providers.flatMap(p => {
    if (p.readOnly || p.policy || !(p.cli || p.cliCandidates?.length)) return [];
    const method = p.driverKind === "claudeAgent" ? "claude" : p.install?.server ? "npm" : null;
    if (!method) return [];
    // A custom executable must not silently be replaced by the npm default.
    if (method === "npm" && p.cli && p.cli !== p.cliDefault) return [];
    const key = method === "npm" ? `npm:${p.install!.server!.package}` : `claude:${p.cli ?? p.cliDefault}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ instanceId: p.instanceId, name: p.displayName, method, key }];
  });
}

export interface UpdateRoutesDeps {
  environmentId: string;
  version(): string;
  providers(): Promise<UpdateProvider[]>;
  idle(): boolean;
  authorized: (req: Parameters<RouteHandler>[0]["req"], auth: Parameters<RouteHandler>[0]["auth"]) => boolean;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  install(instanceId: string, method: string): Promise<void>;
  desktop?: (action: "state" | "check" | "install", version?: string) => Promise<{ status: string; version?: string; installMode?: string; message?: string }>;
}

/** Run before the ordinary workspace request counter: this module takes
 * the same exclusive idle-workspace lease as backup/restore. Admin-only. */
export function createUpdateRoutes(d: UpdateRoutesDeps): RouteHandler {
  return async ctx => {
    const { req, res, method, path, auth, json, readBody } = ctx;
    if (!/^\/api\/updates(?:\/(?:providers|check|install))?$/.test(path)) return PASS;
    if (!auth.scopes.includes("admin") || !d.authorized(req, auth)) return json(res, 403, { error: "Administrator access is required." });
    res.setHeader("cache-control", "no-store");
    if (method === "GET" && path === "/api/updates") {
      const installed = await d.providers();
      const providers = updateCandidates(installed);
      const keys = new Set(providers.map(p => p.key));
      const manualProviders = installed.filter(p => !p.readOnly && !p.policy && (p.cli || p.cliCandidates?.length) &&
        !updateCandidates([p]).some(candidate => keys.has(candidate.key))).map(p => p.displayName);
      const app = d.desktop ? await d.desktop("state") : { status: "operator" };
      return json(res, 200, { environmentId: d.environmentId, version: d.version(), idle: d.idle(), providers, manualProviders, app });
    }
    if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "JSON required" });
    const body = await readBody(req, 8192);
    if (body?.environmentId !== d.environmentId) return json(res, 409, { error: "This environment changed. Check for updates again." });
    if (!d.authorized(req, auth)) return json(res, 403, { error: "Your session ended." });
    if (path === "/api/updates/check") {
      if (!d.desktop) return json(res, 409, { error: "This server is updated by its operator." });
      return json(res, 200, await d.desktop("check"));
    }
    if (path === "/api/updates/providers") {
      if (!Array.isArray(body.instances) || body.instances.length > 50 || body.instances.some((p: { instanceId?: unknown; key?: unknown } | null) => !p || typeof p.instanceId !== "string" || typeof p.key !== "string")) return json(res, 400, { error: "Invalid provider selection" });
      const requested = new Map<string, string>(body.instances.map((p: { instanceId: string; key: string }) => [p.instanceId, p.key]));
      return d.exclusive(async () => {
        const candidates = updateCandidates(await d.providers());
        if (!d.authorized(req, auth)) return json(res, 403, { error: "Your session ended." });
        if ([...requested].some(([id, key]) => !candidates.some(p => p.instanceId === id && p.key === key))) return json(res, 409, { error: "Provider settings changed. Check for updates again." });
        const results = [];
        // npm installs share one prefix; never race writes to it.
        for (const p of candidates.filter(p => requested.has(p.instanceId))) {
          if (!d.authorized(req, auth)) throw new Error("Your session ended.");
          await d.install(p.instanceId, p.method);
          results.push(p.instanceId);
        }
        return json(res, 200, { updated: results });
      });
    }
    if (path === "/api/updates/install") {
      if (!d.desktop || typeof body.version !== "string") return json(res, 409, { error: "Automatic server updates are unavailable." });
      return d.exclusive(async () => {
        const state = await d.desktop!("state");
        if (!d.authorized(req, auth)) return json(res, 403, { error: "Your session ended." });
        if (state.status !== "downloaded" || state.installMode !== "restart" || state.version !== body.version) return json(res, 409, { error: "The reviewed update is not ready to install." });
        // Acknowledge before the parent closes this backend. Keep the lease
        // through the handoff; a disconnected client never causes a retry.
        const finished = new Promise<void>(resolve => { res.once("finish", resolve); res.once("close", resolve); });
        json(res, 202, { version: body.version });
        await finished;
        if (!res.writableFinished || !d.authorized(req, auth)) return;
        await d.desktop!("install", body.version).catch(() => {
          // The acknowledged handoff can fail after HTTP has finished. The
          // coordinator verifies the actual version instead of trusting 202.
        });
      });
    }
    return json(res, 405, { error: "Method not allowed" });
  };
}
