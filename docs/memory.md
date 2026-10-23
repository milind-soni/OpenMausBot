# Bot memory

By default, bots keep notes between tasks. The notes are plain markdown files in a
folder on the computer running OpenMausBot — nothing is stored anywhere else,
and you can open, edit, or delete any of it in any editor. **Bot Settings →
Memory** shows the same files with a gauge of how much of them actually loads,
an editor that never overwrites something the bot wrote while you were typing,
and a journal of every change with one-click undo.

The **Let this bot use memory** switch is on by default. Turn it off while the
bot is idle to stop loading `MEMORY.md` into new turns, stop automatic recall
and upkeep, hide native memory tools, exclude memory files from `session_search`,
and stop automatic daily turn logs. Existing files remain for review. A bot
with filesystem access can still edit those files directly; use standing
instructions to forbid that when memory must stay in another source of truth.

## Where it lives

```
~/.openmausbot/workspaces/<botId>/
├── MEMORY.md            the notes that load into every conversation
└── memory/
    ├── <topic>.md       longer notes the bot reads on demand
    ├── archive.md       older notes moved out of MEMORY.md, and expired ones
    └── log/
        └── 2026-09-10.md   what the bot did that day, in its own words
```

The folder is the bot's private workspace: the directory its file tools work in
when it has no project folder set. It is created the first time the bot runs a
turn. **Open in Obsidian** and **Show in Finder** (Explorer, or your file
manager) in the Memory panel open this folder; because it is on the server's
disk, those buttons only work from the computer running OpenMausBot — a
paired phone or a remote browser is shown the path instead.

Files are written with owner-only permissions (`0600`), atomically (a crash
mid-write leaves the old file intact, never a torn one), and anything that
looks like a credential — API keys, tokens, `password: …` lines, private key
blocks — is replaced with `«redacted N chars»` before it reaches disk. A bot
that helpfully "remembers" a key it read from a `.env` does not get to keep it.

## What loads, and the budget

At the start of every turn the **first 200 lines or 24 KB of `MEMORY.md`,
whichever cuts first**, are placed into the bot's system prompt. Nothing past
that line loads, and the bot is only told that the file was cut off. Topic files
and daily logs are never loaded automatically; the bot reads a topic file with
its file tools when it decides it needs it, and logs are for you.

The gauge at the top of the Memory panel is that rule made visible: lines and
size against the budget, amber from 80%, red once anything stops loading —
with the count of lines that are not being loaded, and always the plain
sentence *only the first 200 lines load each turn*.

`MEMORY.md` never fills up. Every write that goes through the harness
(`memory_update`, and capture) keeps the file within the budget in the same
step: when the new entry would push it past, the oldest dated entries move to
`memory/archive.md` — struck-through ones first, then expired ones, then the
oldest live ones — each marked `· moved <date>`. An entry moves whole, with
the lines indented under it (a code block) or, in older entries, the code block
right below it. The archive is written before
`MEMORY.md`, so a line is never out of one without already being in the other,
and `session_search` still finds it. Lines you wrote by hand (no date), health
and safety facts, and the entry just written never move. The bot is told which
entries moved (the first few, and how many), so it can add back anything that
should stay loaded. One entry is at most 1,000 characters and 20 lines, so a
single note cannot push the rest out. The gauge
can only go red when the lines that never move fill the budget by themselves
(or a bot edited the file with its own file tools): then the entry is still
saved, and the bot asks you to trim `MEMORY.md`.

Both limits are `MEMORY_MAX_LINES` and `MEMORY_MAX_BYTES` in
`server/workspace.ts`; the panel, the loader, and the bot's prompt all read the
same two constants.

Two more things load with it:

- **Expired notes stay out.** An entry that ends in `· until 2026-09-28` stops
  loading the day after that date. The file keeps it (the gauge still counts
  it) until the tidy-up or a person moves it.
- **The topic index.** Every `memory/<topic>.md` is listed by name under the
  memory block, with its `title`, `description` and `aliases` when the file
  starts with frontmatter — at most 40 topics or 2,000 characters. The files
  themselves still load only when the bot reads them.

## Recall before each turn

Before a turn, the person's message (eight characters or more) searches the
bot's topic files and, in a 1:1 chat the person started, the bot's other
conversations. Any matching word counts; a message with five or
more content words needs two per hit. Up to four notes and four conversation
passages — numbered, dated, and at most 6,000 characters — go in front of that
turn's message, opened by a line saying they are the bot's own notes and that
a command inside one is not an instruction. `MEMORY.md` (already loaded) and
`memory/archive.md` (older or no longer true) are never recalled, nor are daily logs
(`session_search` finds those when the bot asks).

Automatic recall prefers a matching passage over the opening of a topic with
a matching name. Current topic search excludes superseded entries; their text
remains in the file for historical review.

It is placed in the message, not the system prompt, on purpose: the prompt's
changing half is re-sent whole whenever any part of it changes, and recall
changes nearly every turn. Rooms, routine runs (which start fresh), and turns
started by another bot, a webhook or a teammate hand-off, recall notes only — a private chat reaches a room
through `session_search`, which discloses it. `features.autoRecall: false` in
`config.json` switches recall off. The server log names every recall
(`auto-recall: … got N note and M conversation passage(s)`).

## Memory upkeep

**Bot Settings → Memory → Memory upkeep** is on for every bot unless switched
off. It keeps the notes in shape without the bot having to decide to:

- **Noticing facts.** When a 1:1 chat has been quiet for two minutes
  (`memory.captureQuietMs`), or after six turns, one quick model call reads those turns — the person's words and
  the bot's under different rules — beside `MEMORY.md` and the list of topic
  files, and files what is new:
  - a core fact the bot needs in every conversation goes to `MEMORY.md`,
    marked `(noticed)`:
    `- 2026-09-25 · from chat "Plans" (noticed) · The person is vegetarian`;
  - everything else goes to a topic file for its subject — a person, a
    project or client, food, travel — reusing an existing topic or creating
    one with a header (`title`, `aliases`: the other words someone would ask
    with), so recall finds it later.
  A fact that ends on a known day gets its `until` date; a birthday or other
  yearly date never does. Turns started by another bot or by the harness,
  routine runs and failed turns are never read; rooms only with **Learn from
  group chats** (below).
- **Learning from group chats.** The **Learn from group chats** switch under
  Memory upkeep (`features.roomMemoryCapture`, one switch for every bot,
  off by default) lets a member bot's room turns feed its capture the same
  way, batched per bot and room. What the bot read since it last spoke
  there is read with its reply, under room rules: the person's own lines
  count as theirs; another person's lines give only facts about the shared
  work and never reach About me (a batch holding them adds nothing to About
  me); another bot's lines give only an outcome it verified or a decision
  the person agreed to, never its suggestions or claims. A stretch with no
  person's words is skipped. Entries are sourced to the room:
  `- 2026-09-25 · from room "Launch" (noticed) · The launch moved to Friday`.
  A room fewer people can see than the bot never feeds it (the same rule as
  the recent-work brief), checked again when the batch is captured, as are
  the switch and the bot's membership. Bot-to-bot channels, room hand-offs,
  goal runs and, on a Cloud home, every room are left out.
  Turns still waiting when the app quits or restarts through its normal
  shutdown are kept as their ids (never their text) in
  `memory-capture-pending.json`, at most 50 chats, and read back from the
  chat at the next start, so what was said just before quitting is still
  noticed. A crash or a forced kill skips that step (on Windows a `SIGTERM`
  is one), and those turns are not captured. A chat deleted or rewound
  meanwhile leaves nothing to read.
- **Organizing.** Whoever wrote a line in `MEMORY.md` — the bot with
  `memory_update`, the person, or capture — after each capture and in the
  nightly tidy-up one quick model call looks at lines not judged before and
  moves the ones that are detail about a subject (another person, a project
  or client, a trip, likes in one domain) into that subject's topic file,
  unchanged, creating it with a header and other words for it. Core facts —
  the person's name, where they live, their company, diet, allergies and
  health needs, how they like replies — always stay; a line about diet,
  allergies or health is never even offered for moving (a fixed rule, not the
  model's choice), and a line judged core is not asked about again. At most 20 lines move in one pass; each file's change
  is a journal row (*filed into topics*) that can be undone.
- **About me.** A lasting fact about the person, taken from their own words,
  is added to **Settings → General → About me**, which every bot reads, as a
  dated line `- 2026-09-25 · learned by Scout · …`. **Added by your bots**
  under About me lists each one with **Remove**; a removed fact is never
  added again. On a shared installation, another person's messages never add
  to the owner's About me.
- **Nightly tidy-up.** Once a day after 3 am (`memory.tidyHour`), or at the
  next check if the computer was asleep, never while the bot is working, and
  on **Tidy up now**: expired entries move to `memory/archive.md` (from
  `MEMORY.md` and topic files); of two entries with exactly the same fact the
  newer stays; and in `MEMORY.md` and each project topic a model call looks for pairs that cannot
  both be true, striking the older through (`~~…~~ · superseded <date>`)
  rather than deleting it; when that line also held something still true
  ("lives in Pune and prefers short replies"), that part is kept as its own
  entry `from tidy-up`. At most a fifth of the entries can be struck in one
  pass in core memory, and none in a core file of fewer than five. Topic files
  may reconcile one pair even with two entries; writes recheck for concurrent edits. The archive is written before
  the file it came from, so undoing the newest change never loses a line.

"Exactly the same fact" is narrow on purpose: spacing, a bullet and a final
full stop are ignored, nothing else — `Balance is -10` and `Balance is 10`,
`C++` and `C`, `1.5` and `15` are different facts.

Every upkeep change is a journal row by **Memory upkeep** and can be undone.
Upkeep pauses while a backup runs. The model steps need an engine with a
one-shot text call — Claude, Codex, Grok, OpenAI-compatible, Mistral and
MiniMax, and the agent engines that speak ACP (Grok CLI, Gemini, Kimi, Droid,
Cursor, OpenCode, Qwen, Hermes, Antigravity and custom ACP agents). On an ACP
engine each call starts the engine's own CLI in a fresh session of its own,
never a chat's, in an empty folder, with no MCP servers and in the ask-first
approval mode; it is refused and dropped the moment the agent asks for a
tool, a file or a permission. On Codex each call is one `codex exec` on the
same sign-in, in an empty folder with a read-only sandbox, no session saved,
without the person's `config.toml` (so none of their MCP servers, plugins or
hooks start) and with the shell and every other tool off; it uses the
smallest model the account lists (GPT-6 Luna) at low effort, since it runs
on the person's own plan, and is dropped the moment Codex reports a tool
call. The text goes only to the provider the bot already uses. On any other
engine (Pi and Muse Code, for now) the panel says so — under Memory upkeep
and under Learn from group chats — and only the expiry and exact-duplicate
steps run, unless a helper model is set.

### The helper model

A helper model fills the gaps an engine leaves. It is one connected provider
instance, and optionally one of its models, that writes a small background
text a bot's own engine cannot write:

- memory upkeep's steps and the automatic skill review, for an engine with no
  quick text call at all (Pi and Muse Code, for now).

Conversation checkpoints use the selected engine's separate tool-free streaming
checkpoint capability. They do not use the generic helper. Unsupported engines
retain the original history instead of replacing it with a freeform or excerpt
summary; a manual compaction request reports the unsupported capability.

A bot whose own engine can write a job always writes it itself; the helper
never takes its place.

It is off unless you set it. Add it to `config.json`; the server follows the
file, so adding the helper or taking it out again applies without a restart:

```json
{ "helper": { "instanceId": "claude", "model": "claude-haiku-4-5" } }
```

or set `OMB_HELPER_INSTANCE` (and, if you want, `OMB_HELPER_MODEL`) in the
server's environment before it starts. The environment wins over the file,
and an empty `OMB_HELPER_INSTANCE` switches a saved helper off. `instanceId` is the id of
a connected instance as `config.json` and `GET /api/instances` name it, such
as `claude`, `claudeApi`, `openai` or `openrouter`; it has to be Claude or an
API model, the engines with a quick text call of their own. `model` is
optional: without it the instance uses the model it already uses for quick
calls. There is no Settings screen for this yet, and Settings still describes
each engine by its own abilities: the line under **Learn skills
automatically** that says bots on an engine won't learn skills this way does
not know about the helper.

**What leaves the bot's provider.** With a helper set, the text those jobs
read is sent to the helper's provider, which may not be the one the bot runs
on: the turns being captured, the bot's memory notes, and the conversation and
skills under review. That is why it is
opt-in. It applies to every bot whose engine cannot write the job, including
one you run on a local model, unless you keep that bot off the helper (below).
An engine your organisation does not allow is never used as the helper, and
on a hosted workspace only a model assigned to it is.

**Keeping one bot off the helper.** Any bot can be switched to never use the
helper model: send `PATCH /api/bots/<bot id>` with `{ "helperModel": false }`
(there is no Settings switch for it yet). From its next job on, the helper
writes neither memory upkeep nor skill review for that bot. For those jobs
the bot gets what it would get
with no helper set.

The switch covers that bot's own jobs and nothing else. What the bot says in
a room, or in reply to a teammate, becomes part of the other bots'
conversations. Their engines read it, and so does whatever writes their
background jobs, the helper included. The switch does not change that. To
keep a bot's text on the machine, run it on a local model, switch it off the
helper, and keep it out of rooms and teams with bots that are not set up the
same way.

The switch is saved with the bot, and a copy made with **Duplicate** keeps
it. It travels in a full workspace backup and in a team backup, the two
exports that hold a bot's notes and chats, so a restored bot stays off the
helper. A shared team package carries no personal settings and does not carry
this one.

A helper that is missing, switched off, failing or slow leaves the job with
the same fallback as no helper: no capture and no review. The server log says
once why the helper is not used. Helper calls
count toward the monthly spend limit and stop at it. Each is its own row in
**Settings → Usage → History**, for the bot it wrote for, with the helper's
engine and model: group by **Person** to see them together as *Helper
model*, which is also what the CSV's `triggered_by` column says.

## Editing

`MEMORY.md` and every topic file can be edited in the panel. A save carries
the hash of the text you opened; if the bot changed the file in between — it
writes with `memory_update` during a task, or with its own file tools — the
save is refused and the panel says so: *Scout changed this file while you were
editing.* **Reload** shows the bot's version and keeps your draft under the
editor so nothing you typed is lost; **Overwrite with mine** saves yours over it.
Either way the change is in the journal and can be undone.

Daily logs are read-only in the panel (they are the bot's own record) but can
be deleted. `MEMORY.md` can be emptied but never deleted — the bot expects it
to exist. Topic names are one file name under `memory/`: letters, numbers,
spaces, dots and dashes, ending in `.md`. Nothing nested, nothing starting
with a dot.

The old whole-file `PUT /api/bots/:id/memory` still works for one release; it
has no hash check, so it can overwrite what the bot just wrote. Clients should
move to `PUT /api/bots/:id/memory/file` with `expectedHash`.

## What a bot knows about its other conversations

A bot's 1:1 chats and its rooms are separate conversations, and its memory
holds only what stays true — so on its own, a bot answering in a room had no
idea what it did in its 1:1 an hour earlier, and a morning standup ended in
guesses. Three things close that gap without attaching transcripts:

- **The recent-work brief.** Every turn's system prompt, 1:1 or room, carries
  a short block: the newest thing the bot said in each of its *other*
  conversations over the last two days — `today 09:05 · 1:1 with Milind ·
  "Invoice reconciliation" · you said: "Sent the three flagged invoices…"`.
  At most ten lines and about 350 tokens; the current conversation is not
  listed. When a brief in a room names a private 1:1 chat, the room gets a
  chip — *Lead's recent-work brief covers 1 private chat with you* — once per
  chat, the same rule as recalled messages.
- **One log line per finished turn when memory is on.** The harness appends what the bot said
  last, the tools it used, and whether the turn failed to
  `memory/log/YYYY-MM-DD.md`, sourced to the chat or room. The log is never
  loaded into a prompt; `session_search` finds it.
- **Recall by time.** `session_search` takes `since` (`"24h"`, `"3d"`,
  `"yesterday"`, or a date) and `until`, with or without words, and covers
  the rooms the bot is a member of as well as its 1:1 tasks. "What happened
  since yesterday's standup" needs no keyword. Hits name the room or task
  they came from; a private chat recalled into a room is marked, and the
  room is told.

A daily standup is then a room routine: the chief asks, each member answers
from its brief and pulls detail with `session_search since`, and what was
agreed shows up in each member's next 1:1 brief.

## The journal

Every change to a memory file that the app can see is recorded — yours from
the panel, the bot's during a task, an import, an undo — in
`~/.openmausbot/memory-journal/<botId>.ndjson`. It lives *outside* the
workspace on purpose: the bot's file tools point at the workspace, and a
record the bot could edit would not be a record.

Each row says who (bot, person, or import), how (in Settings, during a task,
from which chat, changed outside the app, undo), which file, when, the
before/after hashes, a short diff, and the full earlier text so **Undo** can put
the file back without anything else. Undo is itself a journaled change, so it
can be undone in turn. Two kinds of row cannot be undone and say so: one
whose earlier text contained a credential (the stored copy is redacted, and
restoring it would write the redaction marker into the bot's memory), and one
whose earlier text was too large to keep.

Bot writes are caught at the turn boundary. When a turn starts, the app notes
what every memory file says; when the turn ends, whatever differs is recorded
as the bot's work for that chat. A file that changed between turns — edited in
Obsidian, say — is recorded as yours, *changed outside the app*. Two of the
same bot's threads running at once are both diffed; a change lands under
whichever thread finished first. Journaling never fails a turn: a row that
cannot be written is logged and dropped.

## Conventions inside the files

The files are yours and the bot's, and any markdown is fine. The app itself
reads them as plain text and never requires a structure. The conventions the
bot follows when it writes are:

- **Dated entries in `MEMORY.md`.** A note the bot adds during a task is one
  bullet with its date and the chat it came from:
  `- 2026-09-10 · from chat "Follow-up" · the user prefers short replies`.
  A person's hand-written bullet without a date is just as valid.
- **Superseded, not deleted.** When a fact is replaced, the old bullet is
  struck through and dated rather than removed —
  `- ~~the office is in Pune~~ · superseded 2026-09-10` — so the file itself
  shows what changed. Struck lines still count against the budget; trim them
  when the file fills up.
- **Daily logs** under `memory/log/YYYY-MM-DD.md` are the bot's diary of what
  it did; they are never loaded into a conversation and are meant for you to
  read in the panel or in Obsidian.
- **Until dates.** A fact that stops being true on a known day ends with
  `· until YYYY-MM-DD` (`memory_update` takes an `until` field for it) and
  stops loading the day after.
- **Topic files** are ordinary markdown. A topic may begin with a small YAML
  frontmatter block — `title`, `description`, and `aliases` (other words for
  the topic, since notes are found by matching words) — which the topic index
  reads, and may link to another topic with an Obsidian-style `[[wikilink]]`,
  which the app leaves as text. A pointer in `MEMORY.md` to a topic (`see memory/clients.md`)
  is how the bot knows the topic exists.

Nothing about the panel depends on these: an older `MEMORY.md` written in
free form, or one you rewrite by hand, works the same.

## Routes

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/bots/:id/memory` | Overview: gauge numbers, topic and log lists, the folder path. |
| `GET` | `/api/bots/:id/memory/file?path=` | One file's text and hash (`MEMORY.md`, `memory/<topic>.md`, `memory/log/<day>.md`). |
| `PUT` | `/api/bots/:id/memory/file` | `{ path, text, expectedHash? }` — `409` with the current text when the hash no longer matches. |
| `DELETE` | `/api/bots/:id/memory/file?path=` | Removes a topic or log; refuses `MEMORY.md`. |
| `GET` | `/api/bots/:id/memory/journal?limit=` | Recent changes, newest first. |
| `POST` | `/api/bots/:id/memory/journal/:entryId/revert` | Puts the file back to that row's earlier text. |
| `POST` | `/api/bots/:id/memory/open` | `{ target: "obsidian" \| "folder" }` — opens the folder on this computer; loopback only. |
| `GET` | `/api/bots/:id/memory/upkeep` | Whether upkeep is on, whether the engine can run the model steps, and the last tidy-up and capture. |
| `POST` | `/api/bots/:id/memory/tidy` | Runs the tidy-up now (`409` when upkeep is switched off) and returns its report. |
| `GET` | `/api/profile/learned` | Facts bots added to About me on their own, newest first. |
| `POST` | `/api/profile/learned/:id/remove` | Takes that line out of About me; the fact is never added again. |

All of them need the owner (admin) session, like the other bot-settings routes.

## Shared team memory integrity

Team memory ownership uses persistent keys. Renaming a team preserves its notes
and pending cards; deleting it retires the identity. Creating a new team with the
old name never restores the retired notes. Existing version-1 team-memory files
migrate atomically to version 2. Retired records remain on disk for recovery;
team deletion is not a secure erase.

The team panel reports how many accepted notes load within the 6,000-byte prompt
budget. Pin essential rules to load them first. Omitted notes remain available
with `session_search {"scope":"team","query":"..."}`; ordinary search also
includes accepted team notes. Proposals, superseded entries and deleted entries
are excluded. A stable `key`, such as `tapa/sequence-02/colour`, lets a reviewed
correction replace the same fact even when its title changes. The previous
accepted entry remains in history. Recent text versions (up to 50) can be
restored from the panel; restoring text is a new revision.

Every panel edit, delete or acceptance carries the revision it was based on.
Stale writes return 409; writes without a revision return 428. Reloading after a
conflict retains the unsaved draft for comparison. Pending replacement cards
also refuse approval if the accepted fact changed since the proposal.
