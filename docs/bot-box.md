# The bot box

On a MausBot Cloud home every bot turn runs in a box: the engine (Claude Code, Codex, Grok, OpenCode, the ACP agents),
every shell command it runs, the MCP servers it starts and OpenMausBot's own helper proxies all live inside one
unprivileged [bubblewrap](https://github.com/containers/bubblewrap) sandbox for that process's lifetime. The server,
its database, its settings, other bots' folders and other turns' processes are not in it. Code: `server/bot-box/`.

## What a boxed process sees

| Inside the box | What it is |
|---|---|
| `/usr`, `/etc`, `/opt`, the server's own code folder, read-only | The image: engine CLIs, node, python, git, the bots' browser |
| `HOME`, read-write | What bots and engines keep there: settings, tools, caches, git config. Of the engines' sign-in files (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.grok/auth.json`, the rest of `ENGINE_FOLDERS` in `server/engine-homes/layout.ts`) only the one of the engine account the process runs is there, bound over itself so a refresh writes in place; every other engine's and account's is an empty read-only file; every folder between HOME and those files is bound over itself, so a bot cannot rename one away; and a process that names no engine (a shell step, an MCP server) has none (`server/bot-box/sign-in-masks.ts`). The edge's certificate folder (`~/.omb-edge`) is an empty private folder. On a Team Cloud this is the turn's audience's engine home instead, with the team's engine sign-in files bound into it, and the server's HOME is not there at all ([team-cloud.md](team-cloud.md#engine-homes)) |
| the data folder (`~/.openmausbot`), **an empty private folder** | `messages.db`, `config.json`, logins, the server's sockets, every other bot's folders are not there |
| put back inside it: the turn's working folder and the bot's own folder (`workspaces/<bot>`), read-write | What the turn works on, and the bot's memory and skills. On a Team Cloud a turn that is not the team's has the bot's own folder read-only, and its own memory layer read-write ([team-cloud.md](team-cloud.md#the-audience-rule)) |
| put back: this turn's permission socket (the engine's question and approval helper reaches the server through it), and, read-only, the conversation's own hook token folder (the hook helper's bearer, renewed each turn) and the files its command line names (MCP config, system prompt) | What the driver made for this one process |
| private `/tmp`, `/var/tmp`, `/run`, `/dev`, `/proc` | Its own PID namespace: other turns' processes do not exist for it |
| `/sys/devices/system/cpu/possible` and `online`, read-only; nothing else of `/sys` | The machine's CPU count. Programs built with TCMalloc (Google's Antigravity runtime) stop themselves at start without it (exit 134) |
| a network namespace with loopback only | Two loopback ports are bridged to unix sockets from outside (below); nothing else on the machine's loopback is reachable, and there is no route out |

The environment is an allow-list (`server/bot-box/env.ts`): the engine's own settings and keys, the harness capability
tokens and a few names a shell expects. Of OpenMausBot's own `OMB_*` variables only those a bot's engine, hooks and MCP
proxies read pass (`BOX_ENV_OMB_NAMES`); every other one an operator sets on the server, such as `OMB_SIGNIN_SMTP_URL`,
stays out. Every `OMB_CLOUD_*` setting, the server's own placement (`OMB_DATA_DIR`, `OMB_PORT`), the CLI's session
token and server address (`OPENMAUSBOT_TOKEN`, `OPENMAUSBOT_URL`) and the workspace credentials are refused whatever
a driver passed.

## The two gates

- **Egress** (`server/bot-box/egress-gate.ts`): an HTTP proxy (`CONNECT`, and absolute URLs for plain http) at
  `127.0.0.1:3128` inside the box, bridged to the server's gate. `HTTPS_PROXY` and `HTTP_PROXY` point there. The gate
  resolves names itself and connects only to public addresses: this machine, the local network, link-local, the cloud
  metadata service and Fly's private network are refused by address, so neither a name nor a redirect gets around it.
  It is the engines' twin of the browser's SOCKS gate (`server/browser/egress/`), with the same address policy.
- **Harness** (`server/bot-box/harness-gate.ts`): the server's own port inside the box reaches only `/api/internal/`
  routes, which every helper calls with a per-turn capability bearer. Every other route is answered `403` by the gate
  itself, so the server is never asked.

A box with the host's network (`net: "shared"`, for a browser whose Chrome already goes through its own gate) has
neither bridge.

## The sign-in relay

An engine that signs in through a callback on `127.0.0.1` (Antigravity's Google sign-in) listens on the box's own
loopback, which the server cannot reach. That box alone gets one more unix socket (`server/bot-box/relay.ts`), bound in
at `/run/omb/relay.sock`: the in-box Node bridge dials out to it and keeps one connection waiting, and when someone
pastes the redirect from another computer the server writes the callback's port on that connection and sends the
request through it. Only the server ever chooses the port, the box reaches nothing new on the host, and the server never
connects to a path inside the box.

## When it is on

`server/bot-box/detect.ts`: on by default on a Cloud home (`OMB_CLOUD_ROLE=home` or `team`), off everywhere else
unless `OMB_BOT_BOX=1`; `OMB_BOT_BOX=0` turns it off. It is never on without a working unprivileged bubblewrap: if the
kernel refuses user namespaces or the image has no `bwrap`, the box reports `off` with the reason, and the Admin shows
it. The cloud-home image installs `bubblewrap` and `socat` (the in-box bridges; without socat a bundled Node bridge does
the same).

Cost on Fly (measured, T0 build notes): about 5 ms and 3 MB per box, plus one socat per bridge.

## Tool caches

`server/bot-box/tool-caches.ts`, behind `OMB_CACHE_ROOT` (default off; `1`/`on` turns it on, only on a Cloud home, never
on a desktop). With it on, the box gives each process the tools' own cache variables, so what a bot's tools download
lands in one folder, `cache` in the box's HOME, instead of all over it:

| Variable | Folder under `<box HOME>/cache` | Was | It beats (config files) |
|---|---|---|---|
| `npm_config_cache` (npx too) | `npm` | `~/.npm` | `cache=` in `~/.npmrc`, a project's `.npmrc`, the global npmrc |
| `PIP_CACHE_DIR` | `pip` | `~/.cache/pip` | `cache-dir` in any `pip.conf` (global, user, a venv's) |
| `UV_CACHE_DIR` | `uv` | `~/.cache/uv` | `cache-dir` in `uv.toml` or a project's `pyproject.toml` `[tool.uv]` |
| `HF_HUB_CACHE`, `HF_XET_CACHE` | `huggingface/hub`, `huggingface/xet` | `~/.cache/huggingface/{hub,xet}` | none (Hugging Face reads only variables) |
| `BUN_INSTALL_CACHE_DIR` | `bun` | `~/.bun/install/cache` | not checked against `bunfig.toml` `[install.cache] dir` |

- **Where.** The box's HOME: `/data/cache` on a personal Cloud, `engine-homes/<audience>/cache` on a Team Cloud. So
  the folder is shared exactly as `~/.npm` and `~/.cache` already are (every bot of a personal Cloud; one audience on a
  Team Cloud, never another member's). It is under the HOME line of the plan, so no new mount is made: the bubblewrap
  arguments are the same with the switch on or off (pinned by a test). The app's own rebuildable files stay in the data
  folder's `cache/` (`NODE_COMPILE_CACHE`), which the box hides.
- **Only a folder the server made.** On the first spawn for a HOME (never at start), the server makes `cache` there and
  writes a `CACHEDIR.TAG` (the standard signature, plus a line naming OpenMausBot). A `cache` that is already there
  without that tag and with anything in it is the person's own: nothing is written in it, and that HOME's tools keep
  their own places. An empty one is marked and used (a start that made it may have stopped before writing the tag). A link
  named `cache` is never the server's. The cache cap (below) works only in a tagged folder.
- **A value in the environment wins; a value in a config file loses.** A cache variable the spawn was handed is kept:
  one an engine's saved environment or an MCP server's environment passes through `allowEnv`, and one a driver merged in
  without vouching (Claude's and Codex's instance environment), which goes back after the allow-list with its own value.
  On a Cloud home the server's own environment carries none of these names (`SERVER_ENV_NAMES`). A cache whose place
  something else the spawn was handed already decides is left alone: `XDG_CACHE_HOME` (pip, uv,
  bun, Hugging Face), `HF_HOME`, `BUN_INSTALL`. What an engine or a shell sets for its own children (an MCP server's `env` in
  the engine's config, an `export`) is set on top inside the box, so it wins too. But each variable beats the config
  files in the table's last column, because each tool ranks its environment above them:
  - what that costs is the place only: the tool downloads into ours what it would have found in the folder its config
    names;
  - what can fail: an install that must work offline from a cache folder a config file names (npm with `offline=true`
    or `--offline`, uv with `offline = true` or `--offline`). It fails as it would with an empty cache. pip's cache
    is never needed offline, and Hugging Face has no config file for its cache.
- **Left alone on purpose.** `XDG_CACHE_HOME` (Hugging Face keeps its login token under it, and engines write there),
  `HF_HOME` (the token), `CARGO_HOME` (credentials and installed programs), `GRADLE_USER_HOME` (properties that may hold
  keys), `PNPM_HOME`, `UV_TOOL_DIR` and `UV_PYTHON_INSTALL_DIR` (installed programs and the Pythons venvs point into),
  pnpm's store (a project's `node_modules` records it, and `npm_config_store_dir` makes every npm command warn), Yarn's
  cache (a Berry project may keep it in the repository), Maven (no variable but `MAVEN_OPTS`), and:
  - `PLAYWRIGHT_BROWSERS_PATH`: older `@playwright/mcp` releases (seen in 0.0.41, 0.0.70 and 0.0.75; 0.0.76 and later use
    `~/.cache/ms-playwright-mcp`) keep the MCP browser's profile (cookies, site sign-ins) in that folder, so moving it
    would sign the browser out;
  - `PUPPETEER_CACHE_DIR`: it beats a project's `.puppeteerrc`, so a project keeping Chrome in its own folder would stop
    finding it;
  - `GOMODCACHE`: it beats `go env -w GOMODCACHE`, and a project building offline from its module cache would fail;
  - `COREPACK_HOME`: its `lastKnownGood.json` records which package manager version is active, not only downloads;
  - `GOCACHE`: it also holds Go's fuzzing corpus (`fuzz/`), which `go clean -cache` keeps.
- **Nothing is moved or deleted.** The old folders stay; with the switch on, new downloads go to the new folder, and a
  tool downloads once more what the old folder held (an npx package, a model). Something run offline from the old place
  (`HF_HUB_OFFLINE=1` with a model there) fails until it is downloaded again. A later cleanup may delete the old folders
  in the table's third column.
- **Box off, no change.** A Cloud whose box is off (`OMB_BOT_BOX=0`, or no working bubblewrap) runs its bots unboxed
  with today's environment.

### Tool caches: the cap

`server/cache-sweep/`, behind `OMB_CACHE_SWEEP`. It is off by default; `1`/`on` turns it on, and only on a Cloud
home. With it off, nothing is read, started or deleted: no state file is read, no timer starts, and the two admin routes
are not there. With it on, making it at start reads nothing either; its first tick is 5 minutes after the server answers.

- **Caps.** The smaller of 10 GB and 15% of the volume (`limits.ts`), once for the tools' cache folders and once for the
  app's own `<data folder>/cache`. On a Team Cloud the tools' cap is split evenly between the cache folders there (the
  server's HOME and each audience's engine home), so one member's caches never push out another's. Overrides:
  `OMB_CACHE_CAP_TOOLS` and `OMB_CACHE_CAP_APP`, in bytes or as `4G`, `512M`.
- **Which folders.** Only a tools root the server made (its `CACHEDIR.TAG`, above), and only while the tools' switch is
  on and the bot box is live. In it, only these whole folders, by fixed name: `npm`, `pip`, `uv`, `huggingface/hub`,
  `huggingface/xet`, `bun`. Nothing else in a root is counted, listed or touched: not a
  person's own folder, not `huggingface/token`, and no browser's folder ever (a Playwright MCP profile holds cookies and
  sign-ins). In the app's own folder: each old `node-compile/<version>`, never the running server's.
- **Least recently written first.** A folder's age is its newest modification or change time. Access times are not
  used: a backup that reads the whole volume would refresh them. A folder written in the last 30 minutes stays. A
  folder that alone is over its root's cap is left and logged once, and not counted, so it does not empty the others on
  every pass; only a clear or the emergency pass removes it, so the cap does not bound such a folder (a Hugging Face
  hub with one large model is the likely one). `npm` goes whole: every npx-installed MCP server goes with it, and npx
  fetches each again the next time it starts it.
- **Never while a bot works.** In a tools root, nothing is deleted while a turn runs, an engine is kept warm, or any
  process the server started (directly or inside a box) uses that root: its working folder, program, open files, mapped
  files or environment name a path in it (`in-use.ts`, from `/proc`). Every bot process is one of the server's
  descendants (`--unshare-pid` and `--die-with-parent` keep even a bot's daemon in its box's tree), and every boxed
  process carries its HOME's cache variables, so any process a bot of that HOME started counts. A descendant that cannot
  be read counts as using every root (logged once); a process the server did not start is not looked at. This is checked
  before each folder goes. A busy home is tried again on the next tick, 5 minutes later; a pass that finishes waits an
  hour. The turn and warm-engine check is for the whole Cloud: on a Team Cloud one member's turn holds every root's
  pass (a process seen in one root holds only that root). Any long-lived bot process holds the cap for its root for as
  long as it runs: a dev server or a watcher a bot left running, an MCP server an engine keeps open. Nothing there is
  removed until it ends. A folder about to go is first renamed inside its own parent (below), so a tool that starts
  meanwhile finds it missing, not half there. What each tool then does with a missing cache folder is its own behaviour:
  npm, pip, uv and bun are expected to fetch again what they need; this was not tested for each.
- **Never outside the root.** Every walk and removal goes through open folders (`tree.ts`): the root is opened with
  `O_NOFOLLOW`, and each step names one child of an open folder through `/proc/self/fd/<fd>/<name>`, so the kernel
  resolves it from that open folder, never again by path. A link is never entered (`O_NOFOLLOW`), a folder on another
  filesystem is never entered, and `unlink`/`rmdir` act on the link itself. A folder above that a bot swaps for a link
  changes nothing. A folder about to go is renamed to `.omb-trash-<random>` in the same open parent (never moved
  elsewhere, never put back), then emptied and removed; whatever a removal that stopped part-way left under that name,
  the next pass in that root finishes the same way (a link there is removed as a link). A walk goes at most 128 folders
  deep, so a bot's endlessly nested folders cannot use up the server's open files or memory; what lies deeper stays.
  This needs Linux; anywhere else nothing is walked or deleted.
- **Emergency.** At 95% of the volume used, the tools' folders go, least recently written first, until it is under 90%,
  under the same rule: if a bot is working, nothing is removed, and one line is logged (the Admin's disk auto-grow and
  its alert cover a full disk). A pass that measured is not repeated within 30 minutes.
- **On demand.** `clearCaches({ dryRun, scope })` returns the bytes and folders that go, or would in a dry run, and how
  many roots were left because a bot was working. Its admin-scope route is `POST /api/caches/clear`, a dry run unless the
  body says `"dryRun": false`; `GET /api/caches` returns the counters. Both only with the switch on.
- **Counters.** `<data folder>/cache-sweep.json` (any shape reads; written whole by rename) keeps the cleared and
  emergency counters and the last pass; the storage report carries them once read.
- **Not touched.** The scattered caches from before the tools' folder (`~/.npm`, `~/.cache/*`, `~/go/pkg/mod`, …) are left
  for a separate cleanup.

## The self-check and the report

At boot, and by hand with `node dist-server/bot-box/box-check.js`, the server runs `box-probe.ts` inside a real box
over a fixture laid out like a data folder, with a canary process and a fixture server, and counts what a hostile bot
could and could not do (`server/bot-box/self-check.ts`). The Admin reads the result in the signed health report and at
`GET /api/cloud/box`: `{ box: "bwrap" | "off", checks: "23/23", failed: [], boxed, refused }`. Running the check with a
mutation (`--mutate=bind-data,share-pid,share-net,env-all,tmp-shared`) removes one protection and must fail exactly the
checks it guards.

## What it does not do yet

- **Local VM (Docker) computer use.** The computer MCP talks to the Local VM over the host's Docker socket. The box does not expose that socket (mounting it would be root-equivalent on the host), so with the bot box on a Local VM turn fails early with a clear message instead of "MCP server exited". Use this computer, a Cloud computer, or turn the box off for Local VM work.

- The engine's own subscription login is in its box, because the engine runs there and refreshes it; any program the
  bot runs in that box can read it. API keys stay in the environment until the credential broker (T0b) replaces them
  with per-turn tokens.
- Sign-in masks are fixed when a box starts. A sign-in file made after that (an engine signed in for the first time), or
  one a process outside any box replaces by renaming a new file over it, is readable in a box that was already running
  until that box's process ends. Engines whose sign-in is not in `ENGINE_FOLDERS` keep theirs in HOME, readable from
  every box. On a Team Cloud every audience's engine home holds a copy
  of every engine's team sign-in, so a box there reads all of them.
- The box runs as the server's own user inside a user namespace; a separate Linux user per bot needs a privileged
  spawn service (T0c notes).
- On a Team Cloud each Chrome of the bots' browsers runs in a box of its own (`BotBox.browserBox`, written into the
  launcher agent-browser runs, see [team-cloud.md](team-cloud.md)); the agent-browser daemon is not boxed, and on a My
  Cloud no browser is.

## The credential broker

Keys stay in the server process; boxes get tokens (`server/bot-box/broker.ts`). When a bot spawn is boxed, each provider
key in its environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`)
is replaced by a per-process token (`omb_t0_…`, random, bound to the bot and the conversation, 24 h at most, revoked
when the process exits), and the provider's base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`)
points at `http://127.0.0.1:18080/b/<token>/<provider>` inside the box, bridged to the broker's unix socket. The broker
drops whatever credential header the client sent, adds the real key, and forwards to the provider's fixed upstream
(the base URL the server had, or the provider's default); the box cannot choose the upstream. A URL MCP server's
headers ride the same way (`server/bot-box/broker-mcp.ts`): the turn's server list carries
`http://127.0.0.1:18080/b/<token>/mcp-<name>` with no headers, and that token is kept for the conversation's later
turns while the servers are the same, so a long-lived engine process keeps its MCP sessions. A URL server the engine
reports as failed when it started gets the conversation a new token on its next turn, so the engine starts again and
reconnects; the chat says the server didn't connect and that it connects again on the next message. A request for the grant
itself goes to the upstream exactly as it was given (a server at `/mcp` is reached at `/mcp`, never `/mcp/`, which a
Cloudflare Worker answers with 404), anything below it below that address, with the client's query beside the
upstream's own. MCP Settings → **Test** reaches a URL server the same way where turns are boxed
(`server/bot-box/broker-probe.ts`): a grant made like a turn's, through the broker's socket, revoked when the test
ends. A server that answers directly but not through the broker fails the test with "Your bots can't reach this
server", never "Connected", and says the fault is ours. A tool call a URL server refuses with HTTP 401 is answered by the
broker as a failed tool result that names the server and what to do (`server/bot-box/broker-mcp-refusal.ts`): passed through,
the 401 starts the engine's own sign-in, which cannot work because the broker drops any `Authorization` the engine sends, and
Claude Code then says only "Error dialing <address>", since the address holds a token. When nobody signed in and the server
is one a connected app covers (Gmail or Google Calendar, known by its address or name, `server/mcp-server-app.ts`), and the
turn can use that app, the answer offers the app's connect card first, or says to use the app when it is already connected.
Connected apps (Composio) were already behind the harness
(`/api/internal/connectors/*` with a per-turn bearer) and stay there.

A key whose CLI takes no base URL from the environment (xAI, Mistral, Groq, Greenference, ModelGo, Cerebras, MiniMax, Kimi, Cursor, Factory,
Cline, OpenCode, OpenRouter's own variable) stays raw in that box, and the report names it under `broker.unbrokered`,
so the gap is visible. The self-check adds six broker checks (29 in all): the key is nowhere in the box's environment
or files, the base URL is the broker, a call with the token reaches the upstream with the real key, a wrong token is
401, a grant the token lacks is 403.

## What each layer stops

| Layer | Where | What it stops | What it does not stop |
|---|---|---|---|
| Mount namespace (bubblewrap) | every boxed process | reading the server's data folder, other bots' folders, other turns' files in `/tmp`, `/.fly`, other engines' and accounts' sign-ins in HOME; writing anywhere but its own folders | reading the engine's own login in HOME (its identity) and sign-ins of engines outside `ENGINE_FOLDERS`; a path a driver puts back on purpose |
| PID namespace | every boxed process | seeing, reading the environment of, or signalling another turn's or the server's processes | nothing inside the same box |
| Network namespace + the two gates | every boxed process with its own network | reaching this machine's other listeners, the local network, link-local, metadata, Fly's private network; any route out except the egress gate; any server route except `/api/internal/*` | what the harness routes allow with a valid per-turn bearer; a public destination |
| Environment allow-list | every boxed process | `OMB_CLOUD_*`, the server's placement, workspace credentials, any `OMB_*` setting a boxed process does not read, any unlisted name | the engines' own settings |
| Credential broker (T0b) | every boxed process with its own network | holding a provider key or an MCP header; using a token after its process or conversation ends; choosing the upstream | keys with no base-URL setting (named in the report); subscription logins |
| seccomp filter (T0c) | every boxed process on x86-64 | 34 system calls that only reach the kernel's attack surface: mount family, kernel modules, bpf, perf, userfaultfd, the kernel keyring, `open_by_handle_at`, `setns`, kexec, reboot, swap, clock setting, I/O ports (EPERM); a process of another architecture (killed) | anything an engine, shell, git, npm, python or Chrome uses: all allowed |
| `hidepid=invisible` on the host's /proc (T0c) | the whole machine, set by the root supervisor at boot, which then starts itself again through `setpriv` without CAP_SYS_ADMIN and CAP_SETPCAP (an own server's connector grants those two only for that remount, and only to an image that drops them) | a `maus` process outside a box (the browser engine, a helper) listing or reading root's processes | `maus` processes seeing each other; a box has its own /proc anyway |
| `/.fly` root-only (T0c) | the whole machine | a `maus` process reaching Fly's local API socket | nothing else |

Not built, and why: a **separate Linux user per bot**. The server runs as `maus` under a root supervisor and cannot
switch uid; a per-bot uid needs a privileged spawn service (stdio over FIFOs, kills by proxy, file ownership across
everything the server reads from the workspaces) which is a slice of its own, and with the user namespace the host
sees the box as `maus` anyway. **nftables** rules would add nothing to a box with its own network namespace, and for
the whole machine they would have to allow Fly's resolver on the private network; left for the separate-user design.
`OMB_CLOUD_HARDEN=0` skips the two supervisor steps if a machine ever needs that.
