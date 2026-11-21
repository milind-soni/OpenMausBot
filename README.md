# Edu Bot

Tus agentes de IA, en una sola app. Crea bots con su propio modelo y abre sus conversaciones desde la barra lateral.

[Descargas](https://github.com/EduardoMoraga/edu-bot/releases) · [Documentación](docs/) · [Reportar un problema](https://github.com/EduardoMoraga/edu-bot/issues)

## Why

One assistant in one box is the wrong shape for agents. Edu Bot is an independent, open-source project inspired by **Grok Bot** —
it keeps the idea (AI as a *messaging app*: a roster of bots you chat with, each with its own personality,
memory of its thread, model, computer, and apps) and rebuilds it open, local-first, and on the agents you
already have:

- **Bring your own agents.** Bots run on the `claude`, `codex`, and `grok` CLIs installed on your own machine
  — your existing logins and subscriptions, no new accounts, no proxy in the middle. Point any engine at a
  custom CLI binary (a versioned build or wrapper) in **Settings → Engines**.
- **Local first.** One small harness server on `127.0.0.1` owns every agent process. Transcripts, keys, and
  events live in `~/.openmausbot`, not a cloud.
- **Agents with hands.** Each bot can use a cloud Linux desktop, an isolated Local VM, or—where the platform
  safety boundary is currently certified—your own computer, plus 500+ apps through Composio. Host control is
  available on macOS and Ubuntu Xorg after explicit opt-in. Ubuntu Wayland host control remains disabled while
  issue #345 is resolved.

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🧠 Pick a brain per bot

A model picker with a provider rail — Claude and Codex models side by side, defaults marked, unavailable
providers dimmed with the reason. Switch a bot's model mid-conversation.

<img src="docs/screenshots/model-picker.png" alt="Model picker with provider rail" width="100%">

</td>
<td width="50%" valign="top">

### 🖥️ Every bot gets a computer

Open the Computer panel and the bot's cloud desktop spins up on its own — live screen preview while it
works, "Open desktop" to take over in your browser, or point the bot at *this Mac* instead.

<img src="docs/screenshots/computer-panel.png" alt="Computer panel with live screen preview" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🙋 Bots ask before they act

Shell commands, file edits, and questions surface as inline cards — Allow / Deny / answer in chat. A
permission broker turns every risky action into a decision you make, for cloud and local computers alike.

<img src="docs/screenshots/approval-card.png" alt="Approval and question cards in chat" width="100%">

</td>
<td width="50%" valign="top">

### 🔌 Connected apps

A one-click marketplace over Composio Sessions: Gmail, Slack, GitHub, Notion, Linear and hundreds more.
OAuth once, and every bot can use them as tools.

<img src="docs/screenshots/marketplace.png" alt="Connected apps marketplace" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🗂 Manage bots like chats

Right-click any bot: pin, mark unread, edit profile, duplicate, copy conversation ID, hide, delete. It's a
messaging app — your agents behave like contacts.

<img src="docs/screenshots/context-menu.png" alt="Bot context menu" width="100%">

</td>
<td width="50%" valign="top">

### 🔑 Keys once, everything lights up

Paste credentials in App Settings — they persist locally and the provider fleet hot-reloads instantly.
Secrets are write-only: the UI only ever sees "configured" flags.

<img src="docs/screenshots/app-settings.png" alt="App-level settings with API keys" width="100%">

</td>
</tr>
</table>

### #️⃣ Channels for every context

Keep Work, Personal, and each project in separate channels without cloning your bots. Every channel has
its own transcript, shared instructions, working folder, responder rules, and editable bot roster. File a
channel and its bots under a named context, then rename it or change its members whenever the team changes.

### ⚡ Fast decisions with Jev

Add a Cloudflare Workers AI token with its account ID, a TypeSafe Jev key, or an OpenRouter key and model, in **Settings › AI › Routing and extraction** and rooms set to **Auto** pick the bot
that fits each un-mentioned message in a few hundred milliseconds, falling back to the room's lead whenever the decision model is off or unsure.
See [docs/decision-model.md](docs/decision-model.md).

### 📦 Install a complete team from one Markdown file

Browse outcome-driven teams on [BotMRR](https://botmrr.io), then choose **Add to Edu Bot**. The app
opens a review screen before creating the bots, Chief of Staff, channels, playbooks, connector checklist,
and suggested routines. You can also import the same `.md` file from disk or paste its public GitHub URL
in **Teams → Import**.

The format stays portable: Edu Bot reads the structured YAML frontmatter for a reliable one-click
install, while Grok, Claude, ChatGPT, and people can follow the ordinary Markdown playbook. Connections
remain off until you approve them, routines arrive paused, and packages never carry credentials,
conversations, permissions, memory, or computer access. Browse the
[open-source playbook repository](https://github.com/milind-soni/openmausbot-teams) or read its
[portable format](https://github.com/milind-soni/openmausbot-teams/blob/main/FORMAT.md).

### 🤝 Share a bot or a department

Ask a bot to share itself ("publish yourself to GitHub"), or open a department's **…** menu and choose **Share**. You
get one card: the bots, their instructions, skills and pictures, group chats, routines (paused), the Chief of Staff and
the apps they use, by name. Chats, memory, keys and connection addresses never go in. **Publish** sends it to the
community repository on GitHub and gives you a link; **Save folder…** keeps it on your computer. Anyone adds it with
**+ → Import…** and a link or a folder. See [docs/team-sharing.md](docs/team-sharing.md).
Desktops connected to an organization also get the packages its Admin shares in **Templates**, added with one click,
skills switched on. See [docs/org-library.md](docs/org-library.md).

### 🎧 Bots that talk back

Press the speaker on any reply, or switch a bot to read its answers out as they land — so you can listen
to what ran overnight while you make breakfast. Hit **call** and it's a conversation: it hears you, tells
you what it's doing while it works, and asks for approvals out loud.

Choose ElevenLabs, Fish Audio, Grok (xAI), built-in Mac voices, or a local Chatterbox server in an agent profile. Paste a
cloud key once when needed, pick a voice, and every bot can talk.
Give a bot its own voice and a channel stops sounding like one person.

For Grok, save your xAI API key in **Settings → Connections**, then choose **Grok (xAI)**
and a voice under the bot’s **Voice & alerts**. It reuses that host-side key and returns MP3
audio for spoken replies and calls. Language is detected automatically from the reply text;
quality varies outside xAI’s [officially supported languages](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech).
This adds speech synthesis to the existing call flow; microphone transcription remains unchanged.

**Also in the box:** streaming replies with tool-run activity chips · dictation from the
composer mic (on-device Apple speech recognition on macOS, Fish Audio speech-to-text on Windows and Linux, in the desktop app) · SupaMaus cursor mascots with role-aware
expressions · screenshots of the bot's work folded into the transcript.

## Powered By

<div align="center">

![Claude](https://img.shields.io/badge/Claude-d97757?logo=claude&logoColor=white)
![Codex](https://img.shields.io/badge/Codex-000000)
![Grok](https://img.shields.io/badge/Grok%20CLI-000000?logo=x&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-2B2E3A?logo=electron&logoColor=9FEAF9)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-0F172A?logo=tailwindcss&logoColor=38BDF8)
![Composio](https://img.shields.io/badge/Composio-e6493a)
![Cua](https://img.shields.io/badge/Cua%20Driver-1f2937)
![ElevenLabs](https://img.shields.io/badge/ElevenLabs-000000?logo=elevenlabs&logoColor=white)
![Fish Audio](https://img.shields.io/badge/Fish%20Audio-2563eb)

</div>

| Service | Purpose |
|---|---|
| **Claude · Codex · Grok** | The agents behind every bot, run through their local CLIs |
| **Electron** | Desktop shells for macOS, Windows, and Ubuntu |
| **React + Vite + Tailwind CSS** | The chat app UI and its build |
| **Boat** ([boat.dev](https://boat.dev)) | Each bot's cloud computer |
| **ModelGo** ([modelgo.ai](https://modelgo.ai/)) | One API key for every model |
| **Composio** | Connected apps — Gmail, Slack, GitHub, and more |
| **Cua Driver** | Native computer use on your own machine |
| **ElevenLabs · Fish Audio** | Hosted voices for bots that talk back |

## How it works

Two processes. The app holds no transports of its own — it sends typed commands over HTTP and folds one SSE
event stream into state. The harness server owns every agent process and normalizes each provider's native
protocol into one canonical runtime event stream (logged per-thread as NDJSON).

```mermaid
flowchart LR
    subgraph app ["App — React + Tailwind (5199)"]
        UI[Chat UI · model picker · computer panel]
    end
    subgraph server ["Harness server (127.0.0.1:8799)"]
        REG[Driver registry] --> BUS[Event bus → SSE]
        BROKER[Permission broker]
    end
    subgraph agents ["Agents on your computer"]
        CL[claude CLI]
        CX[codex CLI]
        GR[grok CLI]
    end
    UI -- "HTTP commands" --> server
    BUS -- "one SSE stream" --> UI
    REG --> CL & CX & GR
    CL & CX & GR -- "permission requests" --> BROKER
    server -- "Boat API" --> BOAT[("Cloud computer<br/>boat.dev")]
    server -- "Composio Session" --> APPS[("Gmail · Slack · GitHub · …")]
```

| Layer | Where | What it does |
|---|---|---|
| Drivers | `server/drivers/` | One per provider: Claude, Codex, and Grok Build over their local CLIs (stream-JSON / JSON-RPC / ACP), plus a cloud-computer agent. Unknown drivers degrade to "unavailable", never crash the fleet. |
| Harness | `server/harness/` | Registry (configs → live instances) and the fan-in event bus every client folds. |
| API | `server/index.ts` | Bots, turns, approvals, model catalog, computer lifecycle, connectors, config — HTTP + SSE. |
| Voice | `server/tts/` | ElevenLabs, Fish Audio, Grok (xAI), built-in Mac voices, or local Chatterbox. Cloud keys stay on the harness; markdown is rewritten into something worth hearing before it is spoken. |
| App | `src/` | The chat shell. Server-backed store, one reducer, zero client-side transports. |
| Desktop | `electron/` | macOS, Windows, and Ubuntu shells with an embedded harness and platform capabilities; Apple speech stays macOS-only, Ubuntu Xorg has opt-in local control, and Wayland remains fail-closed. |

### Orchestrate Edu Bot over MCP

Edu Bot ships a stdio MCP server for external clients such as Claude Desktop and Cursor. It exposes a
deliberately bounded team control plane: inspect bots and channels, read/search compact transcript pages,
create and configure bots/channels/tasks, send work, wait for completion, switch models, and interrupt turns.
It does **not** expose approval grants, deletion, arbitrary settings, credentials, or computer lifecycle.

See [MCP server setup and tool reference](docs/mcp-server.md).

### Run it from scripts and CI

The `openmausbot` command drives a running workspace without a screen: set a
team up from a file, give a bot one job, wait until it and every teammate it
asked are done, and export what they made. One JSON document with `--json`,
and exit codes a script can branch on.

```sh
openmausbot team apply team.yaml
openmausbot run "Room Lead" "Rehearse the launch of https://example.com" --export ./out
```

See [Run Edu Bot from scripts and CI](docs/headless-cli.md).

## Quick start

Published desktop packages appear on the [Edu Bot releases page](https://github.com/EduardoMoraga/edu-bot/releases).

**From source:**

```sh
git clone https://github.com/EduardoMoraga/edu-bot && cd edu-bot
pnpm install

pnpm dev:server    # harness server → 127.0.0.1:8799
pnpm dev           # app → http://127.0.0.1:5199
pnpm dev:desktop   # Electron shell; keep the two commands above running
```

Requirements: **macOS, Windows, or Ubuntu 24.04 x64**, **Node 24+**, **pnpm**, and at least one agent CLI — [`claude`](https://claude.com/claude-code),
[`codex`](https://github.com/openai/codex), or [`grok`](https://x.ai/cli) — installed and logged in. They appear
in the model picker automatically.

Package the desktop application:

```sh
pnpm package:mac      # macOS: DMG + ZIP; requires Swift/Xcode tools
pnpm package:win      # Windows: installer + ZIP
pnpm package:linux    # Linux x64: .deb + .rpm + AppImage + verified CUA runtime
```

### Desktop capability status

| Capability | macOS | Windows x64 | Ubuntu 24.04 Xorg | Ubuntu 24.04 Wayland |
|---|---|---|---|---|
| Packaged app, embedded harness, local agent CLIs | Supported | Supported | Beta | Beta |
| Composio and Boat/cloud computers | Supported | Supported | Beta | Beta |
| Explicit preview-only local screen capture | Supported | Unavailable | Beta | Beta |
| Bot control of this computer | Supported | Supported | Beta, explicit opt-in | Disabled: Wayland safety gate (Omarchy with Cua's Hyprland plugin: experimental) |
| Native on-device dictation | Supported | Unavailable | Planned | Planned |
| Dictation and Take turns calls through Fish Audio (needs a Fish Audio key) | Not used, on-device instead | Supported | Supported | Supported |

On Windows, choose **This computer** to let a bot control the local desktop. The packaged app includes its own
CUA driver and SDK; a separate Cua installation is not required. Local bot control is available even though the
preview-only screen capture above is unavailable. See [Computer use & browser use](docs/computer-use-integration.md).

The Linux preview is user-initiated and never enables local bot control or Auto routing. On Xorg, the reviewed Cua
Driver 0.41.3 runtime starts only after explicit opt-in and without its full-screen cursor overlay. On Wayland the
app never starts it and clears legacy opt-ins while that real-seat safety gate remains unresolved. Chat, preview,
Cloud, and Local VM remain available on both sessions. See the [Ubuntu Desktop guide](docs/linux-desktop.md) and tracking
issues [#29](https://github.com/milind-soni/OpenMausBot/issues/29),
[#345](https://github.com/milind-soni/OpenMausBot/issues/345), and
[#113](https://github.com/milind-soni/OpenMausBot/issues/113).

The Linux packager downloads only the tag-pinned upstream archive during the build, verifies its size, SHA-256,
complete member allowlist, and inner executable hashes, then packages only the CLI and cursor-theme sidecar. The
installed app never downloads or self-updates native automation code. Cua's MIT notice, Inter's SIL OFL, a generated
third-party license report, and a CycloneDX inventory ship with the runtime. See
[`third_party/cua-driver/`](third_party/cua-driver/) for the reviewed provenance record.

These credentials are optional — local chat works without them. Paste a key once in **App Settings** (gear
in the sidebar footer) when you want to enable its integration:

| Credential | What it enables | Where to get it |
|---|---|---|
| Composio project key (`ak_…`) | Connect Gmail, GitHub, Slack, Notion, and other apps to your bots | [Edu Bot Composio setup](docs/composio.md) |
| Boat API key | Give bots an isolated remote Linux computer with a desktop and terminal | [Boat API key guide](https://docs.boat.dev/api-keys) |
| ElevenLabs key | Read replies aloud, and call your bots | [ElevenLabs API keys](https://elevenlabs.io/app/settings/api-keys) |
| Fish Audio key | Read replies aloud with Fish Audio voices, and call your bots | [Fish Audio API keys](https://fish.audio/app/api-keys/) |

Composio and Boat are third-party services with their own accounts and terms. Boat is a paid service after
its trial, and using a cloud computer may incur charges.

```sh
pnpm typecheck     # app + server
pnpm test          # unit, driver, API, and desktop capability tests
pnpm build         # typecheck + production build
pnpm check:electron # syntax-check Electron main/preload files
pnpm package:win   # Windows installer + zip → release/
pnpm package:linux # Linux x64 .deb + .rpm + AppImage → release/
```

### Triggers: schedules and webhooks

A trigger is "when something happens, a bot does something". Tell a bot "every weekday at 9, send me a summary
of my inbox" or "whenever our form calls, draft a reply" and it sets the trigger up in that turn with
its `trigger` tool (no confirmation; the chat shows a live card with Edit, Pause and Undo). **Triggers**, first in
the sidebar, lists every schedule and webhook, with a calendar and the run history. Bots manage them with
`trigger_info` (list, app events), `trigger` (create, update, pause, resume, run now) and `delete_trigger`; a webhook a bot makes never shows the bot its secret:
the person copies the link from the card or the Triggers page.

Schedules (routines) can run once, on selected weekdays, or every 5–1,440 minutes, using either a bot's configured
model/computer or the Cloud VM runner. Interval schedules stay aligned to their chosen start time and skip
an occurrence when the previous run is still active, so slow work cannot build an unbounded queue. A
separate optional Advanced run limit can safely stop stuck work; no timeout is imposed unless one is chosen.
The existing duration field remains calendar/display metadata. Webhook triggers are independent from schedules
but reuse the same queued task executor and calendar
receipts.

**App events** start a bot when something happens in a connected app ("whenever I get an email from Acme, draft
a reply"). The bot finds the app's events with `trigger_info` (`action: "events"`) and calls `trigger` with
`action: "create"` and `when: "app_event"`; the person can also choose **New → Set it up yourself → When something happens in an app**.
Composio sends each event to a connected-apps broker you run (`OMB_COMPOSIO_BROKER_URL`), which queues it; the app collects the queue
with a long poll, so a desktop needs no public address and events wait while it is closed. Gmail is checked every
15 minutes; Slack, GitHub and other push apps arrive at once. A desktop keeps up to 500 events a day and a paid
Cloud 2,000; what is skipped shows on the automation. App events need the included connected apps: a server
using its own Composio key cannot watch apps yet. Details: [docs/composio.md](docs/composio.md#app-events).

Edu Bot starts a webhook-only receiver on `127.0.0.1:8800` by default (or one port above `OMB_PORT`).
Set `OMB_WEBHOOK_PORT` to choose another port. A webhook secret is shown once when the trigger is created
or rotated. Bearer authentication is recommended so the secret stays out of request URLs and most access
logs; a single capability URL remains available for senders that cannot configure headers. The receiver
exposes only `/health` and secret `/hooks/...` endpoints; it never exposes the app's broader API.
Edu Bot must remain running to accept a delivery. For public internet delivery, proxy only this
dedicated receiver through a hosted relay or a tool such as Tailscale Funnel.

## Status

Early but real — the loop works end to end: message → agent → streamed reply → tools → approvals →
computer use. macOS, Windows, and Ubuntu 24.04 x64 have released builds; Ubuntu remains a beta with the
capability limits above. Rough edges to expect: hosted/mobile connectivity is still being built, and webhook
triggers currently use the local receiver rather than an always-on hosted relay.
Hosted voice needs an ElevenLabs, Fish Audio, or xAI key; built-in Mac and local Chatterbox voices need no cloud key. Take-turns calls and the composer mic listen on-device on macOS and through Fish Audio speech-to-text on Windows and Linux (the same Fish Audio key as voices). See [`docs/voice-mode.md`](docs/voice-mode.md) for the design and the known gaps.

Contributions welcome — the driver SPI in [`server/contracts.ts`](server/contracts.ts) is deliberately
small; adding a provider is one file in [`server/drivers/`](server/drivers/) plus a one-line registration.
No code needed at all for your own engines: any ACP-speaking CLI or OpenAI-compatible endpoint
plugs in through config — see [`docs/custom-engines.md`](docs/custom-engines.md).
Users can add their own MCP tool servers with zero code via [`docs/custom-mcp-servers.md`](docs/custom-mcp-servers.md).
For configuration switches, defaults and model-call implications, see [Feature switches](docs/feature-flags.md).
To run bots on OpenRouter, Fireworks AI, DeepSeek, Cline or your own OpenAI- or Anthropic-compatible provider,
see [Other model providers](apps/docs/content/docs/providers/model-providers.mdx).

## Privacy

Edu Bot sends no usage analytics. [`docs/edu-bot/network.md`](docs/edu-bot/network.md) lists every outbound host
and when it is contacted.

## Run from a terminal or on a server

With Node 24 or newer, install once and run:

```sh
npm install -g openmausbot
openmausbot
```

Or use `npx openmausbot` without a global install. First launch guides you with
arrow-key choices: choose AI access, sign in or paste a hidden API key, choose
a model, and optionally connect a phone. Next time, the same command reuses your
saved setup and opens Edu Bot on this computer. Keep the terminal open; Ctrl-C stops
the server, not your saved work. Use `--no-open` to skip opening the browser.

Phone access is optional and defaults to skipping. Choose an explicitly
approved managed public HTTPS endpoint protected by pairing, an existing
Tailscale connection, or your own HTTPS reverse proxy. Both native apps pair from
this flow: the QR is an app link when you are connecting an Android phone, and the
iOS app takes either that or the web link. A browser works on either phone. A phone
cannot use a localhost link. `--local` ignores saved remote access for one launch;
`--no-pair` suppresses phone prompts and invitations but does not disable a saved
remote connection.

The web UI can also be installed from Safari or Chrome as a standalone phone
app. See [Install the phone web app](docs/phone-web-app.md) for Home Screen
installation and pairing.

Run `openmausbot setup` to reconfigure without resetting bots or conversations;
the saved model default applies only to new bots. Native setup confirms provider
sign-in; API setup asks before a potentially billable test message. API keys
from `openmausbot setup` and the server are saved as plaintext, not encrypted,
in private `config.json` (`0600` on Unix). The packaged desktop app keeps your
AI provider and service keys encrypted through the operating system instead;
its `config.json` still holds OpenCode provider keys, keys given to one engine,
and MCP header values in plaintext (a key a bot set from a secret card is kept
in the Vault, and `config.json` holds only a pointer to it).
See the [short setup guide](docs/cli-onboarding.md) for account differences,
phone choices, credential storage, and cancellation.

For a server on a VPS or an always-on computer, run `npx openmausbot serve`
with one way in: `--public-url` behind your own cloudflared, Caddy or nginx,
`--domain` for a certificate on your own domain, `--tailscale` for your
tailnet, `--lan` for this network only, or `--tunnel` (after
`npx openmausbot account login`) for a free MausBot web address. It prints one
pairing link; paste it into the desktop app under **＋ → Connect to a
server**. The short path for each install method (npx, Docker, a service) is
at the top of [docs/self-hosting.md](docs/self-hosting.md); a server from
scratch is [docs/deploy-vps.md](docs/deploy-vps.md).

## License

Edu Bot is licensed under the [Apache License 2.0](LICENSE) © 2026 Eduardo Moraga and Edu Bot
contributors. It is an independent fork of [OpenMausBot](https://github.com/milind-soni/OpenMausBot)
(© 2026 Milind Soni and OpenMausBot contributors, Apache-2.0), without upstream's source-available
`enterprise/` directory. Full upstream and third-party attributions are in [NOTICE](NOTICE); details
are in [LICENSING.md](LICENSING.md). Edu Bot is not affiliated with or endorsed by Supamaus Software
Private Limited or OpenMausBot; "OpenMausBot", "MausBot" and the SupaMaus mascot are trademarks of
Supamaus Software Private Limited.

Packaged Cua Driver components retain their upstream MIT, SIL OFL 1.1, MPL-2.0, and other dependency terms;
the corresponding notices, license texts, source locations, and SBOM are in
[`third_party/cua-driver/`](third_party/cua-driver/) and ship beside the native runtime.

Edu Bot is an independent, open-source project inspired by Grok Bot. It is
not affiliated with, endorsed by, or associated with xAI; "Grok" is a trademark
of its respective owner.
