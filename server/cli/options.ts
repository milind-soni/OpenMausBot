// Arguments, usage text, terminal IO, and the shipped version. Base module of
// ./cli/: it imports no sibling module.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { normalizeDomainOption } from "../caddy.ts";
import type { FleetInput } from "../fleet-cli.ts";

// This module sits one directory below the cli.ts barrel it split from, and
// bundled builds inline it back beside the server in dist-server/, so unwrap
// only that source-tree nesting: HERE keeps resolving to the directory the
// cli.ts barrel lives in, exactly as before the split.
const moduleDir = dirname(fileURLToPath(import.meta.url));
export const HERE = basename(moduleDir) === "cli" ? dirname(moduleDir) : moduleDir;

export interface CliOptions {
  command: "setup" | "start" | "serve" | "pair" | "sessions" | "status" | "login" | "logout" | "access" | "service" | "browser" | "fleet" | "help";
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
  /** Internal guided-start presentation; serve remains script-friendly. */
  guided?: boolean;
  phone?: "ios" | "android";
}

const COMMANDS = ["setup", "start", "serve", "pair", "sessions", "status", "login", "logout", "access", "service", "browser", "fleet", "help", "--help", "-h"];

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
      // Which phone is about to scan, for a run with nobody at the keyboard.
      // `docker compose exec … pair` and any scripted pairing never reach the
      // interactive chooser, and only an Android phone needs a different QR.
      else if (arg === "--phone") {
        const kind = value().toLowerCase();
        if (kind !== "ios" && kind !== "android") return { error: "--phone takes ios or android" };
        options.phone = kind;
      }
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
      else if (options.command === "fleet" && !options.fleetAction && ["init", "create", "list", "users", "suspend", "resume", "delete", "upgrade", "agent"].includes(arg)) options.fleetAction = arg as FleetInput["action"] | "agent";
      else if (options.command === "fleet" && options.fleetAction && !["init", "list", "upgrade", "agent"].includes(options.fleetAction) && !options.slug && !arg.startsWith("--")) options.slug = arg;
      else if (options.command === "fleet" && arg === "--operator") options.operator = value();
      // a Unix socket path, taken as given: resolving it would turn it into a Windows path in tests
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
  if (options.publicUrl && !/^https?:\/\//.test(options.publicUrl)) return { error: "--public-url must start with http:// or https://" };
  if (options.tailscale && options.tunnel) return { error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" };
  if (options.command === "access" && !options.accessAction) return { error: "access needs one of: list, add EMAIL [--chat-only], remove EMAIL" };
  if (options.command === "service" && !options.serviceAction) return { error: "service needs one of: install [the same options as serve], uninstall" };
  if (options.domain && (options.tailscale || options.tunnel || options.publicUrl)) return { error: "--domain already gives the server its address; drop --tailscale, --tunnel and --public-url" };
  if (options.local && (options.tailscale || options.tunnel || options.publicUrl)) return { error: "--local cannot be combined with a remote-access option" };
  if (options.command === "browser" && !options.browserAction) return { error: "browser needs an action: install or status" };
  if (options.command === "fleet") {
    if (!options.fleetAction) return { error: "fleet needs one of: init --domain HOST [--operator USER], create NAME --admin EMAIL, list, users NAME add|remove EMAIL, suspend NAME, resume NAME, delete NAME --yes, upgrade, agent" };
    if (["create", "users", "suspend", "resume", "delete"].includes(options.fleetAction) && !options.slug) return { error: `fleet ${options.fleetAction} needs a workspace name` };
    if (options.fleetAction === "users" && !options.fleetUserAction) return { error: "fleet users needs: NAME add|remove EMAIL [--chat-only]" };
    if (options.cap !== undefined && (!Number.isFinite(options.cap) || options.cap < 0)) return { error: "--cap must be a dollar amount of 0 or more" };
  }
  return options;
}

export const USAGE = `openmausbot — your team of AI bots, ready in a few steps

  openmausbot                         set up once, then open your workspace
  openmausbot setup [--data-dir DIR]
  openmausbot start [the same options as serve]
  openmausbot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
  openmausbot pair  [--label NAME] [--client] [--phone ios|android]
                    [--public-url https://host]
  openmausbot sessions [revoke ID]
  openmausbot status
  openmausbot login [--email you@example.com]
  openmausbot logout
  openmausbot access list | add EMAIL [--chat-only] | remove EMAIL
  openmausbot service install [--domain HOST | --tunnel | --tailscale] [--port N] [--data-dir DIR] | uninstall
  openmausbot browser install [--with-deps] | status
  openmausbot fleet init --domain HOST [--operator USER] | create NAME --admin EMAIL [--member EMAIL] [--brand FILE]
                    [--anthropic-key-file FILE] [--cap USD] [--license-key KEY] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

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
fleet   many client workspaces on one Linux server, each its own account,
        service, data folder, brand, sign-in list and keys at NAME.HOST
        behind the system Caddy. Plans are printed unless run as root;
        --dry-run always prints. Install the package permanently first.
        init --operator USER also installs the fleet agent, a root service
        on a Unix socket only USER may open, so the workspace running as
        USER manages the others from Settings → Workspaces.

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
