# OpenMausBot threat model

Guidance for automated security scanning (Anthropic OSS Scanner). The scope
notes in `/src/SECURITY.md` and the documents named below describe the same
boundaries in more detail. Where they disagree about intended behaviour, the
section "Intended behaviour, not vulnerabilities" below reflects the current
product decisions.

## What this project is

OpenMausBot runs AI agents, called **bots**, on a person's own computer or
server. A bot is a conversation plus settings that drives an **engine**: a
real agent CLI (Claude Code, Codex, Grok, Gemini, Cursor, OpenCode, ACP
agents) or an API-key chat-completions provider. Engines run as child
processes with the person's own OS privileges.

The same TypeScript **harness server** (`server/`) runs in four places:

- **Desktop app** (`electron/`, macOS, Windows, Linux). The app starts the
  server on `127.0.0.1` and shows the web UI (`src/`, React) in its window.
- **Self-hosted server** (`openmausbot serve`, from npm or the root
  `Dockerfile`). People pair browsers, desktops and phones with it.
- **Hosted or shared workspaces.** Several people sign in to one server
  (email sign-in, members, `openmausbot fleet`). Members and roles live in
  `enterprise/`, and the hook point is `server/enterprise.ts`.
- **MausBot Cloud home.** Each customer gets one Fly app with one machine
  (the `cloud-home` stage of the root `Dockerfile`, plus `deploy/fly/`). Caddy
  terminates TLS, and the server stays on loopback. See `docs/cloud-pro.md`.

Bots have tools:

- the engine's shell and file tools;
- a per-bot Chrome (agent-browser) whose traffic goes through an egress gate;
- computer use: the local desktop, a local VM, and paid cloud computers;
- MCP servers, both custom ones and the harness's own;
- Composio connected apps, through `cloudflare/composio-broker/`;
- routines (scheduled turns), rooms (several bots in one conversation),
  webhooks and app-event triggers;
- file-based memory, saved website logins and 1Password;
- a phone companion (`companion/`), reached over the LAN, Tailscale, or a
  managed Cloudflare tunnel (`cloudflare/control-plane/`,
  `electron/managed-companion-tunnel.mjs`).

## Trust boundaries

1. **Loopback-only server.** The harness server binds `127.0.0.1` and never a
   public interface. `server/request-auth.ts` decides every request:
   - A request is "loopback" only if `Host` is loopback, `Origin` is absent
     or loopback, and it carries no proxy headers (`X-Forwarded-*`,
     `Forwarded`).
   - A request on an IPC listener, such as the tunnel socket
     (`OMB_TUNNEL_SOCKET`), is never loopback.
   - A browser never gets loopback trust. That covers any request with
     `Sec-Fetch-Site` or `Sec-Fetch-Dest`, and any WebSocket handshake with an
     `Origin`. A web page on the same machine, including a page a bot opened,
     must sign in.
2. **Desktop per-launch capability and paired sessions.**
   - In the desktop app, every public loopback mutation must carry the app's
     private per-launch token (`x-openmausbot-desktop-owner`), which only the
     app's own window sends. GETs that cause effects are classed as
     mutations (`mutatingPublicRoute`).
   - Off-machine access needs a **paired session**: a bearer token, or a
     cookie that only works same-origin.
   - A session has the `admin` scope or the `client` scope. `client` is
     default-deny: it reaches only the routes in `CLIENT_ALLOW`.
   - Pairing codes are single use and short lived (`server/sessions.ts`,
     `server/cli-pairing.ts`).
3. **Per-turn bot capabilities.**
   - A bot's integrations reach the server through `/api/internal/*`, with a
     bearer minted per bot, thread and kind (`mintInternalCapability` in
     `server/index.ts`).
   - The record behind the bearer is honoured only during that thread's
     active turn. It is revoked when the turn ends or a newer turn starts.
   - One bot or turn must never act with another's capability.
4. **`SERVICE_ALLOW` on shared servers.**
   - On a hosted workspace, or with `OMB_LOOPBACK_TRUST=service`, every bot's
     shell is a loopback caller.
   - A loopback request without a session may use only the routes in
     `SERVICE_ALLOW`.
   - It must not reach admin routes, settings, keys, people, sessions or
     pairing, and it must not approve or answer a card.
   - A Cloud home always uses `service` trust.
5. **Phone and tunnel pairing.**
   - The companion sidecar (`companion/src/`) is the only thing a phone talks
     to. Pairing uses a QR credential or a six-digit fallback; both are
     single use and short lived.
   - Device tokens are stored as SHA-256 digests. Every forwarded route is on
     a default-deny allowlist (`companion/src/routes.ts`), and requests that
     carry an `Origin` are refused.
   - The pairing page (`companion/src/control.ts`) is loopback-only and needs
     a per-launch token.
   - The managed Cloudflare tunnel reaches only the desktop's own gateway
     on `:8812`, or the server's tunnel socket (`openmausbot serve --tunnel`,
     `OMB_TUNNEL_SOCKET`). It never reaches the LAN listener on `:8810`.
     Requests that arrive over the tunnel socket always need a paired session.
6. **Egress gate for bots' browsers** (`server/browser/egress/`).
   - Every connection a bot's Chrome makes goes through a SOCKS5 gate on
     loopback. The gate resolves names itself and checks every address before
     it connects.
   - These are always refused, on every host: OpenMausBot's own ports,
     link-local addresses, cloud metadata (`169.254.169.254`,
     `fd00:ec2::254`, `100.100.100.200`) and reserved ranges.
   - The local network (including `fc00::/7`, which holds Fly's private
     network) is closed on self-hosted servers unless
     `browserEngine.egress.allow` lists it, and always closed on Cloud.
   - Other loopback ports open only to servers the bot's own processes
     started.
   - The full table is in `docs/browser-packaging.md`, under "What a bot's
     browser can reach".
7. **Untrusted content reaching tools.** All of these are untrusted, and may
   try to steer a bot (prompt injection):
   - web pages a bot opens;
   - search and tool results, MCP responses and Composio data;
   - files, email, webhook and app-event payloads;
   - messages from other bots in a room.

   The harness itself must not let such content get past the boundaries in
   this list. For example, a saved password is never given to the bot or to
   page scripts (`server/login-fill.ts`, `server/browser-secret-hold.ts`).
   Bot and tool output that the web UI renders (Markdown, Mermaid, KaTeX,
   Vega, links, file names) must not run script in the UI.
8. **Write-only secrets.**
   - Provider API keys and tokens live in `config.json` (mode 0600), and the
     API reports only whether each is configured. Saved logins and the
     1Password token are in a separately sealed store (`server/login-store.ts`).
   - On a Cloud home, launch secrets come over a pipe, never the environment
     (`server/cloud-secrets.ts`).
   - Text that crosses a boundary is redacted (`shared/redact.ts`).
9. **Per-bot workspaces and memory.**
   - Each bot's workspace (`~/.openmausbot/workspaces/<botId>`) holds its
     memory. Harness tools such as memory, `session_search`, recall and the
     recent-work brief must return only the calling bot's own conversations
     and the rooms it belongs to.
   - A member session must see only the bots shown to that member.
   - Paths that the harness builds from IDs or from request input must stay
     inside the intended directory.
10. **Cloud tenant isolation.**
    - Each Cloud customer has its own Fly app, volume and private network.
      Pairing on a home opens only for a request signed with that machine's
      secret (`/api/cloud/pairing`).
    - The Cloudflare Workers `cloudflare/control-plane/` and
      `cloudflare/composio-broker/` serve every installation. One
      installation's credential must never read or act on another's
      endpoints, tunnels, Composio sessions or trigger events.
11. **Webhook ingress.**
    - Webhooks arrive on a separate listener (`OMB_WEBHOOK_PORT`;
      `server/webhook-ingress.ts`, `server/webhooks.ts`).
    - Each hook has its own random secret, stored only as a SHA-256 hash and
      compared in constant time.
    - A bot that creates a webhook never sees its secret.

## Intended behaviour, not vulnerabilities

These are deliberate product decisions. Do not report them.

- **Full access is the default approval level** (`DEFAULT_APPROVAL_MODE` in
  `shared/approval-mode.ts`). At Full access each engine runs in its own most
  permissive mode. Where an engine has no such mode, the harness answers the
  permission requests it leaves.
- **OpenMausBot adds no approval prompts of its own.** Approvals belong to
  each engine's native permission system, at the level the person picked.
  When a bot changes its own routines, skills, webhooks, profile or model,
  the change applies at once and the conversation gets a receipt with Undo,
  not a confirmation card.
- **Bots may start or wake paid cloud computers** and spend within the
  configured budgets without asking.
- **A bot may run shell commands on the person's own machine at Full access.**
  That includes commands a web page or document suggested: the model chose
  to act, within the engine's permission mode.
- **Anything the signed-in owner can already do through the UI is not
  escalation.** That covers the desktop app, an `admin` session, and the
  owner of an owner-trust server.
- **The owner's installed code is trusted.** Engines, MCP servers, skills
  and plugins the owner installed, the owner's configuration, and the process
  environment are all trusted.
- **Per-bot workspaces are directory organisation, not a shell sandbox.** On
  one machine, every bot's shell runs as the same OS user. One bot's shell
  reading another bot's files, or reading engine logins under the same user,
  is expected. Doing the same through a harness API or tool is not (see
  boundary 9).
- **Documented limits.** These are known. Report only a way past them:
  - On a self-hosted server with the default `owner` trust, any local
    program that can reach `127.0.0.1:8799` has full control
    (`docs/self-hosting.md`).
  - On the desktop, anonymous non-browser loopback reads are allowed;
    mutations need the desktop capability.
  - Under `service` trust, a bot's shell keeps the Slack worker's guarded
    routes. It can therefore post into an existing Full-access thread, or open
    one while shared Full access is on. The planned fix is a worker-only relay
    token.
  - On a shared workspace, files that the server's OS user owns
    (`config.json`, the engine environment) are readable from a bot's shell.
  - The companion's direct LAN path and pairing over plain HTTP are
    cleartext, and documented as trusted-network-only.
  - On the desktop, bots' browsers reach the local network and this
    computer's other ports by default. The person can turn that off.

## What we care about

- The server reached from off the machine without a paired session: proxy
  or Host confusion, DNS rebinding, the tunnel socket, the webhook port, or
  the companion.
- One bot or turn reusing another's capability, or a capability outliving
  its turn.
- Another local, unprivileged OS user driving the desktop app, the companion
  control page, or a `service`-trust server.
- A web page or tool result making a bot use credentials or act outside what
  the person asked, beyond what the engine itself allows. Examples:
  - filling a saved login on another origin;
  - reading a saved password or a 1Password value;
  - getting around `browser-secret-hold`;
  - reaching `/api/internal/*` or the admin API from a bot's browser;
  - script injection into the web UI.
- Secrets echoed back in an API response, an SSE event, a log line, a chat
  message, or the argv or environment of a child process that should not
  have them.
- The egress gate bypassed to reach loopback services, the LAN, link-local
  addresses or cloud metadata. Routes to try: redirects, DNS rebinding,
  IPv4-mapped, NAT64 or 6to4 addresses, WebRTC, agent-browser fetching
  directly, or DevTools ports.
- Bypasses of pairing, sessions or the tunnel: code reuse, fixation, scope
  confusion between `client` and `admin`, or a cookie session used
  cross-origin.
- Path traversal out of a bot's workspace, the data directory, attachments,
  evidence or exports, or archive extraction (`tar`, skill and package
  imports).
- SSRF from server-side fetches whose URL comes from a remote party rather
  than the owner. Examples:
  - MCP OAuth discovery metadata (`server/mcp-oauth-discovery.ts`,
    `server/mcp-oauth.ts`);
  - skill and package imports (`server/skill-fetch.ts`);
  - URLs inside connector, webhook and app-event payloads.

  URLs the owner configured (custom MCP servers, provider base URLs) are
  trusted.
- Cross-tenant access on hosted workspaces, fleet installations, Cloud homes,
  or the two Workers.
- Webhook or app-event authentication bypass, and replays that start bot
  turns.
- A user-influenced string reaching a shell (`shell: true`, or a command
  string built for `cmd.exe`).

## How to rate severity

- **Critical:**
  - remote code execution without authentication;
  - unauthenticated access to the server from off the machine;
  - cross-tenant data access (another Cloud customer, another fleet
    workspace, or another installation in a Worker).
- **High:**
  - disclosure of a stored secret;
  - a pairing or session bypass;
  - one bot or turn reusing another's capability;
  - egress-gate bypass to the LAN or cloud metadata;
  - script injection into the web UI from bot, tool or web content;
  - a page obtaining or misdirecting a saved login.
- **Medium:**
  - issues that need a local unprivileged user;
  - issues that need a specific opt-in configuration, such as an
    `egress.allow` entry, a non-default trust setting, or the LAN companion
    path.
- **Low:** hardening, defence in depth, and denial of service that needs a
  session or local access.
- **Prompt injection** is rated by what the engine-independent harness lets
  through, not by what a model might choose to do. "The model obeyed a page
  and ran a command at Full access" is intended behaviour. "A page made the
  harness hand over a credential, cross a boundary above, or skip a
  permission decision at a level below Full" is a finding.

## Components that matter most and least

- **Most:**
  - `server/request-auth.ts`, `server/sessions.ts`, `server/cli-pairing.ts`;
  - the router and internal capabilities in `server/index.ts`;
  - `server/browser/egress/`;
  - `companion/src/`;
  - `electron/` (preload, the companion origin gateway, the managed tunnel);
  - `shared/redact.ts`, `server/config.ts`, `server/login-*.ts`;
  - `server/webhook*.ts`;
  - `server/cloud-*.ts` and `deploy/fly/Caddyfile`;
  - `cloudflare/`;
  - `enterprise/server/`.
- **Less:**
  - `src/` (the web UI): in scope for script injection and for CSRF against
    the server;
  - `scripts/`: build and release tooling.
- **Out of scope:**
  - `apps/docs/` (the documentation site), `evals/`, and test fixtures under
    `server/testing/`;
  - `third_party/` (vendored upstream code), unless OpenMausBot's own use of
    it creates the issue;
  - the mobile apps and the Cloud Admin, which live in other repositories;
  - CI workflows under `.github/`.

## How to exercise it

The image holds the full checkout at `/src`, with every workspace's
dependencies installed by `pnpm install --frozen-lockfile`. It also has the
bundled server (`dist-server/`) and the web UI (`dist/`). There is no
Electron runtime, no bot browser (Chrome), and no engine logins. The test
suite drives fake engine CLIs (`server/testing/fake-*`), so it needs no model
and no network.

```sh
cd /src
pnpm exec vitest run server/request-auth.test.ts server/request-auth.e2e.test.ts
pnpm exec vitest run server/browser/egress/
pnpm exec vitest run companion/
pnpm exec vitest run server/webhooks.test.ts server/webhook-ingress.test.ts
pnpm broker:test                                             # composio-broker Worker
pnpm --filter @openmausbot/control-plane test                # control-plane Worker
```

The whole suite runs one file at a time and takes over an hour, so run
focused files. Tests that need a real Electron binary, Chrome or a display
cannot run here. Some skip themselves; for example
`server/browser/egress/hostile-pages.e2e.test.ts` skips without
`OMB_TEST_CHROME`. Every test file gets its own throwaway `HOME`.

To reproduce against a live server, run it from source with a throwaway data
directory. It prints a pairing code:

```sh
D=$(mktemp -d)
node --experimental-strip-types server/openmausbot.ts serve --data-dir "$D" --port 8799 --no-open &
curl -s http://127.0.0.1:8799/api/health
```

Set `OMB_LOOPBACK_TRUST=service` to act as a shared workspace. Send a
`Sec-Fetch-Site` header to act as a browser.

## Reports and patches

- Give a minimal reproducer against the server
  (`server/openmausbot.ts serve --data-dir <tmp>`), as a script or a few
  `curl` commands, and say which host type it needs: desktop, self-hosted,
  `service` trust, or Cloud.
- State the boundary crossed (from the list above), the attacker's starting
  position, and the observed impact.
- Give a patch as a unified diff, with a focused vitest test next to the
  module it changes, that fails before the fix and passes after it.
- Write in plain language. Reports go privately to the contact in this
  enrollment, which is the address in `SECURITY.md`. Do not open public
  issues or pull requests for vulnerabilities.
