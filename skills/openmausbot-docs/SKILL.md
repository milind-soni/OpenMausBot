---
name: openmausbot-docs
description: "Answer how OpenMausBot itself works and how to change it: settings, the data folder, approval levels, routines, engines, skills, teams, memory and self-hosting. Use when the question is about the app, not about the person's own project."
---

# OpenMausBot, documented

Answer from this install and from the app's own docs, in that order. Never
describe a setting from memory: read the setting, the file, or the page.

- **The `app_settings` tool first**, when you have it: `find` and `get` read a
  setting's live value and where it is in Settings, and `set` changes it the
  way the app does (a key goes through its secure card). Use the files below
  only for what it does not cover.
- **This install.** Every setting is a file under `~/.openmausbot/`, and
  `OMB_DATA_DIR` moves that folder. The file says what is set right now, unless
  an environment variable overrides it: the environment wins, because it is
  applied after `config.json` is read (`OPENAI_COMPAT_URL` over
  `openaiCompat.url`, `OMB_JEV_API_KEY` over the decision model's key, and
  `OMB_<PROVIDER>_API_KEY` over an engine's key). Before saying a change holds,
  check the value the running process actually loaded, and after a restart for
  what is read at boot: reading the file back alone proves nothing.
- **The docs.** One page per area: in a repo checkout under `docs/`, otherwise
  at `https://github.com/milind-soni/OpenMausBot/blob/main/docs/<page>.md`. A
  page explains why something is built that way and what happens if.
- When the two disagree the app wins, and say which one you checked. When
  neither has the setting, say it does not exist instead of inventing a name.
- Which AI engines work here, why one can't run and how it is connected (a
  subscription sign-in, a device code, an API key or a local program):
  `list_models` says, per engine. Repeat what it says; if you have not checked,
  say so rather than guessing about sign-in or billing.

## The data folder

| Path | Holds |
| --- | --- |
| `config.json` | Engine instances (`instances`), feature switches, saved keys, `budgets`, `signIn`, `decisions.retentionDays`. It contains secrets: read what you need, never quote a key back. |
| `bots.json` | One record per bot: its standing instructions (`soul`), model, folder, approval level, peers and look. |
| `bots/<botId>/SOUL.md` | A mirror of that bot's standing instructions. The record is the source of truth; `soulDrift` records that the two differed at the last turn. |
| `routines.json` | Routines, their runs, and webhook receipts. |
| `app-triggers.json` | Automations that fire on an app event. |
| `workspaces/<botId>/` | The bot's own folder: `MEMORY.md`, `memory/<topic>.md`, `memory/log/<date>.md`, its private `skills/`. |
| `skills-library/index.json` | Skills imported into the shared library: hashes, source, review state. |
| `skill-state/` | Per-bot skill imports and their revisions. |
| `checkpoints/` | Per-turn shadow-git snapshots of a bot's folder, for rewinding. |

Change a setting with `app_settings` when it has it. Otherwise `config.json`
is the one file meant to be edited by hand; `instances` are read at boot, so
changing one needs a restart. `bots.json` and `routines.json` belong to
the running app: change them through the app or its API, never by hand, because
a hand edit races the next save.

## Where a question goes

| The person asks about | Page |
| --- | --- |
| Approval levels, what a bot may do without asking | `approval-levels.md` |
| Bots, roles, the review before Create, ready-made templates | `presets.md` |
| A model or CLI the app does not ship | `custom-engines.md`, `opencode-go.md` |
| MCP servers of their own, or the app's own MCP server | `custom-mcp-servers.md`, `mcp-server.md` |
| Connected apps such as Gmail, Calendar, Slack or Notion | `composio.md` |
| What a bot remembers between tasks | `memory.md` |
| Timing, cron, time zones, paused and done routines | `routine-schedules.md` |
| The daily brief, and the checks that run before it | `proactive-routines.md` |
| Letting an app or a script message one bot, or a bot on another server | `bot-api.md` |
| Letting a script drive the whole server | `headless-cli.md` |
| Which model picks between bots, and whose key decides | `decision-model.md` |
| How a bot chooses a tool | `tool-selection.md` |
| Work one bot hands to another, and what wakes it | `runtime-contract.md` |
| Teams, shared departments, incidents | `team-sharing.md`, `team-cloud.md`, `team-incidents.md` |
| Self-hosting, a VPS, My Cloud | `self-hosting.md`, `deploy-vps.md`, `byo-vps.md`, `cloud-pro.md` |
| The same bots on more than one computer or a phone, an empty Inbox on a new device | `multi-device.md` |
| Where a bot's files go, and how to get them out | `files.md`, `bot-box.md` |
| Browser and computer control | `computer-use-integration.md`, `browser-packaging.md` |
| Voice, images, meeting notes | `voice-mode.md`, `image-generation.md`, `meeting-notes.md` |

## Rules that hold everywhere

- **Approval is per bot, not global**, and applies to that bot's next turn. Each
  level is a provider's own permission mode, passed through. A personal install
  starts at Full access; a hosted company workspace starts at Ask. A bot reading
  its own files never asks.
- **Routines are calendar rules.** Five-field cron plus an explicit IANA zone,
  and the scheduler wakes the bot at that time; no model checks the date. Never
  answer a schedule question with "check every morning instead".
- **Built-in skills are mounted by keyword, not kept on.** A message that
  matches a bundled skill's trigger terms carries its instructions for that
  turn, and the skill never appears in the bot's own list. A skill the person
  writes or imports is the opposite: listed, and owned by one bot.
- **Memory is local markdown.** `MEMORY.md` loads every turn, `memory/*.md` is
  read on demand, `memory/log/` is the bot's own record of its days. The files
  stay on this computer, but what a turn reads goes to the model provider that
  bot is set to, and with a helper model set the helper's provider reads it too.
  A Cloud moves the whole data folder off the computer; the app uploads it
  nowhere else, but anything else on this computer that copies the folder — a
  backup service, a synced home directory — takes it along.
- **Nothing is changed until you read it back.** After a change, read the file
  or the settings response again and say what it now holds; if it was
  `config.json`, say that a restart is what makes `instances` apply.

## When the person wants depth

Answer for this install first, then name the page above and its link as the
place to read more. Do not paste doc passages into the chat: give the file, the
setting and the value it holds now.
