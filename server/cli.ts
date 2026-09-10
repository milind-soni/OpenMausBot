// `openmausbot` on the command line: run the server anywhere and pair devices
// to it. One implementation for three homes — `npx openmausbot` (the npm
// package), `node dist-server/cli.js` (the container image) and
// `pnpm omb` (a checkout) — because scripts/bundle-server.mjs bundles this
// file next to the server.
//
//   openmausbot setup [--data-dir ~/.openmausbot]
//   openmausbot start [serve options]
//   openmausbot serve [--port 8799] [--data-dir ~/.openmausbot] [--label "cab mini"]
//                     [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
//   openmausbot pair  [--label "My MacBook"] [--client] [--public-url https://host]
//   openmausbot sessions [revoke <id>]
//   openmausbot status
//   openmausbot login [--email you@example.com]
//   openmausbot logout
//
// `serve` starts the server, waits for it, and prints a pairing link with a
// QR code: scan it with the phone or open it on a laptop. `--tailscale` asks
// Tailscale to terminate HTTPS for it and uses the MagicDNS name in the link.
// `--tunnel` (after `login`) serves at a public https://….openmausbot.com
// address through a Cloudflare tunnel: no domain, no proxy, no open port.
//
// This module only exports; openmausbot.ts is the entry that runs main(), so
// bundling this file into other entries (pair-cli.ts) never runs it twice.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";

import { parseAllowList } from "./account-signin.ts";
import { writeFileAtomic } from "./atomic.ts";
import { ensureCaddy, normalizeDomainOption, startCaddy, type RunningCaddy } from "./caddy.ts";
import { runServiceCommand } from "./service-cli.ts";
import { explainTailscaleFailure, tailscaleServe, tailscaleServeOff, tailscaleStatus, type TailscaleStatus } from "./tailscale.ts";
import { defaultSetupIo, SetupCancelled, type SetupIo } from "./cli-prompts.ts";
import { normalizePhoneOrigin, phonePairingInstructions, runPhoneSetup } from "./cli-phone-setup.ts";
import type { AppConfig } from "./config.ts";
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
} from "./tunnel.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
  command: "setup" | "start" | "serve" | "pair" | "sessions" | "status" | "login" | "logout" | "access" | "service" | "browser" | "help";
  port: number;
  dataDir: string;
  label?: string;
  publicUrl?: string;
  /** `serve --domain host`: HTTPS on your own domain through a managed Caddy. */
  domain?: string;
  tailscale: boolean;
  tunnel: boolean;
  client: boolean;
  pair: boolean;
  revoke?: string;
  /** `access list|add|remove` */
  accessAction?: "list" | "add" | "remove";
  chatOnly?: boolean;
  /** `service install|uninstall` */
  serviceAction?: "install" | "uninstall";
  email?: string;
  /** `browser install [--with-deps]` */
  browserAction?: "install" | "status";
  withDeps?: boolean;
  json: boolean;
  /** Explicitly ignore saved remote access for this launch. */
  local?: boolean;
  open?: boolean;
  /** Internal guided-start presentation; serve remains script-friendly. */
  guided?: boolean;
  phone?: "ios" | "android";
}

const COMMANDS = ["setup", "start", "serve", "pair", "sessions", "status", "login", "logout", "access", "service", "browser", "help", "--help", "-h"];

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | { error: string } {
  const implicitStart = !argv.length || (argv[0]!.startsWith("--") && argv[0] !== "--help");
  const [command = "start", ...rest] = implicitStart ? ["start", ...argv] : argv;
  if (!COMMANDS.includes(command)) {
    return { error: `unknown command "${command}"` };
  }
  const options: CliOptions = {
    command: command === "--help" || command === "-h" ? "help" : (command as CliOptions["command"]),
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
      else if (arg === "--domain") {
        const domain = normalizeDomainOption(value());
        if (typeof domain !== "string") return domain;
        options.domain = domain;
      }
      else if (arg === "--tunnel") options.tunnel = true;
      else if (arg === "--client") options.client = true;
      else if (arg === "--no-pair") options.pair = false;
      else if (arg === "--no-open") options.open = false;
      else if (arg === "--local") options.local = true;
      else if (arg === "--json") options.json = true;
      else if (arg === "--email") options.email = value();
      else if (options.command === "sessions" && arg === "revoke") options.revoke = value();
      else if (options.command === "access" && !options.accessAction && (arg === "list" || arg === "add" || arg === "remove")) {
        options.accessAction = arg;
        if (arg !== "list") options.email = value();
      } else if (options.command === "access" && arg === "--chat-only") options.chatOnly = true;
      else if (options.command === "service" && !options.serviceAction && (arg === "install" || arg === "uninstall")) options.serviceAction = arg;
      else if (options.command === "browser" && (arg === "install" || arg === "status")) options.browserAction = arg;
      else if (options.command === "browser" && arg === "--with-deps") options.withDeps = true;
      else return { error: `unknown argument "${arg}"` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return { error: "--port must be 1-65535" };
  if (options.publicUrl && !/^https?:\/\//.test(options.publicUrl)) return { error: "--public-url must start with http:// or https://" };
  if (options.tailscale && options.tunnel) return { error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" };
  if (options.command === "access" && !options.accessAction) return { error: "access needs one of: list, add EMAIL [--chat-only], remove EMAIL" };
  if (options.command === "service" && !options.serviceAction) return { error: "service needs one of: install [the same options as serve], uninstall" };
  if (options.domain && (options.tailscale || options.tunnel || options.publicUrl)) return { error: "--domain already gives the server its address; drop --tailscale, --tunnel and --public-url" };
  if (options.local && (options.tailscale || options.tunnel || options.publicUrl)) return { error: "--local cannot be combined with a remote-access option" };
  if (options.command === "browser" && !options.browserAction) return { error: "browser needs an action: install or status" };
  return options;
}

export const USAGE = `openmausbot — your team of AI bots, ready in a few steps

  openmausbot                         set up once, then open your workspace
  openmausbot setup [--data-dir DIR]
  openmausbot start [the same options as serve]
  openmausbot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
  openmausbot pair  [--label NAME] [--client] [--public-url https://host]
  openmausbot sessions [revoke ID]
  openmausbot status
  openmausbot login [--email you@example.com]
  openmausbot logout
  openmausbot access list | add EMAIL [--chat-only] | remove EMAIL
  openmausbot service install [--domain HOST | --tunnel | --tailscale] [--port N] [--data-dir DIR] | uninstall
  openmausbot browser install [--with-deps] | status

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as openmausbot: use your saved settings and open the workspace
serve   starts the server without prompts and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only)
sessions lists paired devices; "sessions revoke ID" signs one out
status  what the server says about itself
login   signs this machine in to an OpenMausBot account (an emailed code)
        and reserves its public address for --tunnel
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Install the package
        permanently first (npm install -g openmausbot).
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache.
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.

--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--tunnel     serve at a public https://….openmausbot.com address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`openmausbot login\` once on this machine first.
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--no-open   do not open a browser window
--no-pair   skip phone setup and do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

Install once with \`npm install -g openmausbot\`, then type \`openmausbot\`.
Or run without a global install: \`npx openmausbot\`. Node 24+ is required.
`;

/** Terminal in, terminal out; tests substitute all three. */
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

/** The version this command ships with: package.json is one level up in the
 * npm package (dist-server/), the image and a checkout (server/). */
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

// ── talking to a running server (loopback = owner) ────────────────────
async function api(port: number, path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method, body: init.body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000) });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function serverUp(port: number, pid?: number): Promise<boolean> {
  try {
    const { status, body } = await api(port, "/api/health");
    return status === 200 && body?.app === "openmausbot" && (pid === undefined || body.pid === pid);
  } catch {
    return false;
  }
}

/** Check identity before reusing a running process. Never attach to another
 * workspace just because it happens to be listening on the requested port. */
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

/** A valid URL alone is not enough: its public descriptor must identify this
 * exact server. This probe never sends a pairing code or an auth credential. */
export async function verifyPhoneEndpoint(port: number, origin: string): Promise<boolean> {
  if (!normalizePhoneOrigin(origin)) return false;
  try {
    const local = await api(port, "/.well-known/openmausbot/environment");
    const remote = await fetch(`${origin}/.well-known/openmausbot/environment`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (local.status !== 200 || !remote.ok) return false;
    const descriptor = await remote.json() as { environmentId?: unknown };
    return typeof local.body?.environmentId === "string" && local.body.environmentId.length > 0
      && descriptor.environmentId === local.body.environmentId;
  } catch { return false; }
}

export function applyStartupPreferences(options: CliOptions, saved: AppConfig["cliStartup"]): CliOptions {
  if (options.local) return { ...options, tunnel: false, tailscale: false, publicUrl: undefined, phone: undefined };
  if (!saved || options.tunnel || options.tailscale || options.publicUrl) return options;
  if (saved.access === "public-url" && (!saved.publicUrl || !normalizePhoneOrigin(saved.publicUrl))) {
    throw new Error("The saved phone address is not a valid HTTPS origin. Run openmausbot setup to correct it, or openmausbot --local to start only on this computer.");
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
  const ready = !!origin && await verifyPhoneEndpoint(options.port, origin);
  if (!ready) {
    log("Phone access is not reachable yet. Your local workspace is ready; no phone pairing code was created.");
    log("Check the HTTPS connection, then run openmausbot pair again with the same --data-dir and --port.");
    return false;
  }
  for (const line of phonePairingInstructions(options.phone ?? "ios", { origin: origin!, ready })) log(line);
  log(await mintPairing(options.port, { client: true, label: options.label ?? (options.phone === "android" ? "Android" : "iPhone / iPad"), publicUrl: origin }));
  log("Waiting for you to connect on the phone. Keep this terminal and the code private.");
  return true;
}

/** The pairing link a device opens, rendered as text and a QR code. */
export function pairingBlock(input: { code: string; url: string | null; expiresAt: number; hint?: string | null }): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (input.url) {
    lines.push(`open or scan:  ${input.url}`);
    lines.push("");
    lines.push(qrToString(input.url));
  } else {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
  }
  return lines.join("\n");
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}

async function mintPairing(port: number, options: { label?: string; client?: boolean; publicUrl?: string }): Promise<string> {
  const request: { label?: string; scopes?: string[] } = {};
  if (options.label) request.label = options.label;
  if (options.client) request.scopes = ["client"];
  const { status, body } = await api(port, "/api/auth/pairing", { method: "POST", body: JSON.stringify(request) });
  if (status !== 200) throw new Error(`server refused to mint a pairing code: ${typeof body?.error === "string" ? body.error : status}`);
  const url = options.publicUrl ? `${options.publicUrl}/pair#code=${body.code}` : typeof body.url === "string" ? body.url : null;
  return pairingBlock({ code: body.code, url, expiresAt: body.expiresAt, hint: typeof body.hint === "string" ? body.hint : null });
}

// ── commands ───────────────────────────────────────────────────────────
export async function runPair(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`no OpenMausBot server on http://127.0.0.1:${options.port}; start one with \`openmausbot serve\` or set OMB_PORT`);
    return 1;
  }
  if (process.stdin.isTTY && process.stdout.isTTY && !options.label && !options.client) {
    const advertised = await api(options.port, "/api/auth/pairing");
    let launch = options;
    // The running server may use a one-time route override. Saved preferences
    // describe the next launch, not necessarily the address working now.
    let origin = options.publicUrl ?? (typeof advertised.body?.publicUrl === "string" ? advertised.body.publicUrl : undefined);
    if (!origin) {
      const { readCliStartup } = await import("./cli-setup.ts");
      launch = applyStartupPreferences(options, readCliStartup(options.dataDir));
      origin = launch.publicUrl;
      if (launch.tunnel) origin = describeTunnelAccount(createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() }).credentials.read()).address ?? undefined;
      if (launch.tailscale) {
        const status = await tailscaleStatus();
        if (!("failure" in status) && status.status.dnsName) origin = `https://${status.status.dnsName}`;
      }
    }
    if (!origin || !normalizePhoneOrigin(origin)) {
      console.log("Your workspace is running only on this computer. A phone cannot use its localhost address.");
      console.log("Stop the server, run openmausbot setup and choose phone access, then start openmausbot again.");
      return 1;
    }
    const ui = defaultSetupIo();
    try {
      const selected = await ui.choose("Which phone are you connecting?", ["iPhone / iPad — app or Safari", "Android — web browser", "Cancel"], 0);
      if (selected === 2) return 0;
      launch = { ...launch, phone: selected === 0 ? "ios" : "android" };
      return await showPhonePairing(launch, origin, ui.log) ? 0 : 1;
    } catch (error) {
      if (!(error instanceof SetupCancelled)) throw error;
      console.log("Pairing cancelled. Existing devices are unchanged.");
      return 130;
    }
  }
  console.log(await mintPairing(options.port, { label: options.label, client: options.client, publicUrl: options.publicUrl }));
  if (options.client) console.log("(client scope: chat and approvals only; cannot change settings or pair others)");
  return 0;
}

export async function runSessions(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) {
    console.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    return 1;
  }
  if (options.revoke) {
    const { status, body } = await api(options.port, `/api/auth/sessions/${encodeURIComponent(options.revoke)}`, { method: "DELETE" });
    if (status !== 200) {
      console.error(`could not revoke: ${typeof body?.error === "string" ? body.error : status}`);
      return 1;
    }
    console.log(`revoked ${options.revoke}: that device is signed out and its stream is closed`);
    return 0;
  }
  const { body } = await api(options.port, "/api/auth/sessions");
  const sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }> = Array.isArray(body?.sessions) ? body.sessions : [];
  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }
  if (!sessions.length) {
    console.log("no paired devices yet: run `openmausbot pair`");
    return 0;
  }
  console.log(formatSessions(sessions));
  return 0;
}

export function formatSessions(sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }>, now = Date.now()): string {
  const age = (ms: number) => {
    const m = Math.max(0, Math.floor((now - ms) / 60_000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const rows = sessions.map((s) => [s.id, s.label || "(unnamed)", s.scopes.includes("admin") ? "admin" : "client", age(s.lastSeenAt), new Date(s.expiresAt).toISOString().slice(0, 10)]);
  const head = ["id", "device", "scope", "last seen", "expires"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(head), ...rows.map(line), "", "revoke one with: openmausbot sessions revoke <id>"].join("\n");
}

export async function runStatus(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  let code = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${options.port}/.well-known/openmausbot/environment`);
    const body: any = await res.json();
    io.log(options.json ? JSON.stringify(body, null, 2) : `${body.label} · OpenMausBot ${body.version} on ${body.platform} · id ${body.environmentId}`);
  } catch {
    io.error(`no OpenMausBot server on http://127.0.0.1:${options.port}`);
    code = 1;
  }
  if (!options.json) {
    const account = describeTunnelAccount(createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() }).credentials.read());
    if (fleetCredential()) io.log(`public address: managed by the fleet (${FLEET_CREDENTIAL_ENV} is set; the address is fetched when serve --tunnel starts)`);
    else if (account.address) io.log(`public address: ${account.address} (signed in as ${account.email ?? "?"}; serve it with --tunnel)`);
  }
  return code;
}

/** The sign-in allow-list, edited straight in config.json: the server reads
 * it per request, so this works with the server running or stopped and
 * needs no restart. Environment variables (OMB_SIGNIN_EMAILS) win when set.
 * Written the way the server writes it (atomic, 0600), touching only the
 * one key, so nothing else in the file moves. */
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
  const overridden = process.env.OMB_SIGNIN_EMAILS !== undefined || process.env.OMB_SIGNIN_MEMBER_EMAILS !== undefined;
  const write = (next: { admins: string[]; members: string[] }) => {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ ...raw, signIn: next }, null, 2)}\n`, { mode: 0o600 });
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
    write({ admins: without(admins), members: without(members) });
    io.log(`${entry} can no longer sign in (existing sessions stay until they expire or are revoked with \`openmausbot sessions revoke\`)`);
    return 0;
  }
  write(options.chatOnly ? { admins: without(admins), members: [...without(members), entry] } : { admins: [...without(admins), entry], members: without(members) });
  io.log(`${entry} can sign in at /pair with an emailed code (${options.chatOnly ? "chat and approvals" : "full access"})`);
  if (overridden) io.log("note: OMB_SIGNIN_EMAILS / OMB_SIGNIN_MEMBER_EMAILS are set in the environment and win over this list while the server runs");
  return 0;
}

export async function runLogin(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
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
    io.error("an email address is needed: openmausbot login --email you@example.com");
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
  if (!signedIn.address) {
    io.error(`signed in, but no public address was issued${state.message ? `: ${state.message}` : ""}`);
    return 1;
  }
  io.log(`Signed in as ${signedIn.email ?? email}.`);
  io.log(`This machine's public address: ${signedIn.address}`);
  io.log("Serve there with:  openmausbot serve --tunnel");
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
    io.log(describeBrowserEngine(status));
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
    if (process.platform === "linux" && !options.withDeps) io.error("on Linux, install Chrome's system libraries with `sudo openmausbot browser install --with-deps`, then retry `openmausbot browser install` as the user running serve");
    return 1;
  }
  io.log("browser installed for this user and data directory; run serve as the same user, then enable it under Settings → Experimental and per bot");
  if (process.platform === "linux" && options.withDeps) io.log("if serve runs as another user, run `openmausbot browser install` from that user's login shell too");
  return 0;
}

/** Where the server bundle lives relative to this file: next to it in the
 * npm package and the image (dist-server/), or the TypeScript source in a
 * checkout. */
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
}

/** Everything `--tunnel` needs before the server starts, or the one reason
 * it cannot have it. Fails closed: no silent fallback to a local-only server. */
async function planTunnel(options: CliOptions, log: (line: string) => void): Promise<TunnelPlan | { error: string }> {
  let access: ManagedTunnelAccess | null = null;
  const credential = fleetCredential();
  if (credential) {
    // A fleet-started container: the credential is the whole identity.
    log(`tunnel: using the installation credential from ${FLEET_CREDENTIAL_ENV}`);
    try {
      access = await fleetAccess({ credential });
    } catch (error) {
      return { error: `--tunnel: ${message(error)}` };
    }
  } else {
    const account = createTunnelAccount({ dataDir: options.dataDir, version: serverVersion() });
    if (account.credentials.status === "unavailable") return { error: `${account.credentials.file} exists but could not be read; fix or remove it` };
    if (!describeTunnelAccount(account.credentials.read()).email) {
      return { error: "no account on this machine yet: run `openmausbot login` first, then `openmausbot serve --tunnel`" };
    }
    // A fresh connector token when the control plane answers; the saved one otherwise.
    try {
      const state = await account.service.retry();
      if (state.message && !tunnelAccess(account.credentials.read())) log(`tunnel: ${state.message}`);
    } catch (error) {
      log(`tunnel: control plane not reachable right now (${message(error)}); using the saved address`);
    }
    access = tunnelAccess(account.credentials.read());
    if (!access) return { error: "this machine has no public address; run `openmausbot login` again" };
  }
  let binary: string;
  try {
    binary = await ensureCloudflared({ dataDir: options.dataDir, log });
  } catch (error) {
    return { error: `--tunnel: ${message(error)}` };
  }
  const guardian = guardianEntry();
  if (!guardian) return { error: "--tunnel: the connector guardian is missing from this install" };
  return { access, binary, guardian, origin: createTunnelOrigin() };
}

export async function runServe(options: CliOptions, log: (line: string) => void = console.log): Promise<number> {
  const { browserEngineStatus, describeBrowserEngine } = await import("./browser-engine.ts");
  if (await serverUp(options.port)) {
    console.error(`something already answers on http://127.0.0.1:${options.port}; use \`openmausbot pair\` against it, or --port for a second server`);
    return 1;
  }
  let publicUrl = options.publicUrl;
  let tailscale: TailscaleStatus | null = null;
  if (options.tailscale) {
    const probe = await tailscaleStatus();
    if ("failure" in probe) {
      console.error(`--tailscale: ${explainTailscaleFailure(probe.failure)}`);
      return 1;
    }
    tailscale = probe.status;
  }
  let plan: TunnelPlan | null = null;
  if (options.tunnel) {
    const planned = await planTunnel(options, log);
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
    OMB_WEBHOOK_PORT: process.env.OMB_WEBHOOK_PORT || String(options.port + 1),
  };
  if (options.local) delete env.OMB_PUBLIC_URL;
  if (entry.staticDir) env.OMB_STATIC_DIR = entry.staticDir;
  if (entry.skillsDir && !process.env.OMB_SKILLS_DIR) env.OMB_SKILLS_DIR = entry.skillsDir;
  if (options.label && !process.env.OMB_ENVIRONMENT_LABEL) env.OMB_ENVIRONMENT_LABEL = options.label;
  if (plan) env.OMB_TUNNEL_SOCKET = plan.origin.socketPath;
  let logPath: string | undefined;
  let logFd: number | undefined;
  let tailscaleServing = false;
  let tailscaleAttempted = false;
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
      tailscaleAttempted = true;
      const served = await tailscaleServe(tailscale, options.port);
      // The CLI can finish enabling background serving while cancellation is
      // arriving. Wait for that bounded command, then undo it before exiting.
      if (startupCancelled) throw new SetupCancelled();
      if ("failure" in served) throw new Error(`--tailscale: ${explainTailscaleFailure(served.failure)}`);
      tailscaleServing = true;
      publicUrl = served.origin;
      log(`tailscale: serving https://${tailscale.dnsName} → http://127.0.0.1:${options.port} (only your tailnet can reach it)`);
    }
    if (startupCancelled) throw new SetupCancelled();
    if (publicUrl) env.OMB_PUBLIC_URL = publicUrl;
    child = spawn(entry.command, entry.args, { env, stdio: ["ignore", logFd ?? "inherit", logFd ?? "inherit"] });
  } catch (error) {
    if ((tailscaleServing || (startupCancelled && tailscaleAttempted)) && tailscale) await tailscaleServeOff(tailscale).catch(() => undefined);
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
      // The gateway and the edge stop accepting before the server they forward to goes away.
      if (tunnel) await tunnel.stop().catch(() => undefined);
      if (caddy) await caddy.stop().catch(() => undefined);
      if (tailscaleServing && tailscale) await tailscaleServeOff(tailscale).catch(() => undefined);
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
    }
    log("");
    log(`OpenMausBot is running on http://127.0.0.1:${options.port}${publicUrl ? `, reachable at ${publicUrl}` : ""}`);
    if (options.guided) {
      log("Your bots and conversations are saved automatically.");
      log(`Details if you need help: ${logPath}`);
      if (options.open !== false && !await openDashboard(options.port)) log("Open the local address above in a browser on this computer.");
    } else {
      log(`data: ${options.dataDir}`);
      log(describeBrowserEngine(browserEngineStatus({ dataDir: options.dataDir })));
    }
    if (options.pair && options.phone) {
      log("");
      if (tunnel) {
        // A connector may take a moment to become reachable; no pairing secret
        // is created or sent to the public address until identity is verified.
        log("Preparing the phone connection…");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([tunnel.started.catch(() => undefined), childExit,
          new Promise((done) => { timer = setTimeout(done, 15_000); })]);
        if (timer) clearTimeout(timer);
      }
      if (!stopping && exited === null) await showPhonePairing(options, publicUrl, log);
    } else if (options.pair && !options.guided) {
      log("");
      log(await mintPairing(options.port, { label: options.label ? `${options.label} owner` : undefined, client: options.client, publicUrl: publicUrl ?? undefined }));
      log("");
      log("another device later:  openmausbot pair --label \"Kitchen iPad\"");
    }
    log(options.guided ? "\nKeep this terminal open while using your bots. Ctrl+C stops the server, not your saved work." : "stop with Ctrl+C");
    if (options.guided) log("Next time: openmausbot · Change AI or phone setup: openmausbot setup · Pair another phone: openmausbot pair");
    return await childExit;
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/** Keep setup imports behind the data-dir override: config binds its paths
 * when first imported. `serve` remains usable with stdin closed. */
export async function runOnboardingCommand(
  options: CliOptions,
  io: CliIo = defaultIo(),
  startServer: (options: CliOptions) => Promise<number> = runServe,
  flow: { prompts?: SetupIo; phoneSetup?: typeof runPhoneSetup; running?: typeof isWorkspaceRunning; open?: typeof openDashboard } = {},
): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (options.command === "setup" && !interactive) {
    io.error("Setup needs an interactive terminal. Run `npx openmausbot setup` in a terminal, then use `npx openmausbot serve` for unattended starts.");
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
        io.error("No completed setup was found. Run `npx openmausbot setup` in an interactive terminal first, or use `npx openmausbot serve` with an existing configuration.");
        return 1;
      }
      if (!(await runSetup({ dataDir: options.dataDir, port: options.port }))) {
        io.log("Setup cancelled. Run openmausbot when you're ready.");
        return 130;
      }
    }
    const saved = readCliStartup(options.dataDir);
    // An explicit setup revisits the access choice. Normal starts reuse consent
    // instead of asking again or unexpectedly turning a local session public.
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
      io.log("\nAll set. Start with: openmausbot (or npx openmausbot without a global install).");
      if (options.dataDir !== join(homedir(), ".openmausbot") || options.port !== 8799) {
        io.log(`Use the same --data-dir (${options.dataDir}) and --port (${options.port}) options when starting.`);
      }
      return 0;
    }
    if (saved) io.log("\nWelcome back. Using your saved AI connection.");
    return startServer({ ...launch, guided: interactive });
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log("\nSetup stopped. Any AI setup already saved is kept; no server was started. Run openmausbot setup to continue.");
    return 130;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  process.env.OMB_DATA_DIR = options.dataDir;
  switch (options.command) {
    case "setup":
    case "start":
      return runOnboardingCommand(options);
    case "serve":
      return runServe(options);
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
        action: options.serviceAction ?? "install",
        dataDir: options.dataDir,
        port: options.port,
        domain: options.domain,
        tunnel: options.tunnel,
        tailscale: options.tailscale,
        label: options.label,
        script: process.argv[1] ?? "",
        node: process.execPath,
      }, { log: (line) => console.log(line), error: (line) => console.error(line) });
    case "logout":
      return runLogout(options);
    case "browser":
      return runBrowser(options);
    default:
      console.log(USAGE);
      return 0;
  }
}
