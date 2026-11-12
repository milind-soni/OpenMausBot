// `openmausbot` on the command line: run the server anywhere and pair devices to it.
//
//   openmausbot setup [--data-dir ~/.openmausbot]
//   openmausbot start [serve options]
//   openmausbot serve [--port 8799] [--data-dir ~/.openmausbot] [--label "cab mini"]
//                     [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--relay] [--no-pair]
//   openmausbot pair  [--label "My MacBook"] [--client] [--public-url https://host]
//   openmausbot sessions [revoke <id>]
//   openmausbot status
//   openmausbot login [--email you@example.com] [--relay]
//   openmausbot logout
//   openmausbot run | send | wait | doctor | team apply | export | …
//
// This module only exports: openmausbot.ts runs main(), so bundling this file into other entries never runs it twice.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { phonePairingLink } from "../shared/pairing-link.ts";
import { parseAllowList } from "./account-signin.ts";
import { appendAdminAction, flushAdminActivity, sharedSignIn } from "./admin-activity.ts";
import { bindDecisionRetention, decisionRetentionDays } from "./decision-log.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import { resolveLoopbackTrust } from "./request-auth.ts";
import { restartPolicy } from "./restart.ts";
import { writeFileAtomic } from "./atomic.ts";
import { ensureCaddy, normalizeDomainOption, startCaddy, type RunningCaddy } from "./caddy.ts";
import { runServiceCommand } from "./service-cli.ts";
import { runSentinelCli } from "./sentinel/cli.ts";
import { runFleetCommand, type FleetInput } from "./fleet-cli.ts";
import { startFleetAgent } from "./fleet-agent.ts";
import { fleetLayout } from "./fleet.ts";
import { clearLeftoverTailscaleServe, explainTailscaleFailure, tailnetListenFallback, tailscaleServe, tailscaleStatus, type TailscaleStatus } from "./tailscale.ts";
import { defaultSetupIo, SetupCancelled, type SetupIo } from "./cli-prompts.ts";
import { HEADLESS_VERB_NAMES, usage } from "./cli-usage.ts";
import { normalizePhoneOrigin, phonePairingInstructions, runPhoneSetup } from "./cli-phone-setup.ts";
import { browserSignInLines, desktopOwnedRefusal, formatSessions, pairingBlock, RELAY_NOT_WITH_TUNNEL, relayPairingBlock, showRelayPairing } from "./cli-pairing.ts";
import { cliCommand, cliPrefix } from "./cli-invocation.ts";
import { checkReach, envPublicUrl, lanProblem, localLinkBase, noRouteLines, publicUrlProblem, reachLines, waitForReach, type Route } from "./cli-reach.ts";
import { lanUrl } from "./lan-address.ts";
import { isLoopbackHost } from "../electron/server-address.mjs";
import { parseDuration } from "./headless/args.ts";
import { signInFromEnv, type AppConfig } from "./config.ts";
import {
  cleanupTunnelOrigin,
  createTunnelAccount,
  createTunnelOrigin,
  describeTunnelAccount,
  describeTunnelState,
  ensureCloudflared,
  FLEET_CREDENTIAL_ENV,
  fleetAccess,
  fleetCredential,
  guardianEntry,
  startTunnel,
  tunnelAccess,
  type CompanionOriginEndpoint,
  type ManagedTunnelAccess,
  type RunningTunnel,
  type TunnelAccount,
  type TunnelRecovery,
} from "./tunnel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
  command: "setup" | "start" | "serve" | "pair" | "sessions" | "status" | "login" | "logout" | "access" | "service" | "browser" | "fleet" | "help" | "version";
  port: number;
  dataDir: string;
  label?: string;
  publicUrl?: string;
  /** `serve --domain host`: HTTPS on your own domain through a managed Caddy. */
  domain?: string;
  tailscale: boolean;
  tunnel: boolean;
  relay?: boolean;
  /** `serve --lan`: every private address of this machine, plain http, each connection held to private ends. */
  lan?: boolean;
  client: boolean;
  pair: boolean;
  revoke?: string;
  /** `access list|add|remove` */
  accessAction?: "list" | "add" | "remove";
  chatOnly?: boolean;
  /** `service install|uninstall` */
  serviceAction?: "install" | "uninstall";
  sentinel?: boolean;
  email?: string;
  /** `browser install [--with-deps]` */
  browserAction?: "install" | "status";
  /** `fleet init|create|list|users|suspend|resume|delete|upgrade|agent` */
  fleetAction?: FleetInput["action"] | "agent";
  operator?: string;
  socket?: string;
  group?: string;
  slug?: string;
  admins?: string[];
  members?: string[];
  brandFile?: string;
  anthropicKeyFile?: string;
  cap?: number;
  licenseKey?: string;
  memory?: string;
  dryRun?: boolean;
  yes?: boolean;
  keepData?: boolean;
  fleetUserAction?: "add" | "remove";
  withDeps?: boolean;
  json: boolean;
  /** Explicitly ignore saved remote access for this launch. */
  local?: boolean;
  open?: boolean;
  guided?: boolean;
  phone?: "ios" | "android";
  /** `pair --ttl 24h`: how long the code stays open. */
  pairTtlMs?: number;
}

const COMMANDS = ["setup", "start", "serve", "pair", "sessions", "devices", "status", "login", "logout", "access", "service", "browser", "fleet", "help", "--help", "-h", "--version", "-v", "version"];

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | { error: string } {
  const implicitStart = !argv.length || (argv[0]!.startsWith("--") && argv[0] !== "--help" && argv[0] !== "--version");
  const [command = "start", ...rest] = implicitStart ? ["start", ...argv] : argv;
  if (!COMMANDS.includes(command)) {
    return { error: `unknown command "${command}"` };
  }
  const options: CliOptions = {
    command: command === "--help" || command === "-h" ? "help" : command === "--version" || command === "-v" ? "version" : command === "devices" ? "sessions" : (command as CliOptions["command"]),
    port: Number(env.OMB_PORT || 8799),
    dataDir: env.OMB_DATA_DIR || join(homedir(), ".openmausbot"),
    tailscale: false,
    tunnel: false,
    client: false,
    pair: true,
    withDeps: false,
    json: false,
    chatOnly: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    try {
      if (arg === "--port") options.port = Number(value());
      else if (arg === "--data-dir") options.dataDir = resolve(value());
      else if (arg === "--label") options.label = value();
      else if (arg === "--public-url") options.publicUrl = value().replace(/\/+$/, "");
      else if (arg === "--tailscale") options.tailscale = true;
      else if (arg === "--lan") options.lan = true;
      else if (arg === "--domain") {
        const domain = normalizeDomainOption(value());
        if (typeof domain !== "string") return domain;
        options.domain = domain;
      }
      else if (arg === "--tunnel" || arg === "--relay") options[arg === "--tunnel" ? "tunnel" : "relay"] = true;
      else if (arg === "--client" || (options.command === "pair" && arg === "--chat-only")) options.client = true;
      // Which phone will scan; only Android needs a different QR. `pair --phone` alone is a chat-only code for any phone.
      else if (arg === "--phone") {
        const kind = rest[i + 1]?.toLowerCase();
        if (kind === "ios" || kind === "android") { options.phone = kind; i += 1; }
        else if (options.command === "pair") options.phone = "ios";
        else return { error: "--phone takes ios or android" };
      }
      else if (options.command === "pair" && arg === "--ttl") options.pairTtlMs = parseDuration(value(), "--ttl", { min: 60_000 });
      else if (arg === "--help" || arg === "-h") options.command = "help";
      else if (arg === "--no-pair") options.pair = false;
      else if (arg === "--no-open") options.open = false;
      else if (arg === "--local") options.local = true;
      else if (arg === "--json") options.json = true;
      else if (arg === "--email") options.email = value();
      else if (options.command === "sessions" && (arg === "revoke" || arg === "list")) { if (arg === "revoke") options.revoke = value(); }
      else if (options.command === "access" && !options.accessAction && (arg === "list" || arg === "add" || arg === "remove")) {
        options.accessAction = arg;
        if (arg !== "list") options.email = value();
      } else if (options.command === "access" && arg === "--chat-only") options.chatOnly = true;
      else if (options.command === "service" && !options.serviceAction && (arg === "install" || arg === "uninstall")) options.serviceAction = arg;
      else if (options.command === "service" && arg === "--sentinel") options.sentinel = true;
      else if (options.command === "browser" && (arg === "install" || arg === "status")) options.browserAction = arg;
      else if (options.command === "browser" && arg === "--with-deps") options.withDeps = true;
      else if (options.command === "fleet" && !options.fleetAction && ["init", "create", "list", "users", "suspend", "resume", "delete", "upgrade", "agent"].includes(arg)) options.fleetAction = arg as FleetInput["action"] | "agent";
      else if (options.command === "fleet" && options.fleetAction && !["init", "list", "upgrade", "agent"].includes(options.fleetAction) && !options.slug && !arg.startsWith("--")) options.slug = arg;
      else if (options.command === "fleet" && arg === "--operator") options.operator = value();
      else if (options.command === "fleet" && arg === "--socket") options.socket = value();
      else if (options.command === "fleet" && arg === "--group") options.group = value();
      else if (options.command === "fleet" && options.fleetAction === "users" && options.slug && !options.fleetUserAction && (arg === "add" || arg === "remove")) { options.fleetUserAction = arg; options.email = value(); }
      else if (options.command === "fleet" && arg === "--admin") options.admins = [...(options.admins ?? []), value()];
      else if (options.command === "fleet" && arg === "--member") options.members = [...(options.members ?? []), value()];
      else if (options.command === "fleet" && arg === "--brand") options.brandFile = resolve(value());
      else if (options.command === "fleet" && arg === "--anthropic-key-file") options.anthropicKeyFile = resolve(value());
      else if (options.command === "fleet" && arg === "--cap") options.cap = Number(value());
      else if (options.command === "fleet" && arg === "--license-key") options.licenseKey = value();
      else if (options.command === "fleet" && arg === "--memory") options.memory = value();
      else if (options.command === "fleet" && arg === "--dry-run") options.dryRun = true;
      else if (options.command === "fleet" && arg === "--yes") options.yes = true;
      else if (options.command === "fleet" && arg === "--keep-data") options.keepData = true;
      else if (options.command === "fleet" && arg === "--chat-only") options.chatOnly = true;
      else return { error: `unknown argument "${arg}"` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return { error: "--port must be 1-65535" };
  const publicUrlRefusal = options.publicUrl ? publicUrlProblem(options.publicUrl) : null;
  if (publicUrlRefusal) return { error: publicUrlRefusal };
  if (options.tunnel && (options.tailscale || options.relay)) return { error: options.relay ? "choose one of --relay (phones through MausBot Relay) and --tunnel (a public address)" : "choose one of --tailscale (your tailnet) and --tunnel (a public address)" };
  if (options.command === "access" && !options.accessAction) return { error: "access needs one of: list, add EMAIL [--chat-only], remove EMAIL" };
  if (options.command === "service" && !options.serviceAction) return { error: "service needs one of: install [the same options as serve], uninstall" };
  if (options.domain && (options.tailscale || options.tunnel || options.publicUrl)) return { error: "--domain already gives the server its address; drop --tailscale, --tunnel and --public-url" };
  if (options.local && (options.tailscale || options.tunnel || options.publicUrl || options.lan || options.relay)) return { error: "--local cannot be combined with a remote-access option" };
  if (options.command === "browser" && !options.browserAction) return { error: "browser needs an action: install or status" };
  if (options.command === "fleet") {
    if (!options.fleetAction) return { error: "fleet needs one of: init --domain HOST [--operator USER], create NAME --admin EMAIL, list, users NAME add|remove EMAIL, suspend NAME, resume NAME, delete NAME --yes, upgrade, agent" };
    if (["create", "users", "suspend", "resume", "delete"].includes(options.fleetAction) && !options.slug) return { error: `fleet ${options.fleetAction} needs a workspace name` };
    if (options.fleetAction === "users" && !options.fleetUserAction) return { error: "fleet users needs: NAME add|remove EMAIL [--chat-only]" };
    if (options.cap !== undefined && (!Number.isFinite(options.cap) || options.cap < 0)) return { error: "--cap must be a dollar amount of 0 or more" };
  }
  return options;
}

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
  ask(question: string): Promise<string>;
}

export function defaultIo(): CliIo {
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export function serverVersion(here = HERE): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
    const version = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "version") : undefined;
    return typeof version === "string" && version ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** On a service-trust server: the secret `serve` handed the server it started, which opens its pairing route. */
let serveOwnerToken: string | undefined;

async function api(port: number, path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
  // x-openmausbot-cli names the tool in the activity log; on loopback it grants nothing.
  const headers: Record<string, string> = { "content-type": "application/json", "x-openmausbot-cli": "1", ...(serveOwnerToken ? { "x-openmausbot-cli-owner": serveOwnerToken } : {}) };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method, body: init.body, headers, signal: AbortSignal.timeout(3000) });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export const SERVICE_TRUST_HELP = "This server does not treat commands on this computer as its owner (OMB_LOOPBACK_TRUST=service, or a hosted workspace), so it will not pair devices or list sessions for them. Sign in as an admin and use Settings → Remote access, let people sign in with their email (openmausbot access add you@example.com), or restart the server with OMB_LOOPBACK_TRUST=owner.";

function refusedAsService(status: number, body: any): boolean {
  return status === 403 && typeof body?.error === "string" && /shared server|Sign in through the workspace portal/.test(body.error);
}

async function serverUp(port: number, pid?: number): Promise<boolean> {
  try {
    const { status, body } = await api(port, "/api/health");
    return status === 200 && body?.app === "openmausbot" && (pid === undefined || body.pid === pid);
  } catch {
    return false;
  }
}

/** Never attach to another workspace just because it listens on the requested port. */
export async function isWorkspaceRunning(options: CliOptions): Promise<boolean> {
  try {
    const { status, body } = await api(options.port, "/api/health");
    if (status !== 200 || body?.app !== "openmausbot") return false;
    const expected = readFileSync(join(options.dataDir, "environment-id"), "utf8").trim();
    const descriptor = await api(options.port, "/.well-known/openmausbot/environment");
    return /^[0-9a-f-]{36}$/i.test(expected) && descriptor.status === 200 && descriptor.body?.environmentId === expected;
  } catch { return false; }
}

/** No shell commands, credentials or remote URLs go to the OS URL opener. */
export async function openDashboard(port: number, env = process.env): Promise<boolean> {
  if (env.SSH_CONNECTION || env.SSH_TTY || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return false;
  const url = `http://127.0.0.1:${port}`;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); done(false); }, 3000);
    child.once("error", () => { clearTimeout(timer); done(false); });
    child.once("exit", (code) => { clearTimeout(timer); done(code === 0); });
  });
}

/** Something already answers there as a MausBot server (before this one has started). */
const answersAsMausBot = async (origin: string) => typeof (await fetch(`${origin}/.well-known/openmausbot/environment`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json() as Promise<{ environmentId?: unknown }>).catch(() => null))?.environmentId === "string";

/** Its public descriptor must identify this exact server; never sends a pairing code or credential. */
export async function verifyPhoneEndpoint(port: number, origin: string): Promise<boolean> {
  return Boolean(normalizePhoneOrigin(origin)) && (await checkReach(port, origin)).ok;
}

export function applyStartupPreferences(options: CliOptions, saved: AppConfig["cliStartup"]): CliOptions {
  if (options.local) return { ...options, tunnel: false, tailscale: false, publicUrl: undefined, phone: undefined };
  if (!saved || options.tunnel || options.tailscale || options.publicUrl) return options; if (options.relay && saved.access === "tunnel") throw new Error(RELAY_NOT_WITH_TUNNEL);
  if (saved.access === "public-url" && (!saved.publicUrl || !normalizePhoneOrigin(saved.publicUrl))) {
    throw new Error(`The saved phone address is not a valid HTTPS origin. Run ${cliCommand("setup")} to correct it, or ${cliCommand("--local")} to start only on this computer.`);
  }
  return {
    ...options,
    tunnel: saved.access === "tunnel", tailscale: saved.access === "tailscale",
    publicUrl: saved.access === "public-url" ? saved.publicUrl : undefined,
    phone: saved.access === "local" ? undefined : saved.phone,
  };
}

function startupPreferences(options: CliOptions): NonNullable<AppConfig["cliStartup"]> {
  const access = options.local ? "local" : options.tunnel ? "tunnel" : options.tailscale ? "tailscale" : options.publicUrl ? "public-url" : "local";
  const publicUrl = access === "public-url" ? normalizePhoneOrigin(options.publicUrl!) : null;
  if (access === "public-url" && !publicUrl) throw new Error("Use an HTTPS origin without a password, path or query for saved phone access. The address was not saved.");
  return {
    access,
    ...(publicUrl ? { publicUrl } : {}),
    ...(!options.local && options.phone ? { phone: options.phone } : {}),
  };
}

async function showPhonePairing(options: CliOptions, origin: string | undefined, log: (line: string) => void): Promise<boolean> {
  if (options.relay) return showRelayPairing({ tty: process.stdout.isTTY === true, status: async () => (await api(options.port, "/api/auth/pairing")).body?.relay, mint: () => mintPairing(options.port, { client: true, label: options.label ?? (options.phone === "android" ? "Android" : "iPhone / iPad"), phone: options.phone ?? "ios" }), log, prefix: cliPrefix() });
  const ready = !!origin && await verifyPhoneEndpoint(options.port, origin);
  if (!ready) {
    log("Phone access is not reachable yet. OpenMausBot is ready on this computer; no phone pairing code was created.");
    log(`Check the HTTPS connection, then run ${cliCommand("pair")} again with the same --data-dir and --port.`);
    return false;
  }
  for (const line of phonePairingInstructions(options.phone ?? "ios", { origin: origin!, ready })) log(line);
  log(await mintPairing(options.port, { client: true, label: options.label ?? (options.phone === "android" ? "Android" : "iPhone / iPad"), publicUrl: origin, phone: options.phone }));
  log("Waiting for you to connect on the phone. Keep this terminal and the code private.");
  return true;
}

async function mintPairing(port: number, options: { label?: string; client?: boolean; publicUrl?: string; phone?: "ios" | "android"; guided?: boolean; ttlMs?: number }): Promise<string> {
  const chatOnly = Boolean(options.client || options.phone);
  const request = { ...(options.label ? { label: options.label } : {}), ...(chatOnly ? { scopes: ["client"] } : {}), ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) };
  const { status, body } = await api(port, "/api/auth/pairing", { method: "POST", body: JSON.stringify(request) });
  const refusal = refusedAsService(status, body) ? SERVICE_TRUST_HELP : desktopOwnedRefusal(status, body);
  if (refusal || status !== 200) throw new Error(refusal ?? `server refused to mint a pairing code: ${typeof body?.error === "string" ? body.error : status}`);
  const reachable = options.publicUrl && !isLoopbackHost(new URL(options.publicUrl).hostname) ? options.publicUrl : null;
  const link = reachable ? `${reachable}/pair#code=${body.code}` : typeof body.url === "string" && !isLoopbackHost(new URL(body.url).hostname) ? body.url : null;
  const invite = (reachable && typeof body.credential === "string" ? phonePairingLink({ address: reachable, token: body.credential, name: typeof body.serverName === "string" ? body.serverName : undefined }) : null) ?? (typeof body.inviteUrl === "string" ? body.inviteUrl : null);
  const local = localLinkBase(options.publicUrl ?? null, port);
  if (options.guided) return browserSignInLines(`${local.base}/pair#code=${body.code}`, body.code, body.expiresAt);
  return relayPairingBlock(body, chatOnly, cliPrefix()) ?? pairingBlock({ code: body.code, expiresAt: body.expiresAt, chatOnly, link, localLink: `${local.base}/pair#code=${body.code}`, localPlace: local.place, inviteUrl: invite, phone: options.phone, prefix: cliPrefix() });
}

/** Never asks anything: the running server's own address (its routes) goes in the link. */
export async function runPair(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`No MausBot server is running here. Start it: ${cliCommand("serve")}${options.port !== 8799 ? ` (or name its port: --port ${options.port})` : ""}`);
    return 1;
  }
  const advertised = await api(options.port, "/api/auth/pairing").catch(() => ({ status: 0, body: {} as any }));
  const origin = options.publicUrl ?? (typeof advertised.body?.publicUrl === "string" ? advertised.body.publicUrl : undefined);
  console.log(await mintPairing(options.port, { label: options.label, client: options.client, publicUrl: origin, phone: options.phone, ttlMs: options.pairTtlMs }));
  if (origin && origin.startsWith("https:") && !isLoopbackHost(new URL(origin).hostname)) {
    const reach = await checkReach(options.port, origin);
    if (!reach.ok) for (const line of [...reachLines("public-url", origin, options.port, cliPrefix(), reach), "The code works once the address answers."]) console.log(line);
  }
  return 0;
}

export async function runSessions(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    return 1;
  }
  if (options.revoke) {
    const { status, body } = await api(options.port, `/api/auth/sessions/${encodeURIComponent(options.revoke)}`, { method: "DELETE" });
    if (refusedAsService(status, body)) {
      console.error(SERVICE_TRUST_HELP);
      return 1;
    }
    if (status !== 200) {
      console.error(`could not revoke: ${typeof body?.error === "string" ? body.error : status}`);
      return 1;
    }
    console.log(`revoked ${options.revoke}: that device is signed out and its stream is closed`);
    return 0;
  }
  const { status, body } = await api(options.port, "/api/auth/sessions");
  if (refusedAsService(status, body)) {
    console.error(SERVICE_TRUST_HELP);
    return 1;
  }
  if (status !== 200) {
    console.error(`could not list sessions: ${typeof body?.error === "string" ? body.error : status}`);
    return 1;
  }
  const sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }> = Array.isArray(body?.sessions) ? body.sessions : [];
  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }
  if (!sessions.length) {
    console.log(`no paired devices yet: run ${cliCommand("pair")}`);
    return 0;
  }
  console.log(formatSessions(sessions));
  return 0;
}

export async function runStatus(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const body: any = await fetch(`http://127.0.0.1:${options.port}/.well-known/openmausbot/environment`).then((r) => r.json()).catch(() => null);
  if (body && options.json) io.log(JSON.stringify(body, null, 2));
  if (!body) io.error(`No MausBot server is running here. Start it: ${cliCommand("serve")}`);
  if (body && !options.json) {
    io.log(`Server "${body.label}"   running · MausBot ${body.version} on ${body.platform}\n  Local        127.0.0.1:${options.port}`);
    const address = await api(options.port, "/api/auth/pairing").then((r) => (typeof r.body?.publicUrl === "string" ? r.body.publicUrl as string : null)).catch(() => null);
    if (!address || isLoopbackHost(new URL(address).hostname)) io.log(`  Address      none: reachable from this machine only. Ways in: ${cliCommand("serve --help")}`);
    else for (const line of reachLines(address.startsWith("http:") ? "lan" : "public-url", address, options.port, cliPrefix(), address.startsWith("http:") ? undefined : await checkReach(options.port, address))) io.log(`  ${line.replace(/^Reach   /, "Address     ")}`);
    const sessions = await api(options.port, "/api/auth/sessions").catch(() => null);
    if (Array.isArray(sessions?.body?.sessions)) io.log(`Paired   ${sessions.body.sessions.length} device${sessions.body.sessions.length === 1 ? "" : "s"}   ${cliCommand("devices")}`);
  }
  const account = options.json ? null : describeTunnelAccount(createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() }).credentials.read());
  if (!options.json && fleetCredential()) io.log(`MausBot web address: managed by the fleet (${FLEET_CREDENTIAL_ENV} is set)`);
  else if (account?.address) io.log(`MausBot web address: ${account.address} (signed in as ${account.email ?? "?"}; serve it with ${cliCommand("serve --tunnel")})`);
  return body ? 0 : 1;
}

/** Edits the sign-in allow-list in config.json, server live or stopped (read per request); OMB_SIGNIN_EMAILS wins when it names someone. */
export async function runAccess(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const file = join(options.dataDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      raw = Object.fromEntries(Object.entries(parsed));
    } catch (error) {
      io.error(`${file} could not be read (${message(error)}); fix it before changing who can sign in`);
      return 1;
    }
  }
  const current = typeof raw.signIn === "object" && raw.signIn !== null ? Object(raw.signIn) : {};
  const list = (value: unknown) => parseAllowList(Array.isArray(value) ? value.map(String).join(",") : "");
  const admins = list(Reflect.get(current, "admins"));
  const members = list(Reflect.get(current, "members"));
  const overridden = Object.keys(signInFromEnv()).length > 0; // a variable that names nobody leaves the list to this file
  const write = async (next: { admins: string[]; members: string[] }) => {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ ...raw, signIn: next }, null, 2)}\n`, { mode: 0o600 });
    if (!sharedSignIn({ admins, members }) && !sharedSignIn(next) && !hostedWorkspaceConfigured()) return;
    const decisions = raw.decisions && typeof raw.decisions === "object" ? (raw.decisions as { retentionDays?: unknown }).retentionDays : undefined;
    bindDecisionRetention(() => decisionRetentionDays(typeof decisions === "number" ? decisions : undefined));
    const changed = (["admins", "members"] as const).filter((key) => next[key].join(",") !== (key === "admins" ? admins : members).join(","));
    appendAdminAction(options.dataDir, {
      category: "people", action: "people.update", target: { kind: "settings" }, actor: { kind: "cli" },
      changed: changed.map((key) => `signIn.${key}`),
      before: Object.fromEntries(changed.map((key) => [`signIn.${key}`, key === "admins" ? admins : members])),
      after: Object.fromEntries(changed.map((key) => [`signIn.${key}`, next[key]])),
    });
    await flushAdminActivity(options.dataDir);
  };
  if (options.accessAction === "list") {
    if (!admins.length && !members.length) {
      io.log("nobody can sign in with an email yet; pairing codes only. Add someone with: openmausbot access add you@example.com");
      return 0;
    }
    for (const entry of admins) io.log(`${entry.padEnd(40)} full access`);
    for (const entry of members) io.log(`${entry.padEnd(40)} chat and approvals`);
    if (overridden) io.log("(OMB_SIGNIN_EMAILS / OMB_SIGNIN_MEMBER_EMAILS are set in the environment and win over this list while the server runs)");
    return 0;
  }
  const entry = (options.email ?? "").trim().toLowerCase();
  if (!entry || (!entry.startsWith("@") && !entry.includes("@")) || /\s/.test(entry)) {
    io.error("give an email address, or @domain for everyone at that domain");
    return 2;
  }
  const without = (items: string[]) => items.filter((item) => item !== entry);
  if (options.accessAction === "remove") {
    if (!admins.includes(entry) && !members.includes(entry)) {
      io.error(`${entry} is not on the list`);
      return 1;
    }
    await write({ admins: without(admins), members: without(members) });
    io.log(`${entry} can no longer sign in (existing sessions stay until they expire or are revoked with ${cliCommand("devices revoke ID")})`);
    return 0;
  }
  await write(options.chatOnly ? { admins: without(admins), members: [...without(members), entry] } : { admins: [...without(admins), entry], members: without(members) });
  io.log(`${entry} can sign in at /pair with an emailed code (${options.chatOnly ? "chat and approvals" : "full access"})`);
  if (overridden) io.log("note: OMB_SIGNIN_EMAILS / OMB_SIGNIN_MEMBER_EMAILS are set in the environment and win over this list while the server runs");
  return 0;
}

export async function runLogin(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion(), relayOnly: options.relay === true });
  if (fleetCredential()) io.log(`note: ${FLEET_CREDENTIAL_ENV} is set, so serve --tunnel will use that credential rather than this account`);
  if (account.credentials.status === "unavailable") {
    io.error(`${account.credentials.file} exists but could not be read; fix or remove it, then try again`);
    return 1;
  }
  if (!account.controlPlane) {
    io.error("OMB_CONTROL_PLANE_URL is set but is not an https address");
    return 1;
  }
  const existing = describeTunnelAccount(account.credentials.read());
  if (existing.address) io.log(`already signed in as ${existing.email ?? "?"} (${existing.address}); signing in again refreshes it`);
  const email = (options.email ?? (await io.ask("Email for your OpenMausBot account: "))).trim();
  if (!email) {
    io.error(`an email address is needed: ${cliCommand("login --email you@example.com")}`);
    return 1;
  }
  try {
    await account.service.requestCode(email);
  } catch (error) {
    io.error(`could not send a sign-in code: ${message(error)}`);
    return 1;
  }
  const code = (await io.ask(`Enter the 8-digit code we emailed to ${email}: `)).trim();
  let state;
  try {
    state = await account.service.verifyCode(email, code);
  } catch (error) {
    io.error(`sign-in failed: ${message(error)}`);
    return 1;
  }
  const signedIn = describeTunnelAccount(account.credentials.read());
  if (!signedIn.address && !(options.relay && signedIn.installationId)) {
    io.error(`signed in, but no public address was issued${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed in as ${signedIn.email ?? email}.`);
  io.log(signedIn.address ? `This machine's public address: ${signedIn.address}` : "No public address reserved: phones reach this machine through MausBot Relay.");
  io.log(`Serve there with:  ${cliCommand(signedIn.address ? "serve --tunnel" : "serve --relay")}`);
  return 0;
}

export async function runLogout(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
  const before = describeTunnelAccount(account.credentials.read());
  if (!before.email) {
    io.log("this machine is not signed in");
    return 0;
  }
  let state;
  try {
    state = await account.service.signOut();
  } catch (error) {
    io.error(`sign-out failed: ${message(error)}`);
    return 1;
  }
  const after = describeTunnelAccount(account.credentials.read());
  if (after.email) {
    io.error(`still signed in${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed out ${before.email}${before.address ? `; ${before.address} is released` : ""}.`);
  return 0;
}

export async function runBrowser(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const { browserEngineStatus, describeBrowserEngine, ensureChrome, installAgentBrowserBinary, resolveAgentBrowserBinary } = await import("./browser-engine.ts");
  const status = browserEngineStatus({ dataDir: options.dataDir });
  if (options.browserAction === "status") {
    io.log(describeBrowserEngine(status, status.kind === "ready" ? new (await import("./browser/chrome/launcher.ts")).ChromeLauncher({ dataDir: options.dataDir }).describe() : undefined));
    if (status.kind !== "ready" && status.installable) io.log("install it with:  openmausbot browser install");
    return status.kind === "ready" ? 0 : 1;
  }
  let binary = resolveAgentBrowserBinary({ dataDir: options.dataDir });
  if (binary) {
    io.log(`agent-browser is already here: ${binary}`);
  } else {
    if (status.kind !== "ready" && !status.installable) {
      io.error(status.reason);
      return 1;
    }
    try {
      binary = await installAgentBrowserBinary({ dataDir: options.dataDir, log: io.log });
    } catch (error) {
      io.error(`could not install agent-browser: ${message(error)}`);
      return 1;
    }
    io.log(`installed ${binary}`);
  }
  try {
    await ensureChrome(binary, { withDeps: options.withDeps === true, log: io.log });
  } catch (error) {
    io.error(`Chrome is not ready: ${message(error)}`);
    if (process.platform === "linux" && !options.withDeps) io.error(`on Linux, install Chrome's system libraries with: sudo ${cliCommand("browser install --with-deps")}, then retry ${cliCommand("browser install")} as the user running serve`);
    return 1;
  }
  io.log("browser installed for this user and data directory; run serve as the same user, then enable it under Settings → Computers and per bot");
  if (process.platform === "linux" && options.withDeps) io.log(`if serve runs as another user, run ${cliCommand("browser install")} from that user's login shell too`);
  return 0;
}

export function serverEntry(here = HERE): { command: string; args: string[]; staticDir: string | null; skillsDir: string | null } {
  const bundled = join(here, "index.js");
  const root = resolve(here, "..");
  if (existsSync(bundled)) {
    const staticDir = [join(root, "dist"), join(here, "..", "ui")].find((d) => existsSync(join(d, "index.html"))) ?? null;
    const skillsDir = existsSync(join(root, "skills")) ? join(root, "skills") : null;
    return { command: process.execPath, args: [bundled], staticDir, skillsDir };
  }
  const source = join(here, "index.ts");
  const staticDir = existsSync(join(root, "dist", "index.html")) ? join(root, "dist") : null;
  return { command: process.execPath, args: ["--experimental-strip-types", source], staticDir, skillsDir: existsSync(join(root, "skills")) ? join(root, "skills") : null };
}

interface TunnelPlan {
  access: ManagedTunnelAccess;
  binary: string;
  guardian: string;
  origin: CompanionOriginEndpoint;
  account: TunnelAccount | null;
}

/** Fails closed: never a silent fallback to a local-only server. */
async function planTunnel(options: CliOptions, log: (line: string) => void, recovery: TunnelRecovery): Promise<TunnelPlan | { error: string }> {
  let access: ManagedTunnelAccess | null = null;
  let account: TunnelAccount | null = null;
  const fail = (error: string) => {
    account?.service.dispose();
    return { error };
  };
  const credential = fleetCredential();
  if (credential) {
    log(`tunnel: using the installation credential from ${FLEET_CREDENTIAL_ENV}`);
    try {
      access = await fleetAccess({ credential, version: serverVersion() });
    } catch (error) {
      return { error: `--tunnel: ${message(error)}` };
    }
  } else {
    account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion(), recovery, log: (line) => log(`tunnel: ${line}`) });
    if (account.credentials.status === "unavailable") return fail(`${account.credentials.file} exists but could not be read; fix or remove it`);
    if (!describeTunnelAccount(account.credentials.read()).email) {
      return fail(`no account on this machine yet: run ${cliCommand("login")} first, then ${cliCommand("serve --tunnel")}`);
    }
    try {
      const state = await account.service.retry();
      const saved = tunnelAccess(account.credentials.read()) !== null;
      if (state.status === "signed-out") log(`tunnel: the sign-in on this machine expired; run ${cliCommand("login")} to renew it${saved ? " (serving the saved address until then)" : ""}`);
      else if (state.message) log(`tunnel: ${state.message}${saved ? " Serving the saved address for now." : ""}`);
    } catch (error) {
      log(`tunnel: control plane not reachable right now (${message(error)}); using the saved address`);
    }
    access = tunnelAccess(account.credentials.read());
    if (!access) return fail(`this machine has no public address; run ${cliCommand("login")} again`);
  }
  let binary: string;
  try {
    binary = await ensureCloudflared({ dataDir: options.dataDir, log });
  } catch (error) {
    return fail(`--tunnel: ${message(error)}`);
  }
  const guardian = guardianEntry();
  if (!guardian) return fail("--tunnel: the connector guardian is missing from this install");
  return { access, binary, guardian, origin: createTunnelOrigin(), account };
}

export async function runServe(options: CliOptions, log: (line: string) => void = console.log): Promise<number> {
  const { browserEngineStatus, describeBrowserEngine } = await import("./browser-engine.ts");
  if (await serverUp(options.port)) {
    console.error(`something already answers on http://127.0.0.1:${options.port}; use ${cliCommand("pair")} against it, or --port for a second server`);
    return 1;
  }
  let publicUrl = options.publicUrl ?? (options.local ? undefined : envPublicUrl(process.env, log));
  let tailscale: TailscaleStatus | null = null;
  if (await clearLeftoverTailscaleServe(options.dataDir) && !options.tailscale) log(`Turned off a Tailscale share an earlier run left on. Add --tailscale to share again.`);
  if (options.tailscale) {
    const probe = await tailscaleStatus();
    if ("failure" in probe) {
      console.error(`--tailscale: ${explainTailscaleFailure(probe.failure)}`);
      return 1;
    }
    tailscale = probe.status;
  }
  let plan: TunnelPlan | null = null;
  const serving: { tunnel: RunningTunnel | null } = { tunnel: null };
  if (options.tunnel) {
    const planned = await planTunnel(options, log, { running: () => serving.tunnel });
    if ("error" in planned) {
      console.error(planned.error);
      return 1;
    }
    plan = planned;
    if (publicUrl && publicUrl !== plan.access.endpoint) log(`note: --public-url is ignored with --tunnel; the address is ${plan.access.endpoint}`);
    publicUrl = plan.access.endpoint;
  }
  let caddyBinary: string | null = null;
  if (options.domain) {
    try {
      caddyBinary = await ensureCaddy({ dataDir: options.dataDir, log });
    } catch (error) {
      console.error(`--domain: ${message(error)}`);
      return 1;
    }
    publicUrl = `https://${options.domain}`;
  }
  const entry = serverEntry();
  if (!entry.staticDir) log("note: no built UI found next to the server; the API runs but browsers get no page (build with `pnpm exec vite build`)");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMB_DATA_DIR: options.dataDir,
    OMB_PORT: String(options.port),
    OMB_WEBHOOK_PORT: process.env.OMB_WEBHOOK_PORT || String(options.port + 1), ...(options.relay ? { OMB_PHONE_RELAY: "1" } : {}),
  };
  if (options.local) delete env.OMB_PUBLIC_URL;
  // The per-launch secret goes over stdin, not the environment that every engine the server starts inherits.
  const serviceTrust = resolveLoopbackTrust({ env, desktopManaged: false, hostedWorkspace: hostedWorkspaceConfigured(env) }).trust === "service";
  const ownerToken = serviceTrust ? randomBytes(32).toString("base64url") : undefined;
  if (ownerToken) env.OMB_CLI_OWNER_STDIN = "1";
  else delete env.OMB_CLI_OWNER_STDIN;
  if (entry.staticDir) env.OMB_STATIC_DIR = entry.staticDir;
  if (entry.skillsDir && !process.env.OMB_SKILLS_DIR) env.OMB_SKILLS_DIR = entry.skillsDir;
  if (options.label && !process.env.OMB_ENVIRONMENT_LABEL) env.OMB_ENVIRONMENT_LABEL = options.label;
  if (plan) Object.assign(env, { OMB_TUNNEL_SOCKET: plan.origin.socketPath, OMB_SERVES_TUNNEL: "1" });
  const lanRefusal = options.lan ? lanProblem() : null;
  if (lanRefusal) log(lanRefusal);
  if (options.lan && !lanRefusal) env.OMB_LAN = "1";
  else delete env.OMB_LAN;
  let logPath: string | undefined;
  let logFd: number | undefined;
  let tailscaleShare: { origin: string; stop(): Promise<void> } | null = null;
  let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; };
  process.on("SIGINT", cancelStartup);
  process.on("SIGTERM", cancelStartup);
  let child: ChildProcess;
  try {
    if (options.guided) {
      const logsDir = join(options.dataDir, "logs");
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      logPath = join(logsDir, `server-${Date.now()}-${process.pid}.log`);
      logFd = openSync(logPath, "wx", 0o600);
      log("\nStarting your workspace…");
    }
    if (tailscale) {
      const served = await tailscaleServe(tailscale, options.port, { dataDir: options.dataDir, otherServer: answersAsMausBot });
      const listening = "failure" in served ? tailnetListenFallback(served.failure, tailscale, options.port) : null;
      tailscaleShare = "failure" in served ? listening && { origin: listening.origin, stop: async () => {} } : served;
      if (startupCancelled || !tailscaleShare) throw startupCancelled ? new SetupCancelled() : new Error(`--tailscale: ${explainTailscaleFailure("failure" in served ? served.failure : "unknown")}`);
      Object.assign(env, listening?.env); publicUrl = tailscaleShare.origin;
      log(listening?.line ?? `tailscale: serving https://${tailscale.dnsName} → http://127.0.0.1:${options.port} (only your tailnet can reach it)`);
    }
    if (startupCancelled) throw new SetupCancelled();
    if (publicUrl) env.OMB_PUBLIC_URL = publicUrl;
    child = spawn(entry.command, entry.args, { env, stdio: [ownerToken ? "pipe" : "ignore", logFd ?? "inherit", logFd ?? "inherit"] });
    if (ownerToken) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${ownerToken}\n`);
      serveOwnerToken = ownerToken;
    }
  } catch (error) {
    await tailscaleShare?.stop().catch(() => undefined);
    plan?.account?.service.dispose();
    if (plan) cleanupTunnelOrigin(plan.origin);
    if (error instanceof SetupCancelled) {
      log("Startup cancelled. No server was started; your saved work is unchanged.");
      return 130;
    }
    throw error;
  } finally {
    if (logFd !== undefined) closeSync(logFd);
    process.removeListener("SIGINT", cancelStartup);
    process.removeListener("SIGTERM", cancelStartup);
  }
  let exited: number | null = null;
  const childExit = new Promise<number>((done) => {
    child.once("error", () => { exited = 1; done(1); });
    child.once("exit", (code, signal) => { exited = code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1); done(exited); });
  });
  let tunnel: RunningTunnel | null = null;
  let caddy: RunningCaddy | null = null;
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      serving.tunnel = null;
      plan?.account?.service.dispose();
      // The gateway and the edge stop accepting before the server they forward to goes away.
      if (tunnel) await tunnel.stop().catch(() => undefined);
      if (caddy) await caddy.stop().catch(() => undefined);
      await tailscaleShare?.stop().catch(() => undefined);
      if (exited === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        timer.unref();
        await childExit;
        clearTimeout(timer);
      }
      if (plan) cleanupTunnelOrigin(plan.origin);
    })();
    return stopping;
  };
  const onSignal = () => { void stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && exited === null && !stopping) {
      if (await serverUp(options.port, child.pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (exited !== null) {
      if (exited !== 0) log(`OpenMausBot could not start.${logPath ? ` Details: ${logPath}` : " See the output above."}`);
      return exited;
    }
    if (stopping) return await childExit;
    if (!(await serverUp(options.port, child.pid))) {
      console.error(`OpenMausBot did not become ready within a minute.${logPath ? ` Details: ${logPath}` : " See its output above."}`);
      await stop();
      return 1;
    }
    if (stopping || exited !== null) return await childExit;
    if (options.domain && caddyBinary) {
      try {
        caddy = await startCaddy({ binary: caddyBinary, dataDir: options.dataDir, domain: options.domain, appPort: options.port, webhookPort: Number(env.OMB_WEBHOOK_PORT), log });
        log(`https: Caddy serves ${publicUrl} → http://127.0.0.1:${options.port}; it gets the certificate from Let's Encrypt once DNS for ${options.domain} points at this machine`);
        void caddy.exited.then((code) => {
          if (!stopping) log(`caddy: stopped (exit ${code ?? "signal"}); ${publicUrl} is no longer served. Stop and start the server again.`);
        });
      } catch (error) {
        console.error(`--domain: ${message(error)}`);
        await stop();
        return 1;
      }
    }
    if (plan && child.pid) {
      tunnel = startTunnel({
        dataDir: options.dataDir,
        access: plan.access,
        originTarget: { pid: child.pid, socketPath: plan.origin.socketPath },
        binaryPath: plan.binary,
        guardian: plan.guardian,
        onState: (state) => log(describeTunnelState(state, plan.access.endpoint)),
      });
      tunnel.started.catch((error: unknown) => log(`tunnel: ${message(error)}`));
      serving.tunnel = tunnel;
      void plan.account?.service.restore().catch(() => undefined);
    }
    const prefix = cliPrefix();
    const described = await api(options.port, "/.well-known/openmausbot/environment").catch(() => null);
    const route: Route | null = plan ? "tunnel" : options.domain ? "domain" : tailscaleShare ? "tailscale" : publicUrl ? "public-url" : env.OMB_LAN === "1" ? "lan" : null;
    const origin = route === "lan" ? lanUrl(options.port, env) : publicUrl ?? null;
    log("");
    log(`MausBot ${serverVersion()} · server "${described?.body?.label ?? options.label ?? "this machine"}"`);
    if (options.guided) {
      log("Your bots and conversations are saved automatically.");
      log(`Details if you need help: ${logPath}`);
      if (options.open !== false && !await openDashboard(options.port)) log(`Open http://127.0.0.1:${options.port} in a browser on this computer.`);
    } else {
      log(`data: ${options.dataDir}`);
      log(describeBrowserEngine(browserEngineStatus({ dataDir: options.dataDir })));
    }
    const reach = route && origin && route !== "lan" ? await waitForReach(options.port, origin, route === "public-url" ? 3_000 : 15_000) : undefined;
    if (route && origin) for (const line of reachLines(route, origin, options.port, prefix, reach)) log(line);
    const interactive = process.stdout.isTTY === true;
    if (options.pair && (options.phone || options.relay)) {
      log("");
      if (!stopping && exited === null) await showPhonePairing(options, publicUrl, log).catch((error: unknown) => log(`no pairing code: ${message(error)}`));
    } else if (options.pair && (options.guided || ((route || serviceTrust) && interactive))) {
      log("");
      try {
        log(await mintPairing(options.port, { label: options.label ? `${options.label} owner` : undefined, client: options.client, publicUrl: origin ?? undefined, guided: options.guided && !route }));
        if (reach && !reach.ok) log("The code works once the address answers.");
      } catch (error) {
        log(`no pairing code: ${message(error)}`);
      }
    } else if (!route) {
      log("");
      for (const line of noRouteLines(options.port, prefix)) log(line);
    } else if (!serviceTrust) {
      log(`Get a pairing code: ${prefix} pair`);
    }
    if (serviceTrust && !(options.pair && interactive)) log(`This shared server takes no pairing commands from this machine. Let people sign in with their email: ${prefix} access add you@example.com`);
    if (interactive && !options.guided) log(`New code later   ${prefix} pair\nStop with Ctrl+C`);
    if (options.guided) log(`\nKeep this terminal open while using your bots. Ctrl+C stops the server, not your saved work.\nNext time: ${prefix} · Change AI or phone setup: ${prefix} setup · Pair another device: ${prefix} pair`);
    return await childExit;
  } finally {
    serveOwnerToken = undefined;
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/** A server exiting with RESTART_EXIT_CODE is started again here at the same address, without a second pairing code. */
export async function serveUntilStopped(options: CliOptions, run: (options: CliOptions) => Promise<number> = runServe, now: () => number = Date.now): Promise<number> {
  const policy = restartPolicy(now);
  let launch = options;
  for (;;) {
    const code = await run(launch);
    if (!policy.again(code)) return code;
    console.log("\nOpenMausBot is starting again to finish installing a copy from the desktop app…");
    launch = { ...options, pair: false, open: false };
  }
}

/** Setup imports stay behind the data-dir override: config binds its paths when first imported. */
export async function runOnboardingCommand(
  options: CliOptions,
  io: CliIo = defaultIo(),
  startServer: (options: CliOptions) => Promise<number> = serveUntilStopped,
  flow: { prompts?: SetupIo; phoneSetup?: typeof runPhoneSetup; running?: typeof isWorkspaceRunning; open?: typeof openDashboard } = {},
): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (options.command === "setup" && !interactive) {
    io.error(`Setup needs an interactive terminal. Run ${cliCommand("setup")} in a terminal, or start unattended with ${cliCommand("serve")}.`);
    return 1;
  }
  process.env.OMB_DATA_DIR = options.dataDir;
  if (options.command !== "setup" && await (flow.running ?? isWorkspaceRunning)(options)) {
    if (options.local || options.tunnel || options.tailscale || options.publicUrl) {
      io.error("This workspace is already running. Stop it before changing local or remote access; the current connection was not changed.");
      return 1;
    }
    io.log(`Your workspace is already running: http://127.0.0.1:${options.port}`);
    io.log("No second server was started. Your existing bots and conversations are unchanged.");
    if (interactive && options.open !== false) await (flow.open ?? openDashboard)(options.port);
    return 0;
  }
  const { runSetup, isSetupComplete, readCliStartup, saveCliStartup } = await import("./cli-setup.ts");
  const prompts = flow.prompts ?? defaultSetupIo();
  try {
    if (options.command === "setup" || !(await isSetupComplete(options.dataDir))) {
      if (!interactive) {
        io.error(`No setup yet. Run ${cliCommand("setup")} in an interactive terminal first, or start unattended with ${cliCommand("serve")}.`);
        return 1;
      }
      if (!(await runSetup({ dataDir: options.dataDir, port: options.port }))) {
        io.log(`Setup cancelled. Run ${cliPrefix()} when you're ready.`);
        return 130;
      }
    }
    const saved = readCliStartup(options.dataDir);
    // Only setup revisits the access choice; normal starts reuse consent and never turn a local session public.
    let launch = options.command === "setup" ? options : applyStartupPreferences(options, saved);
    if (interactive && options.pair && !options.local && (options.command === "setup" || !saved)) {
      io.log("\nOne optional step: connect your phone. You can skip this and start chatting here.");
      const result = await (flow.phoneSetup ?? runPhoneSetup)(launch, prompts, {
        accountReady: (value) => !!describeTunnelAccount(createTunnelAccount({ dataDir: value.dataDir, version: serverVersion() }).credentials.read()).email,
        login: (value, ui) => runLogin(value, {
          log: ui.log, error: ui.log,
          ask: (question) => /code/i.test(question) ? ui.secret(question) : ui.ask(question),
        }),
      });
      launch = { ...result.options, phone: result.phone };
      saveCliStartup(options.dataDir, startupPreferences(launch));
    }
    if (options.command === "setup") {
      io.log(`\nAll set. Start with: ${cliPrefix()}`);
      if (options.dataDir !== join(homedir(), ".openmausbot") || options.port !== 8799) {
        io.log(`Use the same --data-dir (${options.dataDir}) and --port (${options.port}) options when starting.`);
      }
      return 0;
    }
    if (saved) io.log("\nWelcome back. Using your saved AI connection.");
    return startServer({ ...launch, guided: interactive });
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log(`\nSetup stopped. Any AI setup already saved is kept; no server was started. Run ${cliCommand("setup")} to continue.`);
    return 130;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "sentinel") return runSentinelCli(argv.slice(1));
  if (HEADLESS_VERB_NAMES.has(argv[0] ?? "") || (argv[0] === "help" && HEADLESS_VERB_NAMES.has(argv[1] ?? ""))) return (await import("./headless/main.ts")).runHeadless(argv);
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`${options.error}\nAll commands and options: ${cliCommand("--help")}`);
    return 2;
  }
  process.env.OMB_DATA_DIR = options.dataDir;
  switch (options.command) {
    case "setup":
    case "start":
      return runOnboardingCommand(options);
    case "serve":
      return serveUntilStopped(options);
    case "pair":
      return runPair(options);
    case "sessions":
      return runSessions(options);
    case "status":
      return runStatus(options);
    case "login":
      return runLogin(options);
    case "access":
      return runAccess(options);
    case "service":
      return runServiceCommand({
        action: options.serviceAction ?? "install", dataDir: options.dataDir, port: options.port, domain: options.domain, tunnel: options.tunnel,
        tailscale: options.tailscale, publicUrl: options.publicUrl, lan: options.lan, relay: options.relay, label: options.label, sentinel: options.sentinel, script: process.argv[1] ?? "", node: process.execPath,
      }, { log: (line) => console.log(line), error: (line) => console.error(line) });
    case "fleet":
      if (options.fleetAction === "agent") {
        const layout = fleetLayout();
        await startFleetAgent({
          socketPath: options.socket ?? layout.socketPath,
          group: options.group,
          node: process.execPath,
          script: process.argv[1] ?? "",
          licenseKey: options.licenseKey ?? process.env.OMB_LICENSE_KEY,
        }, { log: (line) => console.log(line) });
        await new Promise<void>((resolveStop) => {
          for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolveStop());
        });
        return 0;
      }
      return runFleetCommand({
        action: options.fleetAction as FleetInput["action"],
        slug: options.slug,
        domain: options.domain,
        operator: options.operator ?? process.env.SUDO_USER,
        admins: options.admins ?? [],
        members: options.members ?? [],
        brandFile: options.brandFile,
        anthropicKeyFile: options.anthropicKeyFile,
        cap: options.cap,
        licenseKey: options.licenseKey ?? process.env.OMB_LICENSE_KEY,
        memory: options.memory,
        dryRun: options.dryRun ?? false,
        yes: options.yes ?? false,
        keepData: options.keepData ?? false,
        userAction: options.fleetUserAction,
        email: options.email,
        chatOnly: options.chatOnly,
        node: process.execPath,
        script: process.argv[1] ?? "",
      }, { log: (line) => console.log(line), error: (line) => console.error(line) });
    case "logout":
      return runLogout(options);
    case "version":
      console.log(serverVersion());
      return 0;
    case "browser":
      return runBrowser(options);
    default:
      console.log(usage(cliPrefix()));
      return 0;
  }
}
