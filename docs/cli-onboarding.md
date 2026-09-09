# Terminal setup

Install [Node.js](https://nodejs.org/) 24 or newer, then choose either way to run OpenMausBot:

```sh
# Install once, then use the short command:
npm install -g openmausbot
openmausbot
```

Or, without a global install:

```sh
npx openmausbot
```

Use the same command next time. The first launch guides you through setup; later launches reuse your saved AI connection and phone-access choice. `openmausbot start` is the same as the bare command. If that workspace is already running, OpenMausBot opens it instead of starting a second server.

## First launch

The setup wizard uses Clack. Use ↑/↓ and Enter to select an option. Plain terminals show numbered choices instead.

1. Choose ChatGPT/Codex, Claude Code, or an API service. Existing supported connections are also listed.
2. Sign in with the provider, or paste an API key into the hidden prompt. Setup asks before installing a missing Codex or Claude CLI. Codex also offers device-code sign-in for a remote terminal. API choices include OpenAI, OpenRouter, Groq, and other OpenAI-compatible endpoints.
3. Choose a model and save. An API connection asks permission to send a short test message, which the provider may charge for. Native CLI setup confirms sign-in; it does not test the chosen model with a message. Model access is checked when you send one.
4. Optionally connect a phone, or choose **Skip for now**. Your AI setup is already saved before this step.

The workspace then starts and opens its local address in a browser on this computer. On SSH or a computer without a graphical desktop, open the printed address using an appropriate connection instead. Automatic browser opening only uses the local address; `--no-open` disables it.

Keep the terminal open while using your bots. This runs a foreground server, not an installed background service. Ctrl-C stops the server without deleting saved work; closing the browser alone does not stop it. Bots keep working only while the computer and server are running.

Codex and Claude Code support agent tools. API-key connections currently support chat only. A ChatGPT or Claude subscription does not include separately billed API usage. Changing the saved default affects **new bots only**; existing bots and conversations keep their settings.

## Optional phone access

A phone cannot connect to this computer's `localhost` address. The harness also does not listen on your LAN address. The guide does not create a phone QR until a configured HTTPS address has been checked against this workspace.

Choose one connection method:

- **Managed HTTPS address:** setup asks explicit permission for a public endpoint through Cloudflare and a possible connector download. Device pairing protects chat and settings; the pairing page and basic server identity remain publicly reachable. Sign in to an **OpenMausBot account** using an emailed code, or reuse this machine's saved account. This account is separate from ChatGPT, Claude, or an API-provider account. The connection stays active while OpenMausBot runs.
- **Existing Tailscale:** both computer and phone must already be signed in to the same tailnet, with HTTPS certificates enabled. Setup asks before enabling HTTPS serving to that tailnet; it does not install or sign in to Tailscale for you.
- **Existing HTTPS address (advanced):** supply the origin of a reverse proxy you already configured, such as `https://maus.example.com`. Do not paste a password, path, query, or pairing code. Entering an address does not create the proxy or open a LAN listener.

After the connection is ready:

- **iPhone/iPad:** scan the QR with Camera to open Safari. If you already have the OpenMausBot iOS app, use its pairing scanner or paste the full link there.
- **Android:** scan with Camera and open the link in your web browser. This CLI link does **not** work with the current Android native app's companion-pairing scanner.

Choose **Connect** on the phone. Scanning alone is not a successful pairing. The code is private, single-use, and expires after five minutes. Guided phone pairing grants client access for chat and approvals, not settings or pairing administration.

If the workspace starts but its HTTPS check fails, the local workspace remains usable and no phone code is created. Fix the connection and run `openmausbot pair` in another terminal to try again. A missing account, connector, or Tailscale prerequisite can prevent startup; follow the printed error, or use `openmausbot --local`. To add phone access after skipping it, stop the server, run `openmausbot setup`, then start it again.

## Commands

The examples below assume a global install; prefix them with `npx` otherwise.

| Command | Use |
| --- | --- |
| `openmausbot` | Set up once, then start with saved settings. |
| `openmausbot setup` | Revisit AI and optional phone setup, save, and exit without starting. This is not a reset. |
| `openmausbot --no-open` | Start without opening a browser. |
| `openmausbot --local` | Ignore saved remote access for this launch; keep the saved choice for next time. |
| `openmausbot --no-pair` | Suppress phone setup prompts and pairing invitations. This does **not** turn off saved remote access; use `--local` for that. |
| `openmausbot pair` | Create another phone invitation while the configured workspace and HTTPS connection are running. |
| `openmausbot sessions` | List paired devices; `openmausbot sessions revoke ID` signs one out. |
| `openmausbot serve` | Start without onboarding prompts or automatic browser opening; specify remote-access flags explicitly for a service. |
| `openmausbot login` | Sign in to an OpenMausBot account for `--tunnel`; this does not sign in to an AI provider or start the tunnel. |

`start` accepts the same server options as `serve`, including `--port`, `--data-dir`, `--tailscale`, `--tunnel`, and `--public-url`. Keep using your custom data directory and port when starting or pairing:

```sh
openmausbot setup --data-dir /path/to/omb-data --port 8799
openmausbot --data-dir /path/to/omb-data --port 8799
```

Setup needs an interactive terminal. Later starts can run without one once setup is complete. Stop a running server before changing its setup or access mode: `--local` does not turn off a remote connection belonging to a server that is already running. You do not need to delete configuration, bots, or conversations to reconfigure it.

## Credentials and cancellation

API keys are hidden while typed or pasted. New API connections save their key in the data directory's `config.json` as **plaintext, not encrypted**, with owner-only permissions (`0600`) on Unix. Managed-access account credentials in `tunnel-account.json` are also plaintext with `0600` permissions on Unix. Keep these files and backups private. Native provider sign-in credentials are managed by the provider's own CLI.

Ctrl-C during AI setup leaves unsaved OMB changes unapplied. Installations and provider sign-ins already completed remain available. Ctrl-C during the later phone step keeps the AI setup you already saved, exits without starting a server, and does not undo an account sign-in already completed. Run `openmausbot setup` to continue; no destructive reset is needed.

For remote access and background deployment options, see [self-hosting](self-hosting.md) and [the VPS guide](deploy-vps.md).
