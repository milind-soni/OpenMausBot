# Run OpenMausBot from scripts and CI

The `openmausbot` command can drive a running workspace without a screen: set
up a team from a file, give a bot a job, wait until it and every teammate it
asked are done, and keep what they made. It works against the server on this
computer or one somewhere else, and it is built for scripts, CI and other
agents: every command can print one JSON document, and the exit code says how
things went.

```sh
npm install -g openmausbot            # or use npx openmausbot …
openmausbot serve --no-pair &         # a workspace with no screen (or use your desktop app)
openmausbot engine set claude --key-env ANTHROPIC_API_KEY
openmausbot team apply launch-room.yaml
openmausbot run "Room Lead" "Rehearse the launch of https://example.com" --export ./rehearsal
```

`run` prints progress as it goes, then the Room Lead's final reply and the
files it links, and writes everything to `./rehearsal`.

## Which workspace, and as whom

- `--url URL` or `OPENMAUSBOT_URL`: a workspace somewhere else. Use `https://`
  unless it is this computer (`ALLOW_INSECURE_HTTP=true` allows plain `http://`).
- `--port N` or `OMB_PORT`: this computer, on that port.
- Otherwise the command looks on this computer's usual ports (8799, 18799,
  28799), as the desktop app uses them.

On this computer a headless server treats you as its owner, and no token is
needed. Anywhere else you need a token:

```sh
openmausbot connect https://maus.example.com --code ABCD1234 --out ~/.openmausbot-token
openmausbot doctor --url https://maus.example.com --token-file ~/.openmausbot-token
```

Get the code in the app under **Settings → Phone → Set up a phone**. On this
computer's own server, `connect` makes the code itself (`--client` gives a
token that can chat but not change settings). The token goes to a file only
you can read, and is never printed. Pass it with `--token-file FILE` or
`OPENMAUSBOT_TOKEN`; there is no `--token` flag, because a command line can be
read by other programs. A token is never sent while the command is still
looking for a server: with a token, name the server.

## Output and exit codes

Without `--json` you get plain lines. With `--json` you get exactly one JSON
document on stdout, a failure included (`{ "ok": false, "error", "hint",
"exitCode" }`). Progress goes to stderr as one JSON object per line; `--quiet`
drops it. Everything printed, either way, has secrets removed (the same
redaction the transcript uses). Durations are written `90`, `90s`, `5m` or `2h`.

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | Failed, stopped or stalled, or a step was refused |
| 2 | The command line or a file is wrong |
| 3 | Someone must answer (a question or an approval card) |
| 4 | Timed out (the work keeps running) |
| 5 | Cannot reach the server, not allowed, or the server is too old |
| 6 | `team apply --check` found changes |
| 130 | Ctrl-C (the work keeps running) |

## Commands

Run `openmausbot help VERB` for any of these. A TARGET is a bot or room by
name or id, or `--bot ID`, `--channel ID` or `--thread ID`; `--task ID` picks
one of its conversations.

| Command | What it does |
|---|---|
| `doctor [--wait 2m]` | Checks the server answers, is new enough, who you are to it (and when your session expires), that an engine is ready, and whether bots have a browser. |
| `bots`, `channels`, `models` | Your bots and what each is doing, your rooms, the engines and the models each offers. |
| `messages TARGET [--limit 30]` | The latest messages of a conversation. |
| `send TARGET TEXT` | Sends one message and returns at once. `--send-id ID` makes a retry safe: the same id never sends twice. |
| `run TARGET TEXT` | Gives a bot or room one job and waits until it is done (below). |
| `wait TARGET` | Waits on work already running. |
| `interrupt TARGET [--tree]` | Presses Stop. `--tree` also stops every teammate still working on its job, in that teammate's own conversation. |
| `export TARGET --out DIR` | Writes a conversation's job to a folder (below). |
| `events` | The server's live events as JSON lines (below). |
| `team apply FILE`, `team export --out FILE` | Makes the workspace match a team file, or writes one (below). |
| `engine set KIND`, `engine list` | Gives the workspace an engine key without a screen (below). |
| `connect [URL]` | Gets a token for a workspace elsewhere. |
| `new-bot`, `new-channel`, `set-model`, `edit` | Make a bot or a room, change a bot's model, rewrite an earlier message. |
| `mcp` | The OpenMausBot MCP server on stdin and stdout ([docs/mcp-server.md](mcp-server.md)). |

The message for `send` and `run` can be the next word, `--text TEXT`,
`--message-file FILE`, or `-` to read it from stdin.

## run and wait

```sh
openmausbot run "Room Lead" --message-file brief.md --timeout 45m --on-input exit --export ./out
```

`run` starts a new conversation (titled by `--title` or the message's first
line) unless `--task current` or `--task ID` says otherwise, sends the message
once, and waits for the whole job: the bot's own turn and every piece of work
it handed to a teammate, and theirs in turn. Its first progress line names the
conversation and when the job began (`since`), so a later `openmausbot wait
--thread ID --since MS` can pick the same job up again.

- `--wait job` (the default) waits for the bot and every teammate; `--wait turn`
  only for the bot's own turn; `--wait none` sends and returns.
- `--on-input exit` (the default) stops waiting with exit 3 when someone must
  answer; `wait` keeps waiting for the answer; `stop` stops the job.
- `--on-timeout leave` (the default) leaves the work running; `stop` stops it.
- `--strict` fails the run (exit 1) if any teammate's part failed, even when
  the bot finished.
- `--export DIR` writes the job to `DIR` once it is done. `DIR` must be new or
  empty, and that is checked before anything is sent; `--force` writes into a
  folder that already has files.

A teammate the bot sent a one-way notice to, or one still working after the
bot was stopped, does not hold the job open: nobody is waiting on it. A
message no turn ran for at all (a room set to answer mentions, sent a message
that names nobody; a queued message removed before its turn) is not a job
done: `run` ends with `state: "idle"` and exit 1.

With `--json` the result carries the job's `state` (`completed`, `idle`,
`needs-input`, `failed`, `stalled` or `timed-out`), which the exit code
follows (`idle` after `run` is exit 1, as above), the job tree, the final
reply and the files it links. Its `status`
keeps the words MCP clients already read: `settled` there only says the
conversation stopped working, so a lead whose work failed is `settled` with
`state: "failed"` and exit 1.

`wait TARGET` takes the same options. If nothing is running it returns at
once with exit 0. `--for turn` waits only for the conversation's own turn.
`--since MS` (the number `run` prints, and puts in its "wait again" line)
keeps watching the same job: if it ended while nobody was watching, `wait`
says how it ended instead of "nothing is running". Ctrl-C prints that line too.
If the server drops for a moment (a restart, a proxy in front of it), `run`
and `wait` keep asking for the same job until their time runs out; a refusal
(an expired token) ends them with exit 5 at once.

Stopping a job (`interrupt --tree`, `--on-input stop`, `--on-timeout stop`)
presses Stop in its conversation, then in each teammate's own conversation
that still holds part of it: a turn still running, waiting on its own
teammates, parked on an answer, or about to run again. Work that never
started is dropped by the first Stop, and its teammate's conversation is left
alone.

The waiting is done by the server: each request is held until the job
changes, so a long wait costs one request at a time, not a poll loop. The
same answer is available to anyone: `GET /api/threads/:id/job` (add
`wait=MS&version=V` to hold it until the job changes from the version you
have).

## export

```sh
openmausbot export "Room Lead" --out ./rehearsal          # its current conversation
openmausbot export --thread 3f2a… --out ./rehearsal --root ROOT_ID
```

| Written | What it holds |
|---|---|
| `manifest.json` | What was written, and anything skipped and why |
| `job.json` | The job tree: every piece of work, who did it, how it ended and what it said |
| `transcripts/` | Every conversation of the job, as `.json` and `.md`, secrets removed, at most 2,000 messages each |
| `files/` | The files the replies link to or attach (a report, screenshots), per conversation |
| `screens/` | Screen captures the server kept |

Each file is fetched under its own reply's permission, exactly as the app
opens a link; a link to something outside that conversation's folders is
skipped and listed in `manifest.json`. A reply that links a folder brings the
files directly in it. Limits: `--max-files 200`, `--max-screens 100`,
`--max-bytes 500MB` (counted on what is written, so a file that runs past it
is skipped). A folder with files in it is refused unless `--force`, which
replaces what an earlier export wrote there: the files its `manifest.json`
lists are removed first, and nothing else in the folder is touched.

## events

```sh
openmausbot events --job 3f2a… --until-settled > events.jsonl
```

One JSON line per event: messages as they are written and changed, threads,
bots and rooms. `--kind` names the kinds to print instead of those
(`--kind message,runtime` is messages and token-level events); `--screens`
adds live screen frames. `--thread ID` (repeatable) keeps one conversation's
events; `--job ID` follows every conversation of that job as it grows, and
`--until-settled` ends when the job does, with its exit code. After a dropped
connection it resumes from where it was; the server's first line says whether
it could (`"resumed": false` means read the state again). A refusal (an
expired token, a missing scope) ends it with exit 5 instead. The output is
always JSON lines; `--jsonl` is accepted and changes nothing.

## engine

```sh
openmausbot engine set claude --key-env ANTHROPIC_API_KEY --base-url https://gateway.example.com --install
openmausbot engine list
```

KIND is `claude`, `openai`, `openrouter`, `openai-compatible` (needs
`--base-url`), `xai`, `groq`, `mistral` or `cerebras`. The key comes from an
environment variable (`--key-env`) or a file (`--key-file`), is written once
through the same setting the Settings screen uses, and is never printed or
read back. An engine that already has a key is left alone unless `--rotate`,
so a script can run this on every start. The server never shows the address
of a key it has, so on such an engine a different `--base-url` is not written
either (it says so): `--rotate` writes both. For `claude`, the key runs every
Claude bot (engine `claude`); `--only-claude-api` keeps it to "Claude (API
key)" bots (engine `claudeApi`). `--install` installs the engine's command if
it is missing, and waits for the install to finish (minutes on a fresh
machine). Changing keys needs a session with full access.

## The team file

A team file says what the workspace should have: teams and their briefs, bots
with their standing instructions, models, approval levels and computers,
skills, rooms, and the engines they run on. Write it in YAML or JSON.

```sh
openmausbot team apply launch-room.yaml             # plan, then apply
openmausbot team apply launch-room.yaml --dry-run   # only the plan
openmausbot team apply launch-room.yaml --check     # exit 6 if anything would change (CI)
openmausbot team export --team "Launch Room" --out exported.yaml
```

Apply prints its plan, then makes the changes:

```text
team "Launch Room": create · brief set (5 lines)
bot "Room Lead": create (Chief of Launch Room · claude/claude-sonnet-5-5 · Full access · computer local)
bot "Priya": update title "Buyer" → "Skeptical procurement manager"; soul 3 lines changed
bot "Old visitor": not in file (kept; --prune deletes it)
Plan: 6 to create, 1 to change, 0 unchanged, 0 to delete.
Applied: 6 created, 1 changed, 0 deleted.
```

Run it again and it prints `No changes.` and sends nothing: it compares the
file with what the server holds, field by field. Bots are matched by name (any
case), or by `was:` when you rename one; of two bots with one name, the one
already in the file's team. A rename onto a name another bot has is refused.
A field the file leaves out is left as it is (a new `model` on the same engine
keeps the bot's effort). Teams are never deleted, nor skills the file does not
list. Bots and rooms a team no longer lists are deleted only with `--prune`,
and only in a team marked `prune: true`. Apply is not atomic: if a step is
refused it stops, says what it had already done, and exits 1; applying again
carries on. A bot that is in the middle of a turn is changed once it is idle,
waiting up to `--wait-idle` (2 minutes) and then reporting it.

Every change goes through the same requests the app makes, with the same
checks. Apply adds no confirmations of its own: where the server needs one
(Auto on this computer, a Chief's access to other teams), the file saying so
is the confirmation.

### Fields

```yaml
version: 1                                  # required
engines:                                    # optional; needs full access
  claude: { key: SECRET, baseUrl: URL | SECRET, everyClaudeBot: true, install: false }
  openai | openrouter | xai | groq | mistral | cerebras: { key: SECRET }
  openaiCompatible: { key: SECRET, baseUrl: URL | SECRET }
  # SECRET is { env: NAME } or { file: PATH }. A key written in the file is refused.
defaults: BOT FIELDS                        # every bot gets these unless it sets its own
teams:
  - name: Launch Room                       # 1-60 characters
    brief: TEXT | { file: PATH }            # the team's shared instructions
    prune: false                            # --prune may delete its bots and rooms the file leaves out
bots:                                       # at least one
  - name: Room Lead                         # 1-100 characters, unique
    was: Old name                           # rename that bot instead of making a new one
    team: Launch Room
    title: Launch rehearsal lead
    description: TEXT
    chief: true                             # Chief of Staff of its team (one per team); false removes it
    manages: [Support]                      # other teams this Chief is also in charge of (every bot reaches every bot anyway)
    soul: TEXT | { file: PATH }             # standing instructions, at most 24,000 bytes
    model: claude/claude-sonnet-5-5         # INSTANCE/MODEL; openmausbot models lists them
    effort: none | low | medium | high | xhigh | max
    approval: ask | edits | auto | full     # a new bot starts at full; Custom is set in the desktop app
    computer: auto | off | browser | local | vm | cloud
    cwd: /work/room                         # a full path that exists on the server
    browser: true | false | { enabled: true, profile: guest }
    tools: { allow: [SELECTOR], deny: [SELECTOR] }   # docs/tool-selection.md; {} means every tool
    skills:
      - { file: skills/launch-report/SKILL.md, enabled: true }
rooms:
  - name: Rehearsal
    team: Launch Room
    members: [Room Lead, Priya]             # bot names
    brief: TEXT | { file: PATH }
    responder: everyone | mentions | BOT NAME
```

Paths are relative to the team file. Apply refuses (exit 2), naming where:
an unknown field, a duplicate name, two Chiefs in one team, `manages` without
`chief`, a model not written as `INSTANCE/MODEL`, a `cwd` that is not a full
path on the server (`/work/room`, or `C:\work\room` on a Windows server; `~`
is refused too: it would not mean the same there), a missing file or
environment variable, a key written into the file, and anything longer than
the app takes (a name or title on more than one line or over 100 or 200
characters, a soul or team brief over 24,000 bytes, a room brief over 12,000
characters, a skill over 256 KiB). It warns about a bot with no `computer`: on
`auto` it may ask which computer to use, and nobody is there to answer a
headless run. An engine's key, and a base URL kept as a secret, are read only
when they have to be written: when the engine has no key yet, or with
`--rotate-secrets` (on an engine that has a key, the plan says its base URL
could not be compared). Souls, briefs and skills are read with LF line ends,
and paths in the file may use either separator, so the same file applies
alike from a Windows checkout and from Linux CI.

Before it writes anything, apply also checks the file against the server
(exit 1): every `model` must be one its engine offers, every room member a bot
that exists or that the file makes, and every `tools` selection one the bot's
engine can hold. Claude, Codex and the other agent engines limit only MCP
tools (`mcp:SERVER:TOOL`); a `native:` selector for one of them would stop
every turn it runs, so apply refuses it (docs/tool-selection.md lists which
engines can limit built-in tools). `tools: {}` or `{ deny: [] }` means every
tool: the bot's selection is cleared.

`team export` writes the workspace in this format, skills as `SKILL.md` files
beside it and engine keys as `{ env: SET_ME }` placeholders, so applying an
export to the same workspace prints `No changes.`. A key written into a soul,
a brief or a skill is taken out (`«redacted N chars»`), as the app's own team
export takes it out, and the export says where; apply leaves a field with that
mark as it is, so the secret stays only on the server.

### Example: Launch Room

One Room Lead and the visitors who rehearse a launch, on a sandbox with no
Claude login: the key runs every Claude bot.

```yaml
# launch-room.yaml — openmausbot team apply launch-room.yaml
version: 1

engines:
  claude:
    key: { env: ANTHROPIC_API_KEY }          # or { file: /run/secrets/anthropic }
    baseUrl: { env: ANTHROPIC_BASE_URL }     # your gateway; a plain https:// address works too
    everyClaudeBot: true                     # every Claude bot (engine "claude") runs on this key
    install: true                            # install Claude Code if the sandbox lacks it

defaults:
  team: Launch Room
  model: claude/claude-haiku-5-5
  approval: full                             # nobody is there to answer a permission card
  computer: browser                          # works only in its own built-in browser
  browser: { enabled: true, profile: guest } # a fresh temporary profile per bot
  cwd: /work/visitors                        # where screenshots go (create it first)

teams:
  - name: Launch Room
    prune: true
    brief: |
      We rehearse a product launch before it happens. Visitors use the site the way a
      first-time visitor would. Never sign up with real details, pay, post or email anyone.
      Never ask the person anything: if something blocks you, say exactly what and stop.
      Save a screenshot at every step as <your-name>-<step>.png in your folder, and end
      your report with a Markdown list linking each one.

bots:
  - name: Room Lead
    chief: true
    title: Launch rehearsal lead
    description: Hands the site to every visitor, then writes the launch report.
    model: claude/claude-sonnet-5-5
    effort: medium
    computer: local
    cwd: /work/room
    browser: false
    soul: { file: souls/room-lead.md }
    skills:
      - file: skills/launch-report/SKILL.md

  - name: Priya
    title: Skeptical procurement manager
    soul: |
      You are Priya, 41, who buys software for a 200-person company. You distrust vague
      claims and look for pricing, security and who else uses it before anything else.
  - name: Marcus
    title: Rushed founder on a phone-sized screen
    soul: |
      You are Marcus, 29, running a two-person startup. You give a site 30 seconds,
      skim headlines, and try the main button first. Use a 390x844 viewport.
```

Then rehearse, wait for every visitor, and keep the report, transcripts and
screenshots:

```sh
openmausbot run "Room Lead" "Rehearse the launch of https://example.com with every visitor, then write report.md." \
  --timeout 45m --export ./rehearsal
```

A Room Lead can brief up to 64 teammates in one turn before any of them
reports back.

The visitors read sites nobody vetted. A Claude bot keeps its built-in tools
(a shell, file edits) whatever its `tools` say, so run them where those tools
can do no harm, such as a throwaway sandbox like Launch Room's, or give them
an engine that can limit built-in tools.

## In CI

```yaml
# .github/workflows/rehearse.yml (a sketch)
- run: npm install -g openmausbot @anthropic-ai/claude-code
- run: openmausbot serve --no-pair --data-dir "$RUNNER_TEMP/omb" &
  env: { OMB_ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" }   # the workspace's Claude key from the start
- run: openmausbot doctor --wait 2m          # the server answers and an engine is ready
- run: openmausbot team apply team.yaml
- run: openmausbot run "Release checker" "Check the deploy at ${{ env.URL }}" --timeout 20m --strict --export ./out
- uses: actions/upload-artifact@v4
  with: { name: release-check, path: ./out }
```

`doctor --wait` waits for an engine too, so the server gets its key in its
own environment, as here (`OMB_ANTHROPIC_API_KEY`; the team file's `engines:`
section, or `openmausbot engine set`, can set it later instead).

The step fails when the job fails (exit 1), needs someone (exit 3) or runs out
of time (exit 4). To drive a workspace that is already running elsewhere, set
`OPENMAUSBOT_URL` and pass a token made with `openmausbot connect` as a secret
file (`--token-file`).

## For other agents

`openmausbot mcp` serves the same operations as MCP tools on stdin and stdout
([docs/mcp-server.md](mcp-server.md)): `wait_for_conversation` waits on the
same job, and returns the same result, as `wait`.
