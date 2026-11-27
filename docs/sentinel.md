# Sentinel

Sentinel is an opt-in health scanner for an OpenMausBot data dir. It reads the
data dir's databases and logs without modifying them, groups failures into
issues, and writes those issues to its own folder outside the data dir (see
[Privacy model](#privacy-model)). An `--out` inside the data dir is refused.
It is plain code with no model calls,
and it runs out of process on a schedule, so it keeps working after the app
crashes. The code lives in [`server/sentinel/`](../server/sentinel/). Every
input is explicit, so the same scan could later run inside the server.

```sh
openmausbot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]
                     [--queue-wait SECONDS] [--cost USD]
openmausbot sentinel --check-install [--json]
```

Each run does one scan, prints a short summary (or JSON with `--json`) and
exits 0. When no source file has changed since the last run and no queued
work has passed the queue-wait threshold since, it says so and exits without
reading any rows.

## What it reads

All sources are opened read-only:

| Source | What Sentinel takes from it |
|---|---|
| `messages.db` | Activity rows whose `tool.ok` is false: tool name, `turnId`, `from.botId`, and the error output, which is used only for the signature |
| `events/*.ndjson` | `turn.completed` events: `ok`, `stopReason`, `cost` |
| `runtime.db` | `assignment_events`: the gap from `enqueued` or `resume_due` to `started`, which is the queue wait |
| `bots.json` | Which bot owns which thread. Bot names are held in memory only, so they can be removed from harness notices before hashing |

A few details matter here, because the app is usually running and writing
while Sentinel reads:

- **SQLite is opened read-only** (`SQLITE_OPEN_READONLY`, which is what
  `mode=ro` means) and never with `immutable`. Both databases use WAL mode and
  most recent rows are still in the `-wal` file, which `immutable` would skip.
  Queries are short, and each handle is closed straight away, so Sentinel never
  holds a read transaction that would stop the app from checkpointing.
- **Activity rows change after they are written.** A row's outcome is filled in
  when its tool finishes. So a scan doesn't follow a rowid cursor. Instead it
  rereads a trailing 30-minute `at` window and counts each message id once.
- **Event logs can be rewritten or deleted.** Each log is read from a byte
  offset. The offset resets to zero when the file got smaller or its inode
  changed. Both happen when `thread-log-rotation.ts` rewrites an oversized log,
  and `thread-retention.ts` deletes idle logs. After a reset, a per-file
  high-water mark on `createdAt` skips the tail the scan has already seen.

## Privacy model

Issues hold references and a normalized title, never raw content. A line in
`issues.jsonl` looks like this:

```json
{"sig":"tool_error:fac3821e82105968","kind":"tool_error","title":"no layer <n> in <path>",
 "origin":"harness","severity":"high",
 "tool":"mcp__agents__send_message","botId":"…","threadId":"…","turnId":"…",
 "firstAt":1791895763128,"lastAt":1791895763131,"count":3,"wastedTurns":1,
 "evidenceRef":{"source":"messages","id":"…"}}
```

- The signature is a hash of the tool name and the normalized error. Paths,
  numbers, UUIDs, hex ids, URLs, email addresses and quoted values are replaced
  before hashing, so "no layer 12" and "no layer 104" become one issue.
- A failed shell command is grouped more coarsely: by its exit code and an
  error class (`timed out`, `command not found`, `syntax error`,
  `no such file`, `permission denied`, …) rather than by what it printed,
  because its output names the files of the work in hand. A timeout ignores the
  exit code, since that is just the signal that stopped it.
- `title` is that normalized line, capped at 160 characters (for a shell
  command, `exit 127: command not found`). It makes the file readable on this
  machine. The raw error output is never stored. Normalized text can still
  contain a word someone typed, so the title stays local. Anything Sentinel
  shares later (see community counts below) carries only `sig`, `kind`,
  `origin`, `tool` and `count`, never `title`.
- `tool` is kept only when it is a tool identifier. A sentence the harness
  wrote into the transcript (for example, a stopped room turn) is recorded as
  `harness_notice`, because it can contain a bot's name.
- `evidenceRef` points back into the data dir (`messages` → message id,
  `events` → event id, `runtime` → assignment id). A later stage can look the
  evidence up there for someone who is allowed to see it.
- Output goes to a folder outside the data dir: on macOS
  `~/Library/Application Support/openmausbot-sentinel/`, on Linux
  `$XDG_STATE_HOME/openmausbot-sentinel/` (by default
  `~/.local/state/openmausbot-sentinel/`), on Windows
  `%LOCALAPPDATA%\openmausbot-sentinel\`. You can choose another folder with
  `--out`. A data dir other than `~/.openmausbot` gets its own `data-<hash>`
  subfolder. The folder is `0700` and its files are `0600`. Sentinel refuses
  an `--out` inside a git repository or inside the data dir, so it never
  writes into the folder it reads, and backups of the data dir never carry its
  files.

`issues.jsonl` is upserted by signature: `count`, `lastAt` and the latest
evidence are updated in place. `state.json` stores the log offsets and the
occurrence keys already counted, so running the scan again with no new data
changes nothing.

## Detectors

A detector is a pure function from the records in a scan window to
observations ([`server/sentinel/types.ts`](../server/sentinel/types.ts)):

```ts
interface Detector {
  name: string;
  detect(records: readonly SentinelRecord[], config: DetectorConfig): Observation[];
}
// Observation: kind, signature, title, origin, severity, tool?, botId?, threadId?,
// turnId?, at, occurrence (stable id, counted once), evidence
```

Adding a detector takes one file in `server/sentinel/detectors/` and one line
in its `index.ts`. A detector may see the same record on several scans. The
`occurrence` key keeps those repeat sightings from being counted twice.

| Kind | Fires on | Origin |
|---|---|---|
| `tool_error` | A failed tool call, grouped by tool and normalized error | `harness` for OpenMausBot's own MCP servers (`mcp__agents__*`, `computer`, `browser`, …) and harness notices; `shell` for Bash and exec; `external` for other MCP servers and the engine's built-in tools |
| `turn_timeout` / `turn_stop` | A `turn.completed` that is not ok (stops the person chose are excluded), a turn stopped on budget (`max_tokens`, `max_turns`), or a room turn the harness stopped for running too long | `external` for account stops (`auth_required`, `quota`, …), otherwise `harness` |
| `queue_wait` | Delegated work that waited longer than `--queue-wait` (default 300 s) before starting, or is still waiting | `harness` |
| `cost` | A single turn that cost more than `--cost` (default $5) | `harness` |
| `retry_loop` | The same tool failing with the same signature 3 or more times in one turn | That of the tool |

Harness failures are ranked `high`, because they are bugs in OpenMausBot
itself.

## Installing it

```sh
openmausbot service install --sentinel [--data-dir DIR]
```

This writes the schedule into Sentinel's own folder (above) and prints the
commands that install it. It doesn't install anything itself, and it writes
nothing to the data dir. The scheduled command passes `--data-dir` and `--out`
explicitly, so the paths it prints are the ones the scan uses.

- **macOS:** a launchd agent `com.openmausbot.sentinel` with
  `StartInterval` 120, logging to `sentinel.log` in Sentinel's folder.
- **Linux:** a systemd user service and timer, `openmausbot-sentinel`, that
  runs every 120 s. It doesn't need root.
- **Windows:** prints a `schtasks` command that runs the same scan every two
  minutes.

`openmausbot service uninstall --sentinel` prints the commands that remove it.

### Which CLI the schedule runs

A schedule stores an absolute Node path and an absolute script path. When the
desktop app is installed, `service install --sentinel` uses the CLI the app
ships, whichever command you ran it from:

| Platform | Node | Script |
|---|---|---|
| macOS | `/Applications/OpenMausBot.app/Contents/MacOS/OpenMausBot` (or under `~/Applications`) | `…/Contents/Resources/server/openmausbot.js` |
| Ubuntu `.deb` | `/opt/OpenMausBot/openmausbot` | `/opt/OpenMausBot/resources/server/openmausbot.js` |

The app's own executable runs as Node with `ELECTRON_RUN_AS_NODE=1`, just as
the [MCP server](mcp-server.md#from-the-installed-desktop-app) does. App
updates replace both files in place, and a Node upgrade on the machine doesn't
affect them. An installed app from a release before Sentinel is skipped,
because its bundled CLI doesn't have the `sentinel` command. If no usable
installed app is found, the schedule uses the Node and
script that ran the command (a global npm install or a checkout). The command
then warns that the schedule breaks if either of those moves, for example
after an nvm upgrade or a fresh checkout.

### After an update

```sh
openmausbot sentinel --check-install
```

This reads the installed plist or unit and checks that its Node and script
paths still exist. It prints `stale install: … rerun openmausbot service
install --sentinel` if either path is missing. This matters because launchd
and systemd fail quietly when a path is gone: nothing reaches Sentinel's own
log, because Sentinel never starts. After moving the app, upgrading Node, or
changing which install you use, run `service install --sentinel` again and
reload the schedule with the printed commands.

Upgrading Sentinel itself is safe without a reinstall. `state.json` carries a
`version`. When a release changes its shape, the old state is dropped and the
next scan starts again: log offsets reset, and the counted-occurrence keys are
cleared. Issues stay in `issues.jsonl`, and the restarted scan counts only
occurrences newer than the newest one already there. So a reset loses at most
a tool result that landed late, and never counts anything twice. Deleting
`state.json` by hand does the same thing.

## Planned stages

1. **This stage:** the scanner, its CLI and the schedule.
2. **Health in the app.** A Health page and a row under Routines that list
   open issues, linked to their evidence, for people who can see that thread.
3. **Team friction report.** A digest of the issues that cost the most turns:
   daily, plus immediately when an issue crosses a threshold.
4. **Regression evals.** A fixed issue becomes a replayable case, so it is
   caught if it comes back.
5. **Opt-in community counts.** Only `sig`, `kind`, `origin`, `tool` and
   `count` are shared. No ids, no `title`, no text. This helps harness bugs that
   many installs share get fixed first.
6. **Autonomous fixer.** A triage and fix loop that takes harness issues,
   reproduces them against an isolated fixture, and proposes a change for
   review.
