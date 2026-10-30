# Conversation context compaction

Long direct conversations can summarize older exchanges before the next turn.
The full transcript, its branches and attachments are retained. The new session
gets a bounded summary plus recent exchanges; later turns resume that session.
A visible, expandable note explains what was summarized, even with tool chips off;
when no model wrote the summary, it says the agent continues from recent excerpts only.

## Exercise the real path

```sh
pnpm exec vitest run server/context-compaction.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/compaction-summary.test.ts server/context-budget.test.ts server/delta-context.e2e.test.ts
pnpm exec vitest run server/side-jobs.test.ts server/helper-model.e2e.test.ts
pnpm exec vitest run server/store.test.ts server/config.test.ts src/components/DigestChip.test.ts
pnpm test:packaged-server
```

The API fixture launches the shared isolated server and fake engine. It uses
`control-omb` for create, send, wait, edit and Stop. Its new manual operation is
`POST /api/bots/:id/compact` with `{ "threadId": "owned-thread-id" }`; this uses
normal turn admission, returns 202, and completes through that thread's ordinary
busy/idle state. The route accepts no agent-written summary or file path.
From 80% of a known window, the bot's 1:1 header shows the figure with a
**Compact now** button that calls this route (hidden again once a compaction
record is newer than the last reply).

## Rooms

A room turn resumes no stored session: every turn re-sends the room's
bounded recent transcript (but see Room sessions below). What grows is the
warm provider process a driver keeps between one bot's consecutive turns in
a room (Claude's idle reuse).
Each settled room turn records that bot's last measured prompt for the room's
thread (in memory, like the warm process itself) and the room wire carries it
as `memberContext`. From 80% the roster avatar gets a mark and a line under
the header offers **Compact now**: `POST /api/groups/:id/members/:botId/compact`
(202; 409 before a reading, 404 for a non-member). It runs nothing; the bot's
next turn in that room starts with the existing `sessionReset`, so a fresh
provider session gets the same bounded transcript every turn gets. Before a
room turn, a bot at or above `context.roomCompactAt` (default `0.9`, read like
`compactAt`) is compacted the same way without asking; `autoCompact: false`
turns that off, but not the button. Either way the room shows an activity line.
A reading lives only as long as the warm process it measures: it is dropped
when another member's turn dispatches on the same engine in that thread (the
driver replaces the thread's one warm process), and once it is older than the
session idle window or the thread's keep-warm hold, whichever ends later.

```sh
pnpm exec vitest run server/room-context.e2e.test.ts server/room-context.test.ts src/lib/context-warning.test.ts
```

The fixture proves a warm process is kept below the threshold or with
automatic compaction off, and replaced after Compact now and above 90%, and
that another member's turn replaces a bot's process and clears its warning.

### Room sessions (off by default, Claude Code only)

With `"context": { "roomSessions": true }` in config.json (or
`PATCH /api/config`; `OMB_ROOM_SESSIONS=1` / `0` wins over the file), a room
member whose own provider session is known to hold the room is sent only the
lines that session has not been handed, under one note, instead of the
bounded transcript again. The room remembers, in memory, which native session
ran each member's last turn in a thread, which lines it was handed and how
each read. A line that reads differently now than when it was shown is sent
again, marked as replacing the earlier copy: a teammate's report, whose row
is rendered from the request's state at that moment, and a line with an
attachment, which reads without its tag on the turn that carries the image
and with it afterwards. (A digest row is only given a file list where a
turn took a checkpoint, which room turns do not; it would be sent again
too.) With the setting off nothing is remembered or computed.

Only Claude Code is covered, and only when all of these hold: the CLI is new
enough to declare strict resume (2.1.267), and the turn mounts the
engine-hook channel (on unless `OMB_HOOKS=0`), which is how the harness hears
that the engine compacted a session. Codex, ACP agents, Pi, Muse Code and the
API models keep the call described above whatever the setting says, and so
does Claude Code without the hook channel.

Every other turn is the call described above, unchanged:

| When | The member's turn |
|---|---|
| Its first turn in the thread, or after a server restart | whole transcript |
| Another member's turn came between, on the same engine instance (the driver keeps one process per thread) | whole transcript |
| Its last turn failed, was stopped, held, timed out, or ended in another session than it began in | whole transcript |
| Compact now, or the automatic 90% threshold | whole transcript, fresh session, the usual line |
| **Claude Code compacted the session** (`PreCompact`, `SessionStart` with source `compact`) | whole transcript on the same warm session: it holds the CLI's summary now, not the room's lines. Also for a turn that was running when it compacted |
| Its last measured context here is at 80% or more of where the engine compacts (`OMB_CLAUDE_AUTOCOMPACT`, 200,000 tokens by default; the model's window when that is `auto` or `off`) | whole transcript, so no delta is handed to a session about to compact |
| **Its measured context here is lower than after its turn before, in the same native session** | whole transcript. A session's context only grows from one turn's end to the next, so it was compacted, trimmed or replaced, whatever the hooks said |
| Its last turn here ended more than ten minutes ago (the driver's own idle time, counted from when that turn ended, however long it ran) | whole transcript |
| It missed more lines than the window holds | whole transcript |
| Its model, folder, instructions, approval level, tools, connections or `claudeUserMcp` changed, or the engine instance was reloaded | whole transcript |
| A guest's turn | whole transcript, nothing remembered |

A compaction is therefore noticed in two ways: the engine's hook says so
while the turn runs, and, should the hook never arrive, the member's next
reading is lower than the last one kept for that session. A member's last
reading, its record and its place as last speaker are kept for as long as
its turn runs, up to a day (a turn never seen to end is given up after
that), whatever is dispatched in other rooms meanwhile; the record and the
last speaker are kept for the idle time after the member's last turn was
seen to end, the reading for the longer of a day and keep-warm's longest
window, plus two idle times, counted from the same moment. With the hook
delivered, no case is known that leaves a member without a line. What is
still not caught is a compaction on a turn whose hook was lost and whose
reading cannot show it, which is one of these:

- the turn reported no reading (the room keeps the one before, which is not
  lower);
- no earlier reading of that session is held to fall from: the session
  began on that very turn (a reset, a new session after another member's
  turn or a failed one, a refused resume), no turn in it reported a reading
  before, or the member's earlier turns in it ran while the setting was off
  or were not managed (the first room turn after the server starts can go
  out before the CLI's version is confirmed), the member's turn before
  waited more than a day on a person (an open card holds a room turn past
  every timeout; the turn is given up after a day, so its end is not seen
  and it leaves no reading), or the module forgot the thread after a fault
  of its own (it logs one line with the thread's id). The setting case is by design:
  switching it off forgets every reading, so when it is switched on again
  while a session is warm, the first turn back is a start that goes on in
  that session, and a compaction on it has nothing to fall from;
- the turn went on to grow the session past its earlier reading (a long
  turn that began in a small session, or one that compacted early and
  worked on).

The member's next turn is then sent only the new lines although its session
holds the engine's summary in place of the earlier ones, and so is every
turn after it: the session's context grows again from the summary, so no
later reading falls, until another rule in the table gives a start (another
member's turn on the instance, ten quiet minutes, a turn that did not
complete ok, the 80% rule, the room's own reset, or a later compaction
whose hook arrives or whose reading falls). On main the same warm session
would be sent the last lines again on every turn.

Prompt-cache keep-warm (`cacheKeepWarm`, off by default) holds a member's
Claude process past the ten minutes, for its window (three hours by
default, a day at most), and the end of a hold arms the driver's idle timer
once more. It changes nothing about when a member is resumed: a turn more
than ten minutes after the member's last turn ended is a start whatever the
process did. It changes which session that start goes on in: the kept
process takes it, so the session holds more than the record says (safe: a
line sent twice at worst, as on main), and a compaction on that start with
its hook lost is seen only by a reading that outlived the process, which is
why a reading is kept for keep-warm's longest window plus two idle times,
one idle time longer than the process can live after a turn seen to end.

If Claude Code cannot reopen the session, the driver starts a new one from
the whole turn and says so in the room, as it does in a 1:1 chat. Two things
the harness cannot see can make the driver reopen the recorded session from
disk where the turn would otherwise have started a new one: a warm process
that ended by itself, and a change in something only the driver keys its
process on (the project's `.mcp.json`, the account's credentials, a base URL,
a model alias). The session reopened is the recorded one and holds what the
room says it holds; what that costs has not been measured.

```sh
pnpm exec vitest run server/room-sessions.e2e.test.ts
pnpm exec vitest run server/host/room-sessions.test.ts server/host/room-transcript.test.ts server/room-context-settings.test.ts
```

The fixture wraps the fake Claude so every launch records its `--resume` or
`--session-id`, and reads the exact text each room turn's engine received.
It proves: with the setting off a second turn is the whole transcript on the
warm process, as before; with it on, the second turn holds only the new lines
in the same process; a turn after another member's is the whole window on a
new session; so is a turn after a failed one and after a stopped one; Compact
now starts a fresh session with the usual line, and the next turn is a delta
against it; a line posted with `post_to_room` while the member worked arrives
once, in its next turn, under its provenance note; a refused `--resume` ends
with the whole turn on a new session and the driver's notice; after the fake
CLI compacts the session (its hooks reach the harness with the room's thread
and the member) the next turn is the whole window again. No real engine
runs: what a live Claude Code session costs across a resume is not measured
here.
## ACP agents' own readings

An ACP agent reports how full its context is (`usage_update`: `used`, and the
window as `size` when it sends one). A 1:1 conversation shows those figures,
and they are for the meter only: the ACP driver marks its reading
`contextReading: "meter"`, so the fold before a 1:1 turn is still timed from
the transcript estimate and the model's window, and a room keeps no reading
for an ACP member (no mark, no automatic fresh session, 409 from the room's
Compact now). The 1:1 header's warning and its button follow the shown figure.

```sh
pnpm exec vitest run server/acp-context-reports.e2e.test.ts server/context-budget.test.ts
```

The fixture runs each 1:1 scenario twice, with the fake agent silent and with
it reporting, and requires the same compaction at the same turns: a 95% report
folds nothing at the default threshold, a near-empty report does not postpone
a fold the transcript has reached, and a room member reporting 95% keeps its
session.

Evidence covers:

- Automatic compaction keeps the two latest exchanges and the incoming request.
- A completed turn retains the driver's latest-prompt measurement, separately from summed input tokens.
- Claude compaction leaves headroom before the selected account's numeric native threshold, including after a previous compaction; `auto` and `off` do not invent a numeric native limit.
- Manual compaction executes no additional agent turn and retains the original messages.
- A repeated request at the same compacted tip is a no-op.
- Restart before the next send retains the summary and replaces the native session once.
- A later send keeps that replacement session instead of injecting the summary again.
- Editing an old message replays its selected branch, not the abandoned summary.
- Stop aborts a hanging helper without a late record; a new send still works.
- With the `helper` setting naming an instance, a bot on an engine with no tool-free one-shot for the summary (the fake Pi and the fake Codex) gets a model-written summary from that instance, booked as a helper call; without the setting, or with the bot switched to never use the helper, the Pi bot keeps the excerpt summary.
- Private session bookkeeping stays off the task wire shape; stored summaries redact secrets.

Each API fixture retains exact requests, waits and bounded transcripts in
`<server-log>.context.json`, prints that location, and closes its exact child and
temporary home. No live account, computer or user workspace is touched.

## Tool history in a rebuilt session

A session rebuilt from the inline replay (an engine switched in mid-thread, a
rewind, a session the provider lost, a compaction) is sent what was said. With
`context.replayToolHistory: true` in config.json, or `OMB_REPLAY_TOOL_HISTORY=1`
in the server's environment (`0` forces it off), that replay also names each
earlier tool call on one line, between the two messages it ran between, as
`[ran: Bash: pnpm test — failed]` or `[ran: Read: server/config.ts — ok]`. It is
off by default, and off the replay is byte-for-byte what it was.

```sh
pnpm exec vitest run server/replay-tool-history.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/replay-settings.test.ts server/turn-context.test.ts server/config.test.ts
```

The fixture's engine runs a command and reads a file each turn. The test rewinds
with `control-omb edit` and reads the prompt the engine received: no such line
while the setting is off, both lines in order once it is on (the command, and
the file read), and the plain message for every turn that resumes its session.
It then switches the bot to the fixture's Codex and reads what that engine was
sent: the lines for each of Claude's turns. Its evidence is
`<server-log>.replay-tools.json`.

A line shows the tool, what it acted on and `ok`, `failed` or `no result
recorded`. What it acted on is the command beside the chip in the chat, or, for
a call whose chip shows none (a `Read`, a search), one argument from the input
preview behind the chip: the command, file, search pattern or query. A web
address is cut to its scheme and host (`https://hooks.example.com`), wherever it
is the whole target, so no path, query string or password in it is sent. An
input that is one plain string (a Codex web search's query) is used only when it
is a single line of at most 200 characters. Never a tool result, and nothing
else of the preview (a `Write`'s content, an `Edit`'s old and new text).

Each line is put on one line, redacted, cleared of anything that would open a
harness note (`escapeNotes` in `server/peer-provenance.ts`), then clipped to 120
characters; a long path keeps its end. At most 20 lines are sent, the most
recent, only for calls between the first and last replayed message, and only
from the bytes of `rebuildBytes` that messages left unused: the messages
selected are the same with the setting on or off. Engines that replay natively
(API models sent the transcript itself) and room turns are unchanged. A call is
still named without a target when its preview is arguments that hold none of
those at the top level. A URL inside a command is left as the command ran.

## Bounds and limitations

`context` settings in config.json are optional. `autoCompact: false` disables
automatic folding, `compactAt` is a fraction below 1 or a token count, and
`rebuildBytes` controls replay size (default 24,000 bytes). Context-only settings
do not reload provider processes. The default threshold is 80% of the known
model window; a real latest-prompt measurement wins over a transcript estimate,
except an ACP agent's own reading, which is shown and does not time compaction.
Summed input tokens across tool rounds are never treated as context size.
For Claude, the threshold and post-compaction regrowth floor also leave 10%
headroom below the selected account's numeric native-compaction setting.
That account's setting takes precedence over the inherited launch environment.
Native `auto`/`off` settings supply no known numeric bound; other engines keep
their own model-window threshold. The native CLI setting itself is unchanged.

The selected account's tool-free helper can produce a historical summary, with
a 20-second timeout and source-labelled fallback when unavailable. Summaries
are capped at 6,000 bytes and retain recent source corrections. The helper may
incur provider usage; its one-shot cost is not separately reported by the current
provider interface. Summaries are not verified facts and can omit details.

An engine with no tool-free helper for the summary (Pi and Muse Code, which have
none at all, and Codex and the ACP engines, whose one-shot starts a whole agent
process and is kept for background work) keeps the source-labelled fallback
unless a helper model is set ([the memory guide](../memory.md), "The helper
model"). That instance then writes the summary under the same 20-second timeout
and fallback, and its call is one usage row with the trigger `helper`. A bot
switched to never use the helper (`helperModel: false`) keeps the fallback.
`server/helper-model.e2e.test.ts` boots its own server in a throwaway home with
the fake Claude, Codex and Pi engines, once with the setting and once without.

This slice covers direct threads. It does not add channel compaction, change
provider-native compaction, prove live-model summary quality, or ship native
iOS/Android compaction controls. The renderer test checks note markup and escaping,
not a real browser click. Native mobile indicators remain separate PR work.
