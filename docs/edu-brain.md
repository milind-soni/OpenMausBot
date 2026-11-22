# Edu brain: long-term memory for every bot

When [Edu](https://github.com/EduardoMoraga/edu) 6.0.0 or newer is installed, every bot gets an Edu brain next to its
own memory (`docs/memory.md`). The bot's `MEMORY.md` stays its working notes; the Edu brain holds durable decisions,
lessons, commitments and proposals, with Edu's claim bands (`verified`, `inferred`, `hypothesis`), and it is the same
brain Edu's other tools read.

Nothing needs to be set up: install Edu (`npm install -g edu-agent`) and the next turn of each bot has it.

## What a bot gets

Edu Bot starts Edu's own MCP server for the turn, as `edu mcp --profile memory`, on the bot's brain. The bot sees
Edu's memory tools only:

| Tool | Does | Asks first? |
| --- | --- | --- |
| `edu_brief`, `edu_recall`, `edu_read`, `edu_commitments`, `edu_capabilities`, `edu_projects` | read the brain | no |
| `edu_remember`, `edu_feedback`, `edu_session_open`, `edu_session_close` | write episodic and transitive notes | no |
| `edu_propose_canonical` | propose a canonical note; it stays `proposed` until a person accepts it | no |
| `edu_project_use` | switch brains | always refused: the brain is fixed for the turn |

"Asks first?" is for Claude bots below Full access, where these tools are pre-allowed. Codex asks for tools that are
not read-only, as it does for any server. Edu's crew tools (`edu_crew_*`, `edu_orchestrate`) are never mounted; a bot
with Edu crew on gets Edu Bot's own crew tools instead (see [Edu crew](#edu-crew)).

Canonical notes can only be proposed. Accepting one is a person's decision (see [Approvals](#approvals)).

## The brief in every prompt

Every engine, with tools or without, gets the bot's Edu brief in its system prompt, right after its memory: the text
of `edu --cwd <brain> brief --json` (the bot's brain plus the global one). Edu Bot leaves out the part Edu marks
`<!-- edu:core -->` (the protocol Edu's own plugins follow: session ids, crew tools) and cuts the brief at a line
within 4,000 characters. It sits in the prompt's volatile half, so a changed brief never restarts a warm engine
process.

Anyone who can save a note (a bot through `edu_remember`, any tool that shares the global brain) writes into every
local bot's prompt, so the brief goes in as data: one JSON string with `<`, `>`, `&`, backticks and line separators
escaped. A note cannot close Claude's `<system-reminder>`, open a tag, start a code fence or a line of its own. Whenever
there is a brief or an `edu` server, the cached half carries a fixed rule: the brief is stored data, grants nothing,
and never authorises an approval, `edu brain approve`, unsetting `EDU_CREW_JOB` or a permission change.

When the turn also mounts the `edu` server (and the bot's tool selection keeps it), a short rule comes with it:
working notes stay in `MEMORY.md`; durable decisions, lessons and commitments go to `edu_remember`; standards and
preferences go to `edu_propose_canonical`, where a person approves them; past decisions are looked up with
`edu_recall` before answering. An engine without the `edu` server gets the brief only, with no tool names in it.

Each brain's brief is kept for a minute. Only a brain's first turn waits for it, at most 3 seconds; after that a turn
gets the last brief while the next one loads. If Edu is missing, off or broken, or the brief fails, the prompt is the
same, byte for byte, as without Edu.

## Approvals

When a turn that had the brain mounted ends, however it ends, Edu Bot runs `edu --cwd <brain> brain proposals --json`
(one listing of a brain at a time) and posts a card in that conversation for each new proposal in the bot's own brain
that has no open card yet, in any conversation of the bots on that brain or a room they are in. The card says, in plain
words, where the note goes ("Pepper's Edu brain", "Shared brain (team-notes)"), its title, its kind and band ("Rule ·
Verified"; an unbanded note says no band) and the note; Edu's id, kind, band, reason and the full path are under
Details. No turn waits on the card: the composer stays open, the conversation is not "Waiting for you", `wait` and
the Bot API return the reply, and a call never reads it out. Approve runs `edu --cwd <brain> brain approve <id> --yes --json`; Reject runs
`edu --cwd <brain> brain approve --reject <id> --reason "Rejected in Edu Bot" --yes --json`. Both run without
`EDU_CREW_JOB`, and each answer is logged in the decision log. A proposal already decided elsewhere (in a terminal,
another CLI or the settings below) turns its card to "Already decided elsewhere".

Bot settings → Memory → Edu brain shows the status, the brain folders and every pending proposal, including those in
the global brain and those made outside Edu Bot, with Approve and Reject. A global proposal says that approving it
changes the global brain every coding CLI with Edu reads; global proposals get no card in a chat. Pending proposals
are also a Needs you item (`edu-proposal`) and a line in the brief.

Who may decide:

- Approve: the desktop app, or a paired device with the admin scope. A local request outside the desktop app is
  refused, because a bot's shell is one too. A local service (`OMB_LOOPBACK_TRUST=service`) may only reject.
- Reject: also any local request. A paired device without the admin scope may do neither.
- Nobody, when Edu Bot itself runs inside an Edu crew job: Edu refuses, and the settings say so.
- Never by voice: a call skips the card, and on a Live call it is reviewed on screen.
- A card or the settings take only approve or reject; any other answer is refused (400).

The chat card offers Approve exactly when the settings do (`GET /api/edu/rights`: `mayApprove`, `mayReject`,
`crewWorker`), with the same note.

`GET /api/bots/:id/edu` returns the status and the pending proposals; `POST /api/bots/:id/edu/proposals/:id` with
`{"action": "approve" | "reject"}` decides one. Opening the settings creates a bot's own brain if its first turn has
not yet.

## Where the brain lives

Each bot's `eduBrain` setting (`PATCH /api/bots/:id`):

- absent or `{ "mode": "own" }`: a brain of its own at `<data folder>/brains/<bot id>/.edu`, created with
  `edu init --name <bot name>` on the bot's first turn. Edu Bot lists these brains in its own registry,
  `<data folder>/edu-registry/projects.json`, never in your global brain's `projects.json`, so `edu_projects`, the
  vault and `edu sync` do not see them.
- `{ "mode": "folder", "path": "/abs/path" }`: the brain already in that folder (`/abs/path/.edu`), which several bots
  can share, for example one brain per company area. Edu Bot never creates a brain there: run `edu init` in the
  folder first. Without one the bot gets no Edu tools.
- `{ "mode": "area", "area": "bi" }`: one brain shared by every bot of area `bi` on this computer, at
  `<data folder>/brains/areas/bi/.edu`, created on first use like an own brain. Profiles set it from `area.md`.
  With `"personalBrain": false` the bot does not read your global brain either: Edu Bot runs Edu with `EDU_HOME` set to
  an empty folder, `<data folder>/edu-no-personal`, so the brief, `edu mcp` and the proposals list see only the area's
  brain. Edu 6.0.0 has no switch of its own for this; it reads `EDU_HOME` as the global layer. Every Edu command Edu
  Bot runs for such a bot (the brief, the mount, listing proposals after a turn and for Needs you, deciding one) runs
  with that `EDU_HOME`.
- `{ "mode": "cloud", "url": "https://…/mcp", "token": { "secret": "EDU_CLOUD_BI" } }`: an
  [edu-cloud](https://github.com/EduardoMoraga/edu-cloud) brain the team shares across computers. The turn mounts
  edu-cloud's HTTP MCP as the `edu` server instead of `edu mcp`, through Edu Bot's relay (see below); the tools have
  the same names, and the brief comes from edu-cloud's `edu_brief`. It needs no Edu install on this computer, and it
  never reads your global brain. The token is yours: save it in **Settings → Vault** under the name in `secret` (or use
  `{ "env": "NAME" }` for an environment variable of the app). Settings show only its name and what it may do there;
  no route returns its value. `http://` is accepted only for this computer (`127.0.0.1`, `localhost`).
- `{ "mode": "off" }`: no Edu brain.

Deleting a bot keeps its brain folder: memory is worth more than the disk it takes. Remove
`<data folder>/brains/<bot id>` yourself when you no longer want it.

Giving a bot a brain, or pointing it at another folder, must come from the desktop app or a paired device. A local
script (and so a bot's own shell) may only turn a brain off.

A folder is refused, when it is set and again before each turn, after following symlinks, when it:

- is the global brain, is inside it, or holds it as its `.edu`;
- is inside Edu Bot's data folder, other than the bot's own brain folder;
- has a `.edu` that is a symlink (Edu would write through it into another brain).

An own brain whose folder or `.edu` was replaced by a link is refused the same way. `GET /api/bots/:id/memory` then
reports `state: "broken"` with the reason.

A team backup carries each bot's `eduBrain` setting, not the brain itself. On import a `folder` setting is restored
only for an import from the desktop app or a paired device; otherwise the restored bot's brain is `off`.

The global Edu brain (`~/.edu`, or `EDU_HOME`) is read alongside each bot's brain, except for an area brain with
`personalBrain: false` and a cloud brain. Writes go to the bot's brain.

### Cloud brain proposals

An edu-cloud with per-person tokens gives each person a token with a scope: `member` (read and save notes) or `steward` (also
approve and reject canonical proposals). Edu Bot asks `GET <base>/api/v1/whoami` what your token may do:

- **steward:** the cloud brain's proposals become cards and Memory settings rows like a local brain's, and approving
  or rejecting goes to edu-cloud's `POST <base>/api/v1/proposals/<id>/approve|reject` with your token. The same local
  rule applies first: only the desktop app or a paired admin device approves.
- **member:** Memory settings lists them read-only: only a steward of the area decides them.
- **an older edu-cloud** (no `/api/v1/` routes): the brain works for memory; proposals are approved on the edu-cloud
  server itself (`edu-cloud approve <id>`), and Memory settings says so.

Your token never reaches the bot. The turn's `edu` server talks only to Edu Bot's own loopback route
`POST|DELETE /api/internal/edu/mcp`, with a capability that holds only while that turn runs. Edu Bot adds your token
in its own process and forwards MCP JSON-RPC, and nothing else, to the brain's `/mcp` address; the review routes are
never reachable through it. So the engine's MCP configuration, its arguments and its environment hold no token a bot's
shell could read, and approval stays an HTTP route the bot cannot call.

Edu crew needs a local Edu brain, so a cloud brain bot has no crew: Memory settings does not offer it.

## Settings

`config.json`:

```json
{ "edu": { "enabled": true, "home": "~/.edu" } }
```

- `enabled: false` turns Edu off for every bot.
- `home`: the global brain, an absolute path or `~/…`. Default: `EDU_HOME`, else `~/.edu`.

Edit this block in `config.json` itself: the settings API does not change it. A wrong type there (for example
`"enabled": "no"`) makes the whole file invalid, as for every other setting.

`OMB_EDU_CLI` (environment) names Edu's `cli.js` when the `edu` on PATH is not npm's own link or shim, for example a
version-manager wrapper.

## When Edu is not there

A turn never fails because of Edu. With Edu missing, older than 6.0.0, broken, off, or with a shared folder that has
no brain, the bot simply has no Edu tools and no brief. `GET /api/bots/:id/memory` reports why, under `edu`:

```json
{ "state": "missing", "mode": "own", "home": "/home/me/.edu", "reason": "Edu is not installed", "brain": "…" }
```

`state` is `ready`, `off`, `missing`, `old` or `broken`; `brokenFolder: true` (in `GET /api/bots/:id/edu`) means Edu
works and the brain folder is what it can't use. Bot settings → Memory → Edu brain gives each state one sentence on
what to do, and a bot whose brain is off has a Turn on button (desktop app or a paired device, as above). Edu is looked
up again at most every 30 seconds, so installing or updating it needs no restart.

If the `edu` server is mounted but does not start (Claude's `system/init` lists it as failed, Codex reports its
startup failed, or an API engine cannot list its tools), the turn goes on without it and the conversation gets one
quiet line, "Edu memory didn't connect this time; it retries next message", at most once an hour per conversation,
never an error. Claude and Codex start the next turn in a new process, so it does retry. On an ACP engine that refuses
the session when the `edu` server fails (DeepSeek Harness words it `mcp-client(edu): initial connection or tool
synchronization failed`), the same turn runs again without it after that line, and the next turn tries Edu again; any
other server that fails to start still fails the reply.

Edu is mounted only when the engine runs on this computer: not on a Cloud, in a bot box, on a cloud or VPS computer,
in a proactive turn's fence or in a Bot API conversation.

## Safety

- The brain is fixed per turn: `--cwd <brain folder>` with `EDU_LOCK_WORKSPACE=1`, so `edu_project_use` cannot move
  a bot onto another brain, the global one included.
- A bot can propose canonical notes but never accept them: Edu has no MCP tool for that.
- On Claude bots the engine runs with `EDU_CREW_JOB=edu-bot:<bot id>`, which Edu reads as "a crew worker": the bot's
  own shell cannot run `edu brain approve` or start Edu crew jobs. Only the `edu` server has it cleared, so memory
  writes still work. Codex hands one environment to all of its MCP servers, and the other engines were not checked,
  so they do not get this guard yet. It is not a hard boundary: a shell can unset a variable.
- When Edu Bot itself runs inside an Edu crew job, the inherited guard stays on for the bots too, and Edu refuses
  their brain writes.

## Edu crew

Edu crew lets a bot hand work to Edu's plan, build, checks and cross-vendor review loop, which runs other coding CLIs
(Codex, Claude, Pi, OpenCode, Antigravity) from the person's PATH. It is **off** for every bot. Turn it on in Bot
settings, Memory, Edu brain, **Edu crew** (it needs the bot's Edu brain). Turning it on, like widening the Edu brain,
works only from the desktop app or a paired device; anyone may turn it off.

With it on, the bot gets four tools on Edu Bot's own `agents` server. Edu's `full` MCP profile is never mounted.

| Tool | Does |
| --- | --- |
| `edu_plan` | `edu run --detach` on a goal, with an optional playbook (`default`, `quick`, `research`). Never `--yes`, never `--allow-unregistered-checks`. |
| `edu_review` | A read-only review (`edu crew dispatch <cli> --autonomy readonly`) of a question, paths inside the folder, or the git changes since a base; with nothing given, the uncommitted changes against `HEAD` and the new files. By Codex, Claude or Pi, never the CLI the chat's engine is (`claudeAgent` is `claude`, `piAgent` is `pi`); when only that one is installed it says so and reviews nothing. Secrets are redacted before the task leaves; a `git diff` that fails is an error. Waits up to 120 s by default and returns the review. |
| `edu_crew_status` | Where a job of this chat stands, or this chat's jobs. |
| `edu_crew_result` | Waits up to 300 s for a job and returns Edu's summary or the review. |

**Gates.** Edu stops a plan at its approval gates: the spec first, then each step its playbook asks about. Each open
gate becomes a card in the chat: **Let Edu crew go on?**, with the spec, any planner command that approving runs, and
the folder. Approve runs `edu crew approve <job> --request <gate id>` from the server, Reject runs `edu crew reject`
(Edu fails the job: `spec rejected`). The same rule as Edu proposals decides who may answer: a local service or a
bot's shell may only reject, a local caller outside the desktop app may only reject, a session needs the admin scope.
A gate decided elsewhere (Edu's deck or CLI) turns the card into "No longer waiting". No turn, call or composer waits
on these cards.

**Where it works.** Only in a person's own chat with a bot that works on this computer: never in a room, on a cloud
home or in the bot box, in a fenced chat (proactive or Bot API), for a bot on a cloud computer or with Works on Off, or
when Edu Bot itself runs inside an Edu crew job. The tools, the skill and the server route check the same rule. Jobs
run in the chat's working folder (the bot's folder, as pinned for the chat). Edu crew refuses a chat with no folder of
its own, the person's home folder or any folder above it, Edu Bot's data folder, the global Edu brain, and a folder
whose `.edu` (or anything in `.edu`, `.edu/brain` or `.edu/crew`) is a link out of it: the same check as a bot's brain
folder. Files read back from Edu (spec, summary) must lie inside the job's own store. Edu runs with `EDU_HOME` set to the bot's brain and `EDU_CEILING_DIRECTORIES` set to the folder's
parent, so the job record, spec and run notes go to the bot's brain (or to the project's own `.edu`, if it has one),
never to your global brain. `EDU_CREW_JOB` is cleared for these commands only.

**In the chat.** Each job keeps one quiet line, rewritten as it moves: working, waiting for your approval, finished,
stopped, or "couldn't finish: why". A failure is that one line, never an error card. **Details** shows the folder, the
spec and the result, and reloads when the job moves on; **Cancel** stops a running job (`edu crew cancel`, which ends
its process tree) and says so when Edu could not. Stopping the bot's turn in a chat stops that chat's running jobs
too, including one still starting. Quitting Edu Bot cancels every running job. A chat runs at most 2 jobs at once and
Edu Bot at most 4; the tool says so when that is reached. Jobs are kept in `edu-crew.json` in the data folder, so after
a crash the next start follows the ones still running. Results and failure reasons reach the bot as records, never as
instructions.

**Known limits** (Edu 6.0.0):

- Edu takes a gate decision from a file any local process can write. Claude bots' shells carry the `EDU_CREW_JOB` guard,
  which makes `edu crew approve` refuse; a shell that unsets it, or a bot on another engine with a shell, could still
  approve. As with proposals, this is not a hard boundary outside the bot box.
- Edu's own crew workers run the coding CLIs outside Edu Bot's permission levels, bot box and audit; the gates and the
  folder rules above are the controls.
- `edu_crew_review` in Edu reviews only a git diff, so a review of a question or paths goes through a read-only
  dispatch instead.
- Not in rooms, not on a cloud home or in the bot box, not for engines without the `agents` server.

## Engines

Claude, Codex, Pi, the ACP engines (Grok, Gemini, OpenCode, Antigravity and the others), Muse Code and the API engines
with tools mount it. Tool selection applies as for any server: `mcp:edu:*`, or single tools such as
`mcp:edu:edu_recall`. `edu` is a reserved server name: a custom server cannot take it, and an imported one is renamed
`mcp-edu`. A custom server that still carries one of Edu Bot's own names never replaces Edu Bot's server: Claude,
ACP and Pi keep Edu Bot's, and Codex mounts the custom one under another name.

## Verify

```sh
pnpm exec vitest run server/edu-brain.test.ts server/edu-brief.test.ts server/edu-cloud.test.ts server/drivers/team-tools.test.ts
EDU_CLOUD_CLI=/path/to/edu-cloud/dist/cli.js pnpm exec vitest run server/edu-cloud-brain.e2e.test.ts   # skipped without it
pnpm exec vitest run server/drivers/acp/failure-words.test.ts server/drivers/acp/deepseek.test.ts -t "MCP server|retryWithoutEdu"
pnpm exec vitest run server/drivers/claude.test.ts -t "Edu brain"
pnpm exec vitest run server/edu-proposals.test.ts src/components/bot-panel/EduBrainCard.dom.test.ts src/components/ApprovalCard.edu-proposal.test.ts
pnpm exec vitest run server/edu-brain.real.test.ts server/edu-brain.e2e.test.ts   # need Edu installed; skipped otherwise
pnpm exec vitest run server/edu-proposals.real.test.ts server/edu-proposals.e2e.test.ts   # the same
pnpm exec vitest run server/edu-brief.real.test.ts server/edu-brief.e2e.test.ts   # the same, except the no-Edu e2e case
pnpm exec vitest run server/edu-crew.test.ts src/components/ApprovalCard.edu-crew.test.ts src/components/EduCrewLine.dom.test.ts server/skill-library.test.ts
pnpm exec vitest run server/edu-crew.real.test.ts server/edu-crew.e2e.test.ts   # need Edu installed; a fake codex is the crew
```

The real-binary tests run Edu in temporary folders only: the fixture's data folder, and a temporary global brain
passed to the launcher as `EDU_FIXTURE_HOME` (it refuses your own `~/.edu`). Without `EDU_FIXTURE_HOME` a fixture has
no Edu. `EDU_FIXTURE_CREW_BIN` puts a folder of fake crew CLIs on the fixture's PATH; the crew tests use a fake `codex` and
never a real coding CLI, account or key.
