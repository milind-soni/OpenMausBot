# Lent MCP: streams over the device link, and per-server Allow on the computer

Written against `origin/main` at 1bc4749aa (A: PR #4640 and its follow-ups). PR #4744 (`fix/lent-mcp-own-ports`) and
PR #4745 (`fix/lent-mcp-no-computer`) are expected to merge first; this design keeps both: the ≥1024 / never-the-own-ports
rule moves into the computer's door (`ownPorts` from #4744 is reused as is) and stays in `lentState` / `place()` on My
Cloud, and `place()` still refuses a server that needs a computer when none is lent.

## Intent

While OpenMausBot's home is My Cloud, its bots use MCP servers on the person's lent Mac or PC. Main ships this (A) by
making every `tools/list` and `tools/call` a lending job on the computer's one-job-at-a-time queue. That works, and
Omkar decided (2026-11-07) to keep A and bring two pieces of the unmerged stricter build (B) onto it:

1. **MCP traffic moves off the job queue onto the device link, as streams.** Calls run side by side with each other and
   with lending actions, nothing waits 30 s behind a `run_command` and fails as busy, no call has a 300 s cap, a turn
   ending no longer kills the child every conversation shares, and the whole protocol crosses (SSE, notifications, the
   server's own requests, resources, prompts, the old SSE transport).
2. **The computer asks its person before it runs or reaches a server for My Cloud.** A lending switch "Your MCP
   servers" (off by default) plus a one-time native Allow / Don't allow prompt per server, naming the port or the
   command with secrets hidden, remembered on the computer; a "no" held 10 minutes per name and per target; one prompt
   at a time.

Controller ruling on commands: A can run a command server that was added on My Cloud, and that stays, under consent. A
command runs on the computer only after the person allowed that exact command there (fingerprint of command, args and
env names), wherever its definition came from. The computer never runs a command the person did not allow on it.

## Goals

- A bot on My Cloud reaches a `runsOn` server of the owner's lent computer through the computer's device link: a URL
  server as an HTTP replay onto `127.0.0.1:<port>`, a command server as a stdio child whose stdin/stdout is the stream.
- Two calls to one server, or to two servers, run at the same time, and while a `run_command` runs.
- A command server's child lives per conversation (thread) between calls and turns, and ends on the engine's `DELETE`,
  after 10 quiet minutes, when the computer's link drops, or at shutdown.
- The person turns MCP lending on from the lending menu and allows each server once; a port change or a command change
  asks again. Turning the switch off forgets every Allow.
- The bot, the connection test and `mcp_server test` say in plain words which case failed: offline, not lent, not lending
  MCP, waiting for Allow, declined, no such definition, didn't answer, too old.
- An older computer (no `mcp` field in its registration) keeps A's job path unchanged.

## Non-goals

- Team Clouds, other people's computers, phones, OAuth sign-in for a lent server: all as in A.
- Changing where a server's definition lives. My Cloud's saved copy is the only definition, as in A; the computer does
  not read its own `config.json` for this (B did).
- Settings copy ("Runs on X, so it isn't started here") and the McpServersPanel: unchanged.
- Dropping a thread's sessions when a turn's memory changes (B's `onClaim`): the thread, not the turn, owns the session.

## Anti-goals

These are failures even if everything else works:

- The computer takes My Cloud's word alone. The Allow on the computer, and the switch, are the only authority for what
  starts or is reached there; My Cloud's registration and the open frame are requests.
- A saved env value, a saved header value, or a child's stderr reaches a bot-visible text, a link control frame, a door
  body, a lending activity row, or a log. (Header values ride inside the HTTP request bytes replayed to the server on the
  computer, as that server's own traffic, exactly as A's job carried them; env values reach the computer only over its
  authenticated API, in memory, for the child's environment.)
- Anything silently falls back: a computer that sent `mcp: false` is never served by jobs; a refused stream is never
  retried another way; a command never runs under a different definition than the one allowed.

## What changes in A

### Wire

- Registration (`server/shared-computers.ts` `sharedComputerRegistration`) gains `mcp: z.boolean().optional()`: the
  computer can take MCP streams, and its switch is on (`true`) or off (`false`). Sent only to a server that advertises
  the new capability `lentMcpLink` (`server/environment.ts`; same condition as `myChromeLink`). A's `mcpServers: true`
  and `environments` stay and are still sent.
- The device link's open frame gains a third kind: `{ mcp: { name, port } }` for a URL server and
  `{ mcp: { name, fingerprint } }` for a command server (`electron/device-link-protocol.mjs`, B's `openTarget`).
  Nothing else crosses in the frame.
- A new computer-authenticated route, `POST /api/shared-computers/:id/mcp-server` `{ name }` → `{ server }` with A's
  `lentDefinition` of that one command server (command, args, env), 404 otherwise. URL servers are never served here.

### My Cloud

- `DeviceLinks.mcpRoute(person, computerId)` picks the open link of that computer when it lends `mcp` (`LinkedComputer`
  gains `id` and `mcp`). Changing `mcp` in a re-registration drops the link, as Chrome does.
- `SharedComputers.runsOn().online` gains `mcpLink: boolean | null` (null: an older computer).
- `server/lent-mcp.ts` keeps its place and surface (`mounts`, `lines`, `route`, `test`, `place`) and grows a second path
  chosen per computer: `mcpLink === null` → A's job path, untouched; otherwise streams. On the stream path `route()`
  takes GET, POST and DELETE at `/api/internal/lent/mcp/<name>` behind the turn bearer A already mints, and:
  - URL server: opens `{ mcp: { name, port } }` and replays the request with `http.request({ createConnection })`,
    path prefix stripped, `Host` rewritten, `Connection: close`, the response streamed back SSE included, and an SSE
    `endpoint` event re-prefixed so the old SSE transport's POSTs come back through the door.
  - Command server: one `StdioSessions` per thread and server (B's `server/lent-mcp-stdio.ts`), speaking Streamable
    HTTP to the engine and one JSON line per message to the child.
  - A refused or failed open answers the bot the way A does today: a JSON-RPC error, or a `tools/call` result with
    `isError`, whose text is the plain-words line for that case.
- `mounts()` mounts a URL server with its own `type` (`http` or `sse`), so the old SSE transport is carried.
- `test()` on the stream path serves the same handler on an ephemeral loopback `http.Server` and probes it with
  `probeMcpServer`, so the test runs exactly what a turn runs.
- `lentState` gains `not-lending` (switch off) and `lentLine` gains its sentence; the per-call cases (`needs-approval`,
  `declined`, `no-server`, `unreachable`) have their own lines.
- `sharedComputerScopeRefusal` refuses an `mcp_tools`/`mcp_call` job for a computer that sent `mcp` at all.

### The computer

- `electron/device-mcp.mjs` (from B, adapted): `createMcpDoor({ approvals, prompt, ownPorts, definition, … }).open(target)`
  → `{ socket } | { refused } | { failed }`. A URL target checks the port (1024–65535, not `ownPorts()`), then the
  approval `{ kind: "url", port }`; a command target fetches the definition from My Cloud, checks its fingerprint
  equals the frame's, then the approval `{ kind: "command", fingerprint }`. No approval: show the prompt without waiting
  and refuse `needs-approval`; a no holds 10 minutes under the name and under the target and refuses `declined`; one
  prompt at a time. Allowed: connect `127.0.0.1:<port>`, or spawn with A's `windowsLaunch`, `inheritedEnvironment` and
  `commandPath()`, stderr ignored, process group killed when the stream ends (`taskkill /T` on Windows).
- `electron/lent-mcp.mjs` keeps `ownPorts`, `windowsLaunch`, `inheritedEnvironment`, `ownEnvironmentIds` and loses the
  job client (`createLentMcp`, `stdioClient`, `httpClient`, `answerOf`, `validLentMcpServer`). An `mcp_tools` /
  `mcp_call` job from a My Cloud too old to use the link is answered with one plain sentence.
- `electron/computer-sharing.mjs` (from B): the `mcp` grant beside `chrome` in `cloudGrant`, `automaticGrant`,
  `lendsAsWanted` and `lends()`; `lendMcp(on)` and `mcpApprovals` persisted in `computer-sharing.json`, approvals
  cleared when the switch goes off; the connect body sends `mcp` to a Cloud that advertises `lentMcpLink`; the link is
  kept open while MCP is lent; a stream's outcome is recorded as a `mcp` activity row naming the server.
- `electron/lending-dialogs.mjs` `allowMcpServer({ name, target })` (B's), defaulting to Don't allow;
  `electron/lending-indicator.mjs` checkbox "Let My Cloud use your MCP servers on this {device}".

## What A keeps

- `place()`: a loopback or home-folder server added on My Cloud is marked as running on the lent computer, the bot asks
  which computer when several are lent, and (#4745) none lent is refused at add time; (#4744) a port below 1024 or none
  is refused.
- Plain-words lines: `offline`, `stopped`, `never`, `outdated` ("too old", for a computer without `mcpServers`),
  `no-terminal` (job path only: on the stream path the Allow names the exact command and the terminal switch is not
  consulted), `port`.
- `needsTheirComputer`, `elsewhereServers`, the 10-minute tools listing cache (job path only), the mount URL and bearer,
  Windows argument escaping (`windowsLaunch`), the job path for every other lending action, other homes (a non-Cloud
  server with lending still uses jobs; `lentMcpLink` is advertised only by a personal Cloud home).

## Rollout

- My Cloud ships first. It advertises `lentMcpLink`; a computer sends `mcp` only when it sees that. An older computer
  never sends `mcp` and is served by A's jobs as today. A newer computer against an older My Cloud sends nothing new and
  refuses MCP jobs with a sentence, since consent lives on the stream path only.
- Existing people: after updating, command servers that worked through the lent terminal stop until the person turns
  on "Your MCP servers" and allows each one. That is the decided default (off, with a prompt), and the bot says so.

## Left to the builder

- Exact prompt wording beyond the content above, and the menu item's position (next to the terminal item).
- The body of the replay and the ephemeral test server, within the signatures the plan gives.
- Test layout beyond the plan's named tests.
