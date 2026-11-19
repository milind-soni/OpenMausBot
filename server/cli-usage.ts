export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  openindbot doctor                    check the server answers and an engine is ready
  openindbot doctor --host             check this Linux machine can run a server (exit 7 if not)
  openindbot doctor --data [--fix]     check (and safely repair) this computer's data folder (exit 8 if a problem is left)
  openindbot bots | channels | models  your bots, your rooms, the engines and their models
  openindbot run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  openindbot send BOT "text"           send one message and return at once
  openindbot wait BOT                  wait on work already running
  openindbot messages BOT              the latest messages of a conversation
  openindbot interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  openindbot export BOT --out DIR      write a job's transcripts, files and screens to DIR
  openindbot events [--job THREAD]     the server's live events as JSON lines
  openindbot team apply FILE           make the workspace match a team file (team export writes one)
  openindbot engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  openindbot connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  openindbot token create NAME --out FILE [--expires 90d]    a token for CI that ends on its date (token list, token revoke ID)
  openindbot new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or OPENINDBOT_URL), --port N (or OMB_PORT), else this computer's.
  Token: OPENINDBOT_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). openindbot help VERB for the details.`;

/** The usage text, its commands written the way this CLI was started (`npx openindbot …`). */
export function usage(prefix = "openindbot"): string {
  return USAGE.split("\n").map((line) => line.replace(/^(\s+)openindbot(?= )/, `$1${prefix}`)).join("\n");
}

export const USAGE = `openindbot — your team of AI bots, ready in a few steps

  openindbot                         set up once, then open your workspace
  openindbot setup [--data-dir DIR]
  openindbot start [the same options as serve]
  openindbot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host | --domain HOST | --tunnel | --tailscale] [--lan] [--relay]
  openindbot pair  [--label NAME] [--phone [ios|android]] [--ttl 24h] [--public-url https://host]
  openindbot devices [revoke ID]
  openindbot status
  openindbot --version
  openindbot login [--email you@example.com] [--relay]
  openindbot logout
  openindbot access list | add EMAIL [--chat-only] | remove EMAIL
  openindbot service install [the same way-in options as serve] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  openindbot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  openindbot config backups | restore NAME    (dated copies of the settings file; see --help)
  openindbot browser install [--with-deps] | status
  openindbot fleet init --domain HOST [--operator USER] | create NAME --admin EMAIL [--member EMAIL] [--brand FILE]
                    [--anthropic-key-file FILE] [--cap USD] [--license-key KEY] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as openindbot: use your saved settings and open the workspace
serve   starts the server without prompts; in a terminal it prints a pairing
        code, the link to paste into the desktop app (＋ → Connect to a
        server) and a QR for a phone
pair    a new pairing code for the running server, with its link and QR
        (--phone: chat and approvals only; --ttl keeps it open up to 24h,
        still single use)
devices lists paired devices; "devices revoke ID" signs one out
status  the running server, the address others reach it at, and whether
        that address answers as this server
login   signs this machine in to an OpenIndBot account (an emailed code)
        and reserves its public address for --tunnel; with --relay it
        reserves none, for serve --relay
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Run from npx, it first
        installs a copy of this version next to your data for the service.
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
        USER manages the others from Settings → Installations.

Ways in (pick one; --lan can join any):
--public-url you already have HTTPS in front (cloudflared, Caddy, nginx):
             the link uses that address, after checking it reaches this
             server. http:// is accepted only for a private network address.
--lan        this network only, plain http: listens on this machine's
             private addresses and answers nobody on the open internet
--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet); the share ends
             when serve stops
--tunnel     serve at a public https://c-… address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`openindbot login\` once on this machine first.
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--relay      phones only, and it can join any of the above except --tunnel:
             the IndBot phone app pairs by QR through IndBot Relay,
             end-to-end encrypted, with no address, open port or VPN. Run
             \`openindbot login --relay\` once on this machine first. Not on a
             machine with a tunnel address: the relay stays off there.

--no-open   do not open a browser window
--no-pair   do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once with \`npm install -g openindbot\`, then type \`openindbot\`.
Or run without a global install: \`npx openindbot\`. Node 24+ is required.
`;
