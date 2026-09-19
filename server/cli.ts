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

// Public import surface. The implementation lives in focused modules under
// ./cli/; every name the original single file exported is re-exported below,
// so existing "./cli.ts" imports keep working unchanged.
export { defaultIo, parseArgs, serverVersion, USAGE } from "./cli/options.ts";
export type { CliIo, CliOptions } from "./cli/options.ts";
export { isWorkspaceRunning, openDashboard, verifyPhoneEndpoint } from "./cli/client.ts";
export { applyStartupPreferences } from "./cli/prefs.ts";
export { pairingBlock, qrToString, runPair } from "./cli/pairing.ts";
export { formatSessions, runSessions } from "./cli/sessions.ts";
export { runAccess, runBrowser, runLogin, runLogout, runStatus } from "./cli/accounts.ts";
export { runServe, serverEntry } from "./cli/serve.ts";
export { runOnboardingCommand } from "./cli/onboarding.ts";
export { main } from "./cli/main.ts";
