// BYOK Orgo computers use the same per-turn stdio computer contract as a VPS.
// No SDK, local CLI, provider URL setting, or portable computer binding is needed.
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

const API = "https://www.orgo.ai/api";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANCE = /^[a-zA-Z0-9_-]{1,100}$/;
const STATUSES = new Set(["creating", "running", "restarting", "updating", "suspended", "frozen", "stopped", "error", "deleted"]);
let environmentId: string | undefined;
const locks = new Set<string>();
type Json = Record<string, unknown>;
type Snapshot = { apiKey: string; workspaceId: string };
export interface OrgoComputer {
  id: string;
  name: string;
  workspace_id: string;
  status: string;
  fly_instance_id: string | null;
  vnc_password: string | null;
}
export interface OrgoLease extends Snapshot { computerId: string; computerName: string }
export interface OrgoComputerStatus {
  configured: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  managed: boolean;
  problem?: string;
  box: { id: string; name: string; state: string } | null;
}

function ownedPrefix(): string {
  environmentId ??= loadEnvironmentId(DATA_DIR);
  return `openmausbot-orgo-${createHash("sha256").update(environmentId).digest("hex").slice(0, 12)}-`;
}
export function orgoComputerName(botId: string): string {
  if (!botId) throw new Error("An Orgo computer needs a bot identity");
  return ownedPrefix() + createHash("sha256").update(botId).digest("hex").slice(0, 24);
}
function snapshot(cfg: AppConfig, requireWorkspace = true): Snapshot {
  const apiKey = cfg.orgo?.apiKey?.trim() ?? "";
  const workspaceId = cfg.orgo?.workspaceId?.trim() ?? "";
  if (!apiKey) throw new Error("Connect your Orgo API key in Settings → Connections");
  if (requireWorkspace && !UUID.test(workspaceId)) throw new Error("Choose an Orgo workspace in Settings → Connections before creating a computer");
  return { apiKey, workspaceId };
}
export function isConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.orgo?.apiKey?.trim() && UUID.test(cfg.orgo?.workspaceId ?? ""));
}
export function orgoLifecycleBusy(): boolean { return locks.size > 0; }
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Orgo returned an invalid response");
  return value as Json;
}
export function redactOrgo(value: string, secrets: string[]): string {
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");
  return value.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\bsk_[A-Za-z0-9_-]+/g, "[redacted]");
}
class OrgoApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
// Fixed origin and redirect rejection prevent a provider response from sending
// either the account key or a short-lived viewer password to another host.
async function api(s: Snapshot, path: string, options: { method?: string; body?: Json; signal?: AbortSignal; timeoutMs?: number; token?: string; statusOnly?: boolean } = {}): Promise<Json> {
  const token = options.token ?? s.apiKey;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(API + path, {
      method: options.method ?? "GET", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("Orgo could not be reached. Check the computer before retrying; the request may have completed.");
  }
  if (response.ok && options.statusOnly) { await response.body?.cancel(); return { success: true }; }
  const text = await response.text();
  if (text.length > 24 * 1024 * 1024) throw new Error("Orgo response is too large");
  let body: Json;
  try { body = object(JSON.parse(text)); }
  catch { throw new Error(`Orgo returned an invalid response (HTTP ${response.status})`); }
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : "Request failed";
    throw new OrgoApiError(response.status, typeof body.code === "string" ? body.code : "",
      `Orgo: ${redactOrgo(message, [s.apiKey, token]).slice(0, 800)} (HTTP ${response.status})`);
  }
  return body;
}
async function workspaces(s: Snapshot): Promise<Json[]> {
  const body = await api(s, "/workspaces");
  if (!Array.isArray(body.workspaces)) throw new Error("Orgo returned an invalid workspace list");
  return body.workspaces.map((value) => {
    const workspace = object(value);
    if (typeof workspace.id !== "string" || !UUID.test(workspace.id) || typeof workspace.name !== "string" || !workspace.name.trim()) throw new Error("Orgo returned an invalid workspace");
    return workspace;
  });
}
export async function listWorkspaces(cfg: AppConfig): Promise<{ id: string; name: string }[]> {
  return (await workspaces(snapshot(cfg, false))).map((w) => ({ id: w.id as string, name: w.name as string }));
}
function parseComputer(value: unknown, s: Snapshot, expectedId: string, expectedName: string): OrgoComputer {
  const c = object(value);
  const workspaceId = c.workspace_id ?? c.project_id;
  if (c.id !== expectedId || !UUID.test(expectedId) || c.name !== expectedName || workspaceId !== s.workspaceId || c.os !== "linux" || !STATUSES.has(String(c.status))) throw new Error("The Orgo computer no longer matches this workspace and bot; no action was performed");
  if (object(c.permissions).canWrite !== true) throw new Error("This Orgo workspace is read-only. Ask its owner for computer write access");
  const instance = c.fly_instance_id ?? c.instance_id ?? null;
  const password = c.vnc_password ?? null;
  if (instance !== null && (typeof instance !== "string" || !INSTANCE.test(instance))) throw new Error("Orgo returned an invalid computer instance");
  if (password !== null && (typeof password !== "string" || !password || password.length > 4096)) throw new Error("Orgo returned an invalid viewer credential");
  return { id: expectedId, name: expectedName, workspace_id: s.workspaceId, status: c.status as string, fly_instance_id: instance, vnc_password: password };
}
async function readComputer(s: Snapshot, id: string, name: string, signal?: AbortSignal): Promise<OrgoComputer> {
  if (!UUID.test(id)) throw new Error("Invalid Orgo computer identity");
  return parseComputer(await api(s, `/computers/${id}`, { signal }), s, id, name);
}
async function findComputer(s: Snapshot, name: string): Promise<OrgoComputer | null> {
  const workspace = (await workspaces(s)).find((w) => w.id === s.workspaceId);
  if (!workspace) throw new Error("The selected Orgo workspace is not accessible with this API key");
  if (!Array.isArray(workspace.desktops)) throw new Error("Orgo returned an invalid computer inventory");
  const matches = workspace.desktops.map(object).filter((c) => c.name === name);
  if (matches.length > 1) throw new Error("Orgo returned duplicate managed computers; choose the intended computer in Orgo before continuing");
  if (!matches.length) return null;
  if (typeof matches[0].id !== "string") throw new Error("Orgo returned an invalid computer identity");
  // A stale list followed by a 404 is not permission to silently replace it.
  return readComputer(s, matches[0].id, name);
}
export async function computer(cfg: AppConfig, botId: string): Promise<OrgoComputer | null> {
  return findComputer(snapshot(cfg), orgoComputerName(botId));
}
const usable = (c: OrgoComputer) => c.status === "running" || c.status === "suspended";
export async function state(cfg: AppConfig, botId: string): Promise<OrgoComputerStatus> {
  if (!isConfigured(cfg)) return { configured: false, container: "missing" as const, ready: false, managed: true, box: null };
  const c = await computer(cfg, botId);
  return {
    configured: true, container: c ? usable(c) ? "running" as const : "stopped" as const : "missing" as const,
    ready: Boolean(c && usable(c)), managed: true,
    box: c ? { id: c.id, name: c.name, state: c.status } : null,
  };
}
async function locked<T>(s: Snapshot, name: string, action: () => Promise<T>): Promise<T> {
  const key = `${s.workspaceId}/${name}`;
  if (locks.has(key)) throw new Error("An Orgo computer operation is already in progress; wait for it to finish");
  locks.add(key);
  try { return await action(); } finally { locks.delete(key); }
}
const receipt = (c: OrgoComputer, reused = true) => ({
  boxId: c.id, machineName: c.name, state: c.status, reused,
  configured: true, managed: true, ready: usable(c),
  container: usable(c) ? "running" as const : "stopped" as const,
  box: { id: c.id, name: c.name, state: c.status },
});
async function waitOperation(s: Snapshot, c: OrgoComputer, response: Json, deadline: number): Promise<void> {
  if (response.operation_id === undefined) {
    if (response.success !== true) throw new Error("Orgo did not confirm the computer operation");
    return;
  }
  if (typeof response.operation_id !== "string" || !UUID.test(response.operation_id)) throw new Error("Orgo returned an invalid operation identity");
  // Construct the poll URL ourselves; never follow the API's arbitrary URL.
  while (Date.now() < deadline) {
    const operation = await api(s, `/computers/${c.id}/operations/${response.operation_id}`);
    if (operation.desktop_id !== c.id || operation.id !== response.operation_id) throw new Error("Orgo returned an operation for a different computer");
    if (operation.status === "succeeded") return;
    if (operation.status === "failed" || operation.status === "needs_review") throw new Error("Orgo could not confirm this operation. Check the computer in Orgo before retrying");
    if (operation.status !== "running" && operation.status !== "queued") throw new Error("Orgo returned an invalid operation status");
    await delay(2_000);
  }
  throw new Error("Orgo is still preparing this computer. Its operation was not repeated; check its status before retrying");
}
async function waitReady(s: Snapshot, id: string, name: string, deadline: number): Promise<OrgoComputer> {
  while (Date.now() < deadline) {
    const c = await readComputer(s, id, name);
    if (usable(c) && c.fly_instance_id && c.vnc_password) {
      // Paused computers resume on the first interaction, not via /start.
      if (c.status === "suspended") return c;
      // Official create docs specify readiness by HTTP 200, not its body.
      try { await api(s, `/desktops/${c.fly_instance_id}/proxy/health`, { token: c.vnc_password, timeoutMs: 5_000, statusOnly: true }); return c; }
      catch (error) { if (error instanceof OrgoApiError && error.status < 500 && error.status !== 404) throw error; }
    }
    if (["error", "deleted", "frozen", "stopped"].includes(c.status)) throw new Error(`Orgo computer is ${c.status}; no replacement was created`);
    await delay(2_000);
  }
  throw new Error("Orgo is still opening the computer. Check its status before trying again; its files were not replaced");
}
async function start(s: Snapshot, c: OrgoComputer): Promise<OrgoComputer> {
  const deadline = Date.now() + 300_000;
  if (["creating", "restarting", "updating"].includes(c.status)) return waitReady(s, c.id, c.name, deadline);
  if (!usable(c)) {
    const response = await api(s, `/computers/${c.id}/start?async=true`, { method: "POST" });
    await waitOperation(s, c, response, deadline);
  }
  return waitReady(s, c.id, c.name, deadline);
}
export async function provision(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), name = orgoComputerName(botId);
  return locked(s, name, async () => {
    let c = await findComputer(s, name);
    if (c) return receipt(await start(s, c));
    try {
      const created = await api(s, "/computers", { method: "POST", body: { workspace_id: s.workspaceId, name, os: "linux", ram: 4, cpu: 1 } });
      if (typeof created.id !== "string" || !UUID.test(created.id) || created.name !== name || (created.workspace_id ?? created.project_id) !== s.workspaceId) throw new Error("Orgo returned a different computer after creation; check Orgo before retrying");
      c = await readComputer(s, created.id, name);
    } catch (error) {
      // A lost-response retry may meet our exact existing name. No other 409,
      // foreign name, workspace, or account computer may be adopted.
      if (!(error instanceof OrgoApiError) || error.status !== 409 || !["NAME_TAKEN", "name_taken"].includes(error.code)) throw error;
      c = await findComputer(s, name);
      if (!c) throw new Error("Orgo reported a name collision but its managed computer could not be verified");
      return receipt(await start(s, c));
    }
    return receipt(await waitReady(s, c.id, name, Date.now() + 300_000), false);
  });
}
async function requireComputer(s: Snapshot, name: string): Promise<OrgoComputer> {
  const c = await findComputer(s, name);
  if (!c) throw new Error("This bot has no Orgo computer. Create one explicitly from its Computer panel");
  return c;
}
export async function wake(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), name = orgoComputerName(botId);
  return locked(s, name, async () => receipt(await start(s, await requireComputer(s, name))));
}
export async function sleep(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), name = orgoComputerName(botId);
  return locked(s, name, async () => {
    const c = await requireComputer(s, name);
    if (!["frozen", "stopped"].includes(c.status)) {
      await waitOperation(s, c, await api(s, `/computers/${c.id}/stop?async=true`, { method: "POST" }), Date.now() + 300_000);
    }
    const stopped = await readComputer(s, c.id, name);
    if (!["frozen", "stopped"].includes(stopped.status)) throw new Error("Orgo has not confirmed that the computer stopped");
    return receipt(stopped);
  });
}
export async function restart(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), name = orgoComputerName(botId);
  return locked(s, name, async () => {
    const c = await requireComputer(s, name);
    if (!usable(c)) return receipt(await start(s, c));
    const result = await api(s, `/computers/${c.id}/restart`, { method: "POST", timeoutMs: 300_000 });
    if (result.success !== true) throw new Error("Orgo did not confirm the computer restart");
    return receipt(await waitReady(s, c.id, name, Date.now() + 300_000));
  });
}
export async function remove(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), name = orgoComputerName(botId);
  return locked(s, name, async () => {
    const c = await findComputer(s, name);
    if (!c) return { removed: true };
    const result = await api(s, `/computers/${c.id}`, { method: "DELETE" });
    if (result.success !== true) throw new Error("Orgo did not confirm computer deletion");
    try { await readComputer(s, c.id, name); }
    catch (error) { if (error instanceof OrgoApiError && error.status === 404) return { removed: true }; throw error; }
    throw new Error("Orgo computer deletion has not completed; the bot was not removed");
  });
}
export async function inspectOwned(cfg: AppConfig): Promise<{ boxId: string; name: string }[]> {
  const s = snapshot(cfg, false), prefix = ownedPrefix(), found: { boxId: string; name: string }[] = [];
  for (const w of await workspaces(s)) {
    if (!Array.isArray(w.desktops)) throw new Error("Orgo returned an invalid computer inventory");
    for (const raw of w.desktops) {
      const c = object(raw);
      if (typeof c.name !== "string" || !c.name.startsWith(prefix) || !/^[0-9a-f]{24}$/.test(c.name.slice(prefix.length))) continue;
      if (typeof c.id !== "string") throw new Error("Orgo returned an invalid managed computer identity");
      await readComputer({ ...s, workspaceId: w.id as string }, c.id, c.name);
      found.push({ boxId: c.id, name: c.name });
    }
  }
  return found;
}
export async function validateReplacement(cfg: AppConfig, next: AppConfig): Promise<void> {
  if (!cfg.orgo?.apiKey?.trim()) return;
  const sameKey = cfg.orgo.apiKey.trim() === next.orgo?.apiKey?.trim();
  const workspaceChanged = (cfg.orgo.workspaceId ?? "") !== (next.orgo?.workspaceId ?? "");
  if (sameKey && !workspaceChanged) return;
  const existing = await inspectOwned(cfg);
  if (!existing.length) return;
  if (workspaceChanged && cfg.orgo.workspaceId) {
    const workspace = (await workspaces(snapshot(cfg, false))).find((w) => w.id === cfg.orgo?.workspaceId);
    const ids = new Set(existing.map((c) => c.boxId));
    if (Array.isArray(workspace?.desktops) && workspace.desktops.some((raw) => ids.has(String(object(raw).id)))) {
      throw new Error("Delete this workspace's Orgo computers before changing or clearing the selected workspace");
    }
  }
  if (sameKey) return;
  if (!next.orgo?.apiKey?.trim()) throw new Error("Delete this workspace's Orgo computers before disconnecting its API key");
  const accessible = new Map((await inspectOwned(next)).map((c) => [c.boxId, c.name]));
  if (existing.some((c) => accessible.get(c.boxId) !== c.name)) throw new Error("The new Orgo key cannot manage the existing computers. Keep the current account or delete its computers first");
}
export async function mcp(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), c = await requireComputer(s, orgoComputerName(botId));
  if (!usable(c)) throw new Error("Start this bot's Orgo computer explicitly before using it");
  return {
    command: process.execPath, args: ["--experimental-strip-types", SPAWNED_PROXIES.orgoComputer],
    env: { ELECTRON_RUN_AS_NODE: "1", ORGO_API_KEY: s.apiKey, ORGO_WORKSPACE_ID: s.workspaceId, ORGO_COMPUTER_ID: c.id, ORGO_COMPUTER_NAME: c.name },
    platform: "linux" as const,
  };
}

const coordinate = z.number().int().min(0).max(32767);
const schemas = {
  screenshot: z.object({}).strict(), get_screen_size: z.object({}).strict(),
  click: z.object({ x: coordinate, y: coordinate, button: z.enum(["left", "middle", "right"]).optional(), count: z.number().int().min(1).max(3).optional() }).strict(),
  move: z.object({ x: coordinate, y: coordinate }).strict(),
  drag: z.object({ x: coordinate, y: coordinate, to_x: coordinate, to_y: coordinate }).strict(),
  type_text: z.object({ text: z.string().max(4000) }).strict(),
  key_press: z.object({ key: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+]+$/) }).strict(),
  scroll: z.object({ x: coordinate, y: coordinate, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(30).optional() }).strict(),
  open_url: z.object({ url: z.string().max(2000).url().regex(/^https?:\/\//) }).strict(),
  exec: z.object({ command: z.string().min(1).max(16000), timeout: z.number().int().min(1).max(300).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  screenshot: "See the assigned Orgo desktop at native pixel resolution.", get_screen_size: "Get the Orgo desktop width and height.",
  click: "Click a point on the Orgo desktop.", move: "Move the Orgo pointer.", drag: "Drag between two points on the Orgo desktop.",
  type_text: "Type Unicode text into the focused Orgo application.", key_press: "Press an X11 key or shortcut (Return, BackSpace, ctrl+c).",
  scroll: "Scroll at a point on the Orgo desktop.", open_url: "Request opening an HTTP or HTTPS URL; inspect the screen to confirm it loaded.",
  exec: "Run a Bash command on the assigned Orgo computer, not the local host. Non-zero exits are failures.",
};
export const ORGO_TOOLS = Object.entries(schemas).map(([name, schema]) => {
  const inputSchema = z.toJSONSchema(schema, { target: "draft-7" });
  delete inputSchema.$schema;
  // Provider MCP converters drop format constraints. Keep the advertised
  // contract flat; the original Zod schema still validates URLs at runtime.
  for (const property of Object.values(inputSchema.properties ?? {})) {
    if (property && typeof property === "object") delete property.format;
  }
  return { name, description: descriptions[name as keyof typeof schemas], inputSchema };
});
export type OrgoToolResult = { content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[]; isError?: boolean };
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function textResult(text: string, isError = false): OrgoToolResult { return { content: [{ type: "text", text }], isError }; }
async function capture(s: Snapshot, c: OrgoComputer, signal?: AbortSignal) {
  const r = await api(s, `/computers/${c.id}/screenshot?response_format=base64&format=png`, { signal });
  if (r.success !== true || r.mime_type !== "image/png" || typeof r.image !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.image)) throw new Error("Orgo returned an invalid screenshot");
  const image = Buffer.from(r.image, "base64");
  if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Orgo returned an invalid screenshot");
  return { png: r.image, format: "png" as const };
}
export async function screenshot(cfg: AppConfig, botId: string) {
  const s = snapshot(cfg), c = await requireComputer(s, orgoComputerName(botId));
  if (!usable(c)) throw new Error("Start this bot's Orgo computer to see its screen");
  return capture(s, c);
}
export async function leasedComputerAction(lease: OrgoLease, name: string, args: unknown, signal?: AbortSignal): Promise<OrgoToolResult> {
  // Validate before any network request: Orgo itself silently defaults some
  // malformed pointer/key actions, which must not become accidental clicks.
  if (!Object.hasOwn(schemas, name)) throw new Error("Unknown Orgo computer tool");
  const parsed = schemas[name as keyof typeof schemas].safeParse(args);
  if (!parsed.success) throw new Error("Invalid Orgo computer tool arguments");
  if (!lease.apiKey || !UUID.test(lease.workspaceId) || !UUID.test(lease.computerId) || !/^openmausbot-orgo-[0-9a-f]{12}-[0-9a-f]{24}$/.test(lease.computerName)) throw new Error("Orgo computer lease missing or invalid");
  signal?.throwIfAborted();
  const c = await readComputer(lease, lease.computerId, lease.computerName, signal);
  if (!usable(c)) throw new Error("The assigned Orgo computer is stopped; no action was performed");
  const a = parsed.data as Record<string, string | number | undefined>;
  if (name === "screenshot") {
    const shot = await capture(lease, c, signal);
    return { content: [{ type: "image", mimeType: "image/png", data: shot.png }] };
  }
  let endpoint: string, body: Json;
  switch (name) {
    case "click": endpoint = "click"; body = { x: a.x, y: a.y, button: a.button ?? "left", repeat: a.count ?? 1 }; break;
    case "move": endpoint = "mouse-move"; body = { x: a.x, y: a.y }; break;
    case "drag": endpoint = "drag"; body = { start_x: a.x, start_y: a.y, end_x: a.to_x, end_y: a.to_y }; break;
    case "type_text": endpoint = "type"; body = { text: a.text, delay_ms: 1 }; break;
    case "key_press": endpoint = "key"; body = { key: a.key }; break;
    case "scroll":
      if (a.direction === "up" || a.direction === "down") { endpoint = "scroll"; body = { x: a.x, y: a.y, direction: a.direction, amount: a.amount ?? 3 }; }
      else { endpoint = "bash"; body = { command: `export DISPLAY=:99; xdotool mousemove --sync ${a.x} ${a.y} click --repeat ${a.amount ?? 3} --delay 80 ${a.direction === "left" ? 6 : 7}`, timeout: 30 }; }
      break;
    case "get_screen_size": endpoint = "bash"; body = { command: "export DISPLAY=:99; xdotool getdisplaygeometry", timeout: 30 }; break;
    case "open_url": endpoint = "bash"; body = { command: `export DISPLAY=:99; nohup xdg-open ${quote(String(a.url))} >/dev/null 2>&1 </dev/null &`, timeout: 30 }; break;
    case "exec": endpoint = "bash"; body = { command: `export DISPLAY=:99; ${a.command}`, timeout: a.timeout ?? 200 }; break;
    default: throw new Error("Unknown Orgo computer tool");
  }
  const result = await api(lease, `/computers/${c.id}/${endpoint}`, { method: "POST", body, signal, timeoutMs: endpoint === "bash" ? (Number(body.timeout) + 30) * 1000 : 35_000 });
  signal?.throwIfAborted();
  if (endpoint === "bash") {
    if (result.success !== true || !Number.isInteger(result.exit_code) || typeof result.output !== "string") throw new Error("Orgo returned an invalid command result");
    if (name === "open_url" && result.exit_code === 0) return textResult("Browser launch requested. Page loading is not confirmed; inspect the screen before continuing.");
    return textResult(JSON.stringify({ exitCode: result.exit_code, output: redactOrgo(result.output, [lease.apiKey, c.vnc_password ?? ""]) }), result.exit_code !== 0);
  }
  if (result.success !== true) throw new Error("Orgo did not confirm the computer action");
  return textResult("Computer action completed. Take a screenshot to inspect the result.");
}
export async function computerAction(cfg: AppConfig, botId: string, name: string, args: unknown, signal?: AbortSignal) {
  const s = snapshot(cfg), c = await requireComputer(s, orgoComputerName(botId));
  return leasedComputerAction({ ...s, computerId: c.id, computerName: c.name }, name, args, signal);
}
