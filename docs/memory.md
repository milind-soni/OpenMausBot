# Bot memory

Every bot that runs on a local engine keeps its own notes in plain markdown under `~/.openmausbot/workspaces/<botId>/`:

| File | Role |
|---|---|
| `MEMORY.md` | Durable notes. A selection of it rides the system prompt on every turn. |
| `memory/<topic>.md` | Longer material the bot reads on demand with its file tools. |

You can read and edit both from **Settings → Memory** on the bot, or open the files in any editor. The bot writes them with its own file tools. Bots on engines without a private workspace (Grok API, box agents) have no memory; the Memory card says so.

## The format

`MEMORY.md` has six sections. One entry per bullet. An entry can start with a marker that says when it was learned and where it came from.

```markdown
## Preferences
- (2026-08-30) Prefers PR descriptions under 10 lines.

## Decisions
- (2026-09-02, supersedes 2026-07-11) Staging database is `staging-eu-1`; `staging-1` was retired.

## Facts
- (2026-09-01, thread ab6c9339-…, msg 9aca80c9-…) The pricing page is owned by the growth team.
- A line with no marker is fine too.

## Procedures
- (2026-08-28) Deploy: `railway up --service workers`, then check the heartbeat.

## Episodes
- (2026-09-04, thread ab6c9339-…) Audited example.com/pricing: three broken links, report in that thread.

## History
- (2026-07-11, superseded 2026-09-02) Staging database is `staging-1`.
```

| Section | What goes there |
|---|---|
| Preferences | How you want things done. Always loads. |
| Decisions | What was decided, and what it replaced. Always loads. |
| Facts | What is true about you, your work, your systems. |
| Procedures | How to do something, step by step. |
| Episodes | What happened, dated. |
| History | Entries that were replaced. Never loads. |

The marker is `(YYYY-MM-DD, thread <id>, msg <id>, supersedes <date>, superseded <date>)`; every part after the date is optional. Ids are whole thread and message ids, the ones `session_search` returns, so a note can point back at the conversation it came from.

When a fact changes, the bot adds the new bullet with `supersedes <old date>` and moves the old bullet to **History** with `superseded <new date>`. It never deletes a line. A file with no headings still works: every bullet is a fact. Headings you add that aren't in the list are kept as they are.

## What the bot sees

The prompt gets a **selection** of `MEMORY.md`, not the file, and it's told so: read the file before editing it, never write the whole file back from the prompt.

The selection is 200 lines or 24 KB, whichever cuts first:

1. Preferences and decisions, up to 100 lines between them. If they don't fit, the oldest decisions drop first.
2. Facts, newest first.
3. Procedures, newest first.
4. Episodes, newest first.
5. Any other section.

History never loads. When the whole file fits, everything loads. When it doesn't, the oldest episodes go first, then the oldest facts, and the prompt says what was left out.

Before the selection reaches the prompt, anything shaped like a credential is masked. The file on disk is not changed.

## When memory is over budget

**Settings → Memory** shows a gauge: `142 / 200 lines · 9.3 / 24 KB`, and what won't load. The first time a bot starts a turn while over budget, it also posts one line in the conversation saying how much didn't load. It won't repeat that for the same state; saving memory from settings resets it.

## Recall beyond memory

`MEMORY.md` is what the bot chose to keep. Its earlier conversations are searchable too:

- `session_search` — "search my own earlier conversations for these words", ranked, across all of the bot's tasks. Only that bot's conversations, never another bot's.
- `session_read` — the whole message behind a hit.

The bot is told to search before asking you to repeat something, and before redoing work it may have done in an earlier task.

Search over `MEMORY.md` and the topic files is not there yet; the section-aware selection above is the interim.
