# Bot memory

Every bot keeps notes between tasks. The notes are plain markdown files in a
folder on the computer running OpenMausBot — nothing is stored anywhere else,
and you can open, edit, or delete any of it in any editor. **Bot Settings →
Memory** shows the same files with a gauge of how much of them actually loads,
an editor that never overwrites something the bot wrote while you were typing,
and a journal of every change with one-click undo.

## Where it lives

```
~/.openmausbot/workspaces/<botId>/
├── MEMORY.md            the notes that load into every conversation
└── memory/
    ├── <topic>.md       longer notes the bot reads on demand
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
sentence *only the first 200 lines load each turn*. When it goes red, trim
`MEMORY.md` or move notes into a topic file; the bot is told the same thing in
its prompt.

Both limits are `MEMORY_MAX_LINES` and `MEMORY_MAX_BYTES` in
`server/workspace.ts`; the panel, the loader, and the bot's prompt all read the
same two constants.

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
- **Topic files** are ordinary markdown. A topic may begin with a small YAML
  frontmatter block (a title, tags) and may link to another topic with an
  Obsidian-style `[[wikilink]]`; Obsidian renders both, and the app leaves
  them as text. A pointer in `MEMORY.md` to a topic (`see memory/clients.md`)
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

All of them need the owner (admin) session, like the other bot-settings routes.
