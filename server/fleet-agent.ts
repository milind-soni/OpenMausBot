// The fleet agent: the one root process on a shared server, listening on a
// Unix socket only the operator's user may open. It answers a small JSON API
// by planning with fleet.ts and running the plan with the same executor the
// CLI uses. Every request is validated here, every action is written to an
// audit log, and nothing arrives as a command string.
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { defaultFleetDeps, executePlan, loadRegistry, planFleetAction, type FleetDeps, type FleetInput } from "./fleet-cli.ts";
import { assertSlug, fleetLayout, workspaceDataDir, type FleetLayout, type FleetWorkspace } from "./fleet.ts";
import { readUsage, summarizeUsage } from "./usage-ledger.ts";

export interface FleetAgentOptions {
  socketPath: string;
  /** Unix group (the operator's user) that may open the socket. */
  group?: string;
  node: string;
  script: string;
  licenseKey?: string;
  root?: string;
  deps?: FleetDeps;
  /** Where actions are recorded; the layout's audit file by default. */
  auditFile?: string;
  now?: () => Date;
}

export interface FleetWorkspaceView extends FleetWorkspace {
  live: string;
  usage: { month: string; turns: number; costUsd: number | null; billableUsd: number | null };
}

const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > MAX_BODY) reject(Object.assign(new Error("request too large"), { status: 413 }));
    });
    req.on("end", () => {
      if (!text.trim()) return resolve({});
      try {
        const value: unknown = JSON.parse(text);
        resolve(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
      } catch {
        reject(Object.assign(new Error("body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** This month's totals from a workspace's own ledger, read as root. */
export function workspaceUsage(layout: FleetLayout, slug: string, now: Date): FleetWorkspaceView["usage"] {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const total = summarizeUsage(readUsage(workspaceDataDir(layout, slug), { from, to: now }), "bot").total;
  return { month: now.toISOString().slice(0, 7), turns: total.turns, costUsd: total.costUsd, billableUsd: total.billableUsd };
}

export function createFleetAgent(options: FleetAgentOptions): Server {
  const deps = options.deps ?? defaultFleetDeps();
  const layout = fleetLayout(options.root ?? "/");
  const now = options.now ?? (() => new Date());
  const auditFile = options.auditFile ?? layout.auditFile;
  const base = (): FleetInput => ({
    action: "list", admins: [], members: [], dryRun: false, yes: false, keepData: false,
    node: options.node, script: options.script, root: options.root, ...(options.licenseKey ? { licenseKey: options.licenseKey } : {}),
  });

  const audit = (entry: Record<string, unknown>) => {
    try {
      mkdirSync(dirname(auditFile), { recursive: true, mode: 0o750 });
      appendFileSync(auditFile, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      /* the audit line must never fail the action it records */
    }
  };

  const act = async (input: FleetInput): Promise<{ status: number; body: unknown }> => {
    const log: string[] = [];
    const errors: string[] = [];
    const io = { log: (line: string) => log.push(line), error: (line: string) => errors.push(line) };
    let steps;
    try {
      steps = planFleetAction(input, deps);
    } catch (error) {
      audit({ action: input.action, slug: input.slug, ok: false, error: error instanceof Error ? error.message : String(error) });
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
    }
    const code = await executePlan(steps, deps, io);
    audit({ action: input.action, slug: input.slug, ok: code === 0, ...(input.email ? { email: input.email } : {}) });
    return code === 0 ? { status: 200, body: { ok: true, log } } : { status: 500, body: { error: errors[0] ?? "the step failed", log: [...log, ...errors] } };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fleet");
    const method = req.method ?? "GET";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (method === "GET" && url.pathname === "/health") return send(200, { ok: true });
      if (method === "GET" && url.pathname === "/workspaces") {
        const registry = loadRegistry(layout, deps);
        const workspaces: FleetWorkspaceView[] = [];
        for (const workspace of Object.values(registry.workspaces).sort((a, b) => a.slug.localeCompare(b.slug))) {
          const live = (await deps.run(["systemctl", "is-active", `openmausbot@${workspace.slug}.service`])).output.trim() || "unknown";
          workspaces.push({ ...workspace, live, usage: workspaceUsage(layout, workspace.slug, now()) });
        }
        return send(200, { domain: registry.domain, operator: registry.operator ?? null, workspaces });
      }
      if (method === "POST" && url.pathname === "/workspaces") {
        const body = await readBody(req);
        const result = await act({
          ...base(), action: "create", slug: text(body.slug), admins: strings(body.admins), members: strings(body.members),
          cap: number(body.cap), memory: text(body.memory), brandJson: text(body.brandJson), anthropicKey: text(body.anthropicKey),
        });
        return send(result.status, result.body);
      }
      if (method === "POST" && url.pathname === "/upgrade") {
        const result = await act({ ...base(), action: "upgrade" });
        return send(result.status, result.body);
      }
      const match = /^\/workspaces\/([a-z0-9-]+)(?:\/(users|suspend|resume))?$/.exec(url.pathname);
      if (match) {
        const slug = match[1]!;
        assertSlug(slug);
        const sub = match[2];
        if (method === "POST" && sub === "users") {
          const body = await readBody(req);
          const action = body.action === "remove" ? "remove" : body.action === "add" ? "add" : undefined;
          const result = await act({ ...base(), action: "users", slug, userAction: action, email: text(body.email), chatOnly: body.chatOnly === true });
          return send(result.status, result.body);
        }
        if (method === "POST" && (sub === "suspend" || sub === "resume")) {
          const result = await act({ ...base(), action: sub, slug });
          return send(result.status, result.body);
        }
        if (method === "DELETE" && !sub) {
          const body = await readBody(req);
          const result = await act({ ...base(), action: "delete", slug, yes: true, keepData: body.keepData === true });
          return send(result.status, result.body);
        }
      }
      return send(404, { error: "no such fleet operation" });
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
      return send(status, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  return server;
}

/** Listen on the socket, reachable by root and the given group only. */
export async function startFleetAgent(options: FleetAgentOptions, io: { log(line: string): void }): Promise<Server> {
  const server = createFleetAgent(options);
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o755 });
  if (existsSync(options.socketPath)) rmSync(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  chmodSync(options.socketPath, 0o660);
  if (options.group) {
    const deps = options.deps ?? defaultFleetDeps();
    const chown = await deps.run(["chown", `root:${options.group}`, options.socketPath]);
    if (chown.code !== 0) throw new Error(`could not hand the socket to ${options.group}: ${chown.output.trim()}`);
  }
  io.log(`fleet agent listening on ${options.socketPath}${options.group ? ` for ${options.group}` : ""}`);
  return server;
}
