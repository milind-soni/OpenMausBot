# Network: what Edu Bot contacts, and when

Edu Bot sends no usage analytics and no crash reports. It does not contact the upstream OpenMausBot project's
services unless you configure them. This page lists every outbound host that remains, grouped by when it is contacted.

## On its own, with nothing configured

| Host | What | When | Turn it off |
| --- | --- | --- | --- |
| `raw.githubusercontent.com/EduardoMoraga/edu-bot` | The model list (`server/model-manifest/model-manifest.json`) | At start and about hourly; a plain GET with nothing of yours in it | `OMB_DISABLE_MODEL_MANIFEST_FETCH=1` |
| `models.dev` | The public model catalog (`/api.json`) | At most once a day | `OMB_DISABLE_MODEL_CATALOG_FETCH=1` |
| `registry.npmjs.org` | The newest Codex version (`@openai/codex/latest`) | At start and at most hourly, to tell whether the Codex engine is current | — |

The server also probes local model servers on this computer (Ollama, LM Studio and similar, on `127.0.0.1`), and
starts each engine CLI installed on this computer to read its version and sign-in. Those CLIs are third-party
programs and may contact their own vendor when they start; for example, Cursor's CLI calls `api2.cursor.sh`.

Checked on an isolated server (empty data folder and home, nothing configured): in its first minute it made exactly two
outbound requests of its own, the model list above and the Codex version check.

Checked in the app itself too: the renderer, served by Vite against an isolated server and opened in headless
Chromium, made no request outside this computer while loading, nor after opening the Apps panel. App icons come
from the connection service's catalog once connected apps are set up; until then the app draws bundled glyphs or
the app's initial. It never asks a favicon service.

The desktop app does not update itself and does not check for updates: auto-update stays off
(`electron/desktop-updates.mjs`) until Edu Bot publishes its own signed releases.

## When you use a feature

Nothing here is contacted until you use the feature named in the last column.

### AI providers and engines

| Host | What | When |
| --- | --- | --- |
| The AI providers you set up (Anthropic, OpenAI, Google, xAI, OpenRouter, Venice and the others in Settings) | Model calls, model lists, sign-in, usage | When a bot runs on that provider, or you add its key; each engine's CLI also talks to its own vendor |
| `registry.npmjs.org` | Engine installs | When you install or update an engine that ships on npm |
| `downloads.cursor.com`, `cursor.com` | Cursor engine installer and sign-in | When you install or sign in to Cursor |
| `github.com/anomalyco/opencode` | OpenCode engine release | When you install OpenCode |
| `github.com/mistralai/mistral-vibe`, `mistral.ai`, `astral.sh` | Mistral Vibe engine release and installer (`uv` from `astral.sh` on Windows) | When you install Mistral Vibe |
| `app.factory.ai` | Factory Droid engine installer | When you install Droid |
| `x.ai`, `accounts.x.ai`, `auth.x.ai` | Grok engine installer and sign-in | When you install or sign in to Grok |
| `cli.devin.ai`, `static.devin.ai` | Devin engine installer | When you install Devin |
| `hermes-agent.nousresearch.com` | Hermes engine installer | When you install Hermes |
| `code.kimi.com`, `auth.kimi.com` | Kimi engine installer and sign-in | When you install or sign in to Kimi |
| `cli.kiro.dev` | Kiro engine installer | When you install Kiro |
| `qwen-code-assets.oss-cn-hangzhou.aliyuncs.com` | Qwen Code engine assets | When you install Qwen Code |
| `dev.meta.ai`, `api.meta.ai` | Meta engine installer and API | When you install the Meta engine or add its key |
| `api.cline.bot` | Cline's public list of recommended models | When the Cline engine lists its models |
| `api.venice.ai` | Venice's model list for OpenCode | When OpenCode lists models with your Venice key |
| `storage.googleapis.com`, `dl.google.com` | Chrome for Testing for the bots' browser; the Antigravity engine | When you install them |

### The bots' browser, computers and phone

| Host | What | When |
| --- | --- | --- |
| `github.com/vercel-labs/agent-browser/releases` | The browser engine for macOS and Linux (checked by hash) | When the browser engine is installed |
| `github.com/milind-soni/OpenMausBot/releases` | The pinned Windows browser-engine binary (checked by hash) | When the browser engine is installed on Windows |
| `files.pythonhosted.org`, `raw.githubusercontent.com/notofonts/noto-cjk` | The computer-use driver and CJK fonts for a container computer | When a container computer's image is built |
| `github.com/Genymobile/scrcpy/releases` | scrcpy, for an Android phone's screen | When you show an Android phone's screen |

### Your accounts and services

| Host | What | When |
| --- | --- | --- |
| `backend.composio.dev`, and the logo addresses its catalog names | Connected apps (OAuth grants) and their icons | Only with your own Composio key, or a broker you run (`OMB_COMPOSIO_BROKER_URL`) |
| `autoconfig.thunderbird.net`, `autoconfig.<your domain>`, `<your domain>/.well-known/autoconfig` | Mail server settings for your address | When you add an email account |
| `github.com/bitwarden/clients/releases` | The Bitwarden CLI | When you connect Bitwarden |
| `vault.bitwarden.com`, `vault.bitwarden.eu`, or your own server | Your Bitwarden vault | When you connect Bitwarden and a bot uses a saved login |
| `api.netlify.com` | Site publishing | When you publish a site with your Netlify token |
| `api.postiz.com` | Social posts | When you set up Postiz with your key |
| `boat.dev` | Boat cloud computers | When you set up Boat with your key |
| `treg.to` | X research | When you set up X research with your key |
| ElevenLabs, Fish Audio, other voice services | Speech | Only when you turn on that voice engine with your key |
| `extensions.duckdb.org` | DuckDB extensions | When a data tool needs one |
| `docs.google.com` | A Google Sheet's CSV export | When you give a data tool a Google Sheets link |

### Things you import or open

| Host | What | When |
| --- | --- | --- |
| `api.github.com`, `raw.githubusercontent.com` | Skills and bot or team templates | When you import one from a GitHub link |
| `raw.githubusercontent.com/milind-soni/openmausbot-teams` | The team library catalog | When you open the team library |
| `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`, `esm.sh`, `fonts.googleapis.com`, `fonts.gstatic.com` | Scripts and fonts a bot-made app or page loads, in your browser | When you open an app or page a bot made that uses them |
| Websites, MCP servers and APIs your bots use | Whatever the bot's tools do | When a bot calls them |

### Server administration

| Host | What | When |
| --- | --- | --- |
| `github.com/caddyserver/caddy/releases` | Caddy, for HTTPS on your own domain | When you run `serve --domain` |
| `cloud.openmausbot.com` | A `HEAD` request to read the clock | Only when you run the `doctor` command on a headless server |
| `acme.zerossl.com` | HTTPS certificates | Only on an upstream MausBot Cloud home, never on your computer |

## Only when you configure it

| Host | What | Switch |
| --- | --- | --- |
| `api.github.com/repos/EduardoMoraga/edu-bot`, `raw.githubusercontent.com/EduardoMoraga/edu-bot/channels` | Update check for a self-hosted server (npm, Docker or git install), when its page asks. No release yet means "up to date", never an error | Always on for those installs; the desktop app never asks |
| `raw.githubusercontent.com/EduardoMoraga/edu-bot` | The announcements file | `OMB_ANNOUNCEMENTS=1` (off by default) |
| The address you give | `@devs` bug reports and their status | `OMB_BUG_REPORT_URL` (off by default; the `@devs` mention is hidden without it) |
| The control plane you give | Phone relay, `serve --tunnel`, emailed sign-in codes | `OMB_CONTROL_PLANE_URL` (none by default; LAN and Tailscale still work) |
| Your own mail server | Emailed sign-in codes | `OMB_SIGNIN_SMTP_URL` |
| `cloud.openmausbot.com` | The upstream MausBot Cloud account (sign-in, plans, product-update consent) | `OMB_CLOUD_ACCOUNT=1` (or `OMB_CLOUD_STAGING=1` for its staging Admin) |
| The broker you give | A managed Composio broker | `OMB_COMPOSIO_BROKER_URL` |

## Removed

- PostHog usage analytics in the app and the desktop launch counters: removed with the `posthog-js` dependency.
- The upstream sponsor and promotion cards from the announcements feed.
