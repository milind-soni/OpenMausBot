# Profiles: your organization, its areas and their bots, in files

A profile folder describes an organization the way a company is organized: the **organization**, its **areas** (BI,
Sales…), the **bots** that work in each area, and the **MCP servers** they use. Each one is a Markdown file with YAML
front matter, so a bot's instructions read as plain text on GitHub. Keep the folder in a git repository: when two
people use the same commit, they get the same bots.

`edubot profiles check` reads and checks a folder without a server. Applying a folder shows a plan first and changes
the app only when you apply it ([Applying a folder](#applying-a-folder)).

## The folder

```
<folder>/                             the folder you pick (any folder, usually inside a git repository)
  org.md                              kind: organization (optional)
  areas/<area>/area.md                kind: area
  areas/<area>/bots/<bot>.md          kind: bot; the Markdown below the front matter is the bot's instructions
  areas/<area>/skills/<name>/SKILL.md a skill, as a standard Agent Skill
  mcp/<server>.md                     kind: mcp-server
```

Everything else is ignored: a README, `.git`, hidden files. A file inside `areas/` or `mcp/` that has no place in this
layout gets a warning, so a typo such as `areas/bi/bot/analyst.md` does not go unnoticed.

Each file starts with a front matter block: a line with `---`, the fields, another `---`. The text after it is the
organization's or area's brief, the bot's instructions, or an MCP server's notes for people.

### Keys

An area's key is its folder's name, and a bot's or MCP server's key is its file's name. The `key:` field must say the
same: 1 to 64 lowercase letters, digits or hyphens. A bot's identity is `<area>/<bot>` (`bi/analyst`). Keep keys
stable. To rename a bot, change its `name:`, never its key or file. `was:` can hold its old name for people reading the
plan.

## A complete example

This is the folder the tests use, `server/testing/fixtures/profiles/acme/`.

`org.md`:

```markdown
---
edubot: 1
kind: organization
name: Acme
maxApproval: auto
defaults:
  model: claude/claude-sonnet-5-5
  approval: ask
  eduCrew: false
mcpServers: [notion]
---
Acme sells garden tools in Chile. Answer in Spanish unless asked otherwise.
```

`areas/bi/area.md`:

```markdown
---
edubot: 1
kind: area
key: bi
name: BI
chief: analyst
stewards: [ana@acme.example]
eduBrain: { mode: area }
defaults:
  effort: medium
  tools: { allow: ["native:*", "mcp:edu:*", "mcp:notion:*"] }
---
The BI area turns sales data into weekly decisions. Numbers come from tools, never from memory.
```

`areas/bi/bots/analyst.md`:

```markdown
---
edubot: 1
kind: bot
key: analyst
name: Analista BI
title: Data analyst
description: Answers questions about sales with numbers from the data tools.
approval: auto
eduCrew: true
memory: { upkeep: true }
skills:
  - { file: ../skills/weekly-report/SKILL.md, enabled: true }
---
You are the BI area's analyst.

Check every number against its source before you report it.
```

`areas/bi/bots/reporter.md`:

```markdown
---
edubot: 1
kind: bot
key: reporter
name: Reporter
title: Weekly report writer
toolsOff: [images]
skills:
  - { file: ../skills/weekly-report/SKILL.md }
---
You write the weekly report from the analyst's findings, in plain words.
```

`areas/bi/skills/weekly-report/SKILL.md`:

```markdown
---
name: weekly-report
description: Write the weekly sales report from the week's numbers.
---
# Weekly report
…
```

`areas/sales/area.md`:

```markdown
---
edubot: 1
kind: area
key: sales
name: Sales
maxApproval: edits
eduBrain:
  mode: cloud
  url: https://brain.acme.example/mcp
  token: { secret: EDU_CLOUD_SALES }
---
The sales area follows up every lead within a day.
```

`areas/sales/bots/closer.md`:

```markdown
---
edubot: 1
kind: bot
key: closer
name: Closer
title: Sales follow-up
model: codex/gpt-5.5
approval: edits
connectors:
  gmail: { tools: [GMAIL_FETCH_EMAILS, GMAIL_CREATE_EMAIL_DRAFT] }
---
You follow up leads by email. You draft; a person sends.
```

`mcp/notion.md`:

```markdown
---
edubot: 1
kind: mcp-server
key: notion
description: Acme's Notion workspace
transport: http
url: https://mcp.notion.com/mcp
headers:
  Authorization: { secret: NOTION_TOKEN }
---
Each person fills NOTION_TOKEN with their own Notion integration token, written as "Bearer <token>".
```

## Fields

Every file needs `edubot: 1` (the format's version) and `kind:`, which must match its place in the folder. An unknown
field is an error, never ignored, so a misspelt field cannot silently do nothing.

### Organization (`org.md`)

| Field | |
|---|---|
| `name` | Required, one line, up to 100 characters. |
| `defaults` | Bot settings every bot gets unless its area or the bot sets its own (see [Inheritance](#inheritance)). |
| `mcpServers` | MCP servers every bot of the organization may use, by name. |
| `maxApproval` | The highest approval level any bot may have: `ask`, `edits`, `auto` or `full`. |
| body | The organization's brief. |

### Area (`areas/<area>/area.md`)

| Field | |
|---|---|
| `key` | Required; the folder's name. |
| `name` | Required, one line, up to 60 characters. |
| `chief` | The key of the bot that coordinates the area (its Chief of Staff). It must be a bot of this area. |
| `stewards` | Email addresses of the people who may approve the area's shared canonical memory. |
| `eduBrain` | The area's Edu brain, the same as setting it under `defaults` (set it in one place only). |
| `personalBrain` | `false`: the area's bots on an area brain do not read each person's own global Edu brain (`~/.edu`), so a bot cannot copy personal notes into the area's. A cloud brain never reads it. |
| `defaults` | Bot settings for the area's bots. |
| `mcpServers` | MCP servers the area's bots may use, added to the organization's. |
| `maxApproval` | The highest approval level an area's bot may have. |
| body | The area's brief, at most 24,000 bytes. |

### Bot (`areas/<area>/bots/<bot>.md`)

| Field | |
|---|---|
| `key` | Required; the file's name. |
| `name` | Required, one line, up to 100 characters, and unique in the folder (case does not matter). |
| `was` | An earlier name, shown in the plan when you rename a bot. |
| `title` | One line, up to 200 characters. |
| `description` | Up to 4,000 characters. |
| `mcpServers` | More MCP servers this bot may use, added to its area's and organization's. |
| `skills` | `- { file: PATH, enabled: true }`: a SKILL.md in an area's `skills/` folder, relative to this file. On unless `enabled: false`. |
| the bot settings below | The bot's own value wins over its area's and organization's. |
| body | The bot's standing instructions, at most 24,000 bytes. |

### Bot settings (a bot's own, or under `defaults`)

| Field | Values |
|---|---|
| `model` | `INSTANCE/MODEL`, such as `claude/claude-sonnet-5-5`. |
| `effort` | `none`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `approval` | `ask`, `edits`, `auto` or `full` ([approval-levels.md](approval-levels.md)). `custom` is set in the desktop app. |
| `tools` | `{ allow: [SELECTOR], deny: [SELECTOR] }`, as in [tool-selection.md](tool-selection.md). `allow: ["*"]` allows every tool. |
| `toolsOff` | Built-in tool groups switched off: `meetings`, `data`, `pages`, `images`, `email`. |
| `connectors` | Connected-app tools by app: `gmail: { tools: [GMAIL_FETCH_EMAILS] }` or `gmail: { tools: "*" }`. Each person connects their own account. |
| `eduBrain` | `{ mode: own }` (the bot's own brain, the app's default), `{ mode: area }` (one brain the area's bots share), `{ mode: cloud, url, token }` (an [edu-cloud](https://github.com/EduardoMoraga/edu-cloud) brain the team shares) or `{ mode: off }`. See [edu-brain.md](edu-brain.md). |
| `eduCrew` | `true` or `false` (the default). |
| `memory` | `{ enabled: true, upkeep: true }` ([memory.md](memory.md)). |

`eduBrain: { mode: folder }` is refused in a profile: a folder is a path on one computer.

### MCP server (`mcp/<server>.md`)

| Field | |
|---|---|
| `key` | Required; the file's name, and the server's name in the app: 1 to 32 lowercase letters, digits, `_` or `-`, starting with a letter. Edu Bot's own names (`edu`, `browser`, `agents`…) are refused. |
| `description` | One line. |
| `transport` | `http` or `sse` (a server reached by its address) or `stdio` (a command). |
| `url` | For `http` and `sse`: an `https://` address (`http://` only for this computer), with no user name or password in it. |
| `headers` | For `http` and `sse`: header name → value or secret slot. |
| `command`, `args`, `env` | For `stdio`: the command (a name on the PATH, such as `npx`), its arguments, and variable name → value or secret slot. |
| body | Notes for people: what the server is and how to get its key. |

A bot, area or organization can name a server that is not under `mcp/`; the check then warns that each person's app
must already have a server with that name.

## Inheritance

Each bot setting comes whole from the nearest level that sets it: the bot, then its area's `defaults`, then the
organization's `defaults`. `tools: { allow: [...] }` on a bot replaces its area's `tools` entirely; lists are never
merged. A `tools` without `allow` under a level that sets `allow` is an error, since it would allow every other tool;
to widen on purpose, write `allow: ["*"]`. A setting no level sets is left to the app's own default (for `eduBrain`,
the bot's own brain).

`mcpServers` is the one exception: a bot may use the organization's servers, its area's and its own, each listed once.

`maxApproval` limits the result: a bot whose approval, wherever it was set, is above its area's or organization's
`maxApproval` is an error. Under a `maxApproval` below `full`, some level must set `approval`, since the app's own
default is Full access.

`edubot profiles check FOLDER --json` shows each bot as it resolves, with `from`, the level each setting came from:

```json
{ "id": "bi/analyst", "approval": "auto", "effort": "medium", "eduBrain": { "mode": "area" },
  "from": { "model": "org", "effort": "area", "approval": "bot", "eduBrain": "area" } }
```

## Secrets

A profile never holds a key, token or password. Where a server or brain needs one, the file names a **secret slot**,
and each person fills it on their own computer:

```yaml
headers:
  Authorization: { secret: NOTION_TOKEN }
```

The slot holds the whole value the server expects (for example `Bearer …`). For CI, `{ env: NAME }` reads an
environment variable and `{ file: .secrets/NAME }` a file in the folder's `.secrets/` folder, which CI writes from its
own secret store before it applies the profiles. Add `.secrets/` to the repository's `.gitignore`: a key file is never
committed. The check never opens a key file.

The check refuses:

- a value shaped like a key anywhere in a file, YAML comments included: a provider's key prefix, a private key block,
  `Bearer …`, `token=…`. Each line is checked, and the whole file again with line breaks, indentation and invisible
  characters taken out, so a key split across lines is found too. A short base64 token, even with spaces or tabs
  inside, is decoded and checked the same way, read as bytes, UTF-8 and UTF-16;
- a header or variable whose name says it holds a credential (`Authorization`, `Cookie`, `*_TOKEN`, `*_KEY`,
  `*SECRET*`, `*PASSWORD*`…) written as plain text instead of a slot;
- a server argument after a flag that names a key (`--token VALUE`, `--api-key=VALUE`): pass the key in `env` with a
  slot;
- an address with a user name or password in it, anywhere in a file;
- an invisible or control character (a zero-width space, a direction mark, a non-breaking space, a form feed…)
  anywhere in the front matter, comments included, or anywhere in an MCP server's file, written as itself or as a YAML
  escape such as `"\u200B"`. Settings never need one, and it can hide a key or a path. A tab is fine. An emoji
  joined from several (👩‍💻) or with a style mark (❤️) holds one too, so a name or title uses a single emoji. Briefs,
  instructions and skills may hold these characters: there they are taken out before the key check runs;
- a `$`, `%` or `~` in a server's `command`, `args`, `env` values or `headers` values. Edu Bot passes them as written
  and never runs a shell, so no variable or home folder would be filled in. An address may hold `%` only in a `%XX`
  escape such as `%20`.

Prose can now and then look like a key. The problem names the line; reword it, or move the value into a slot.

The key check in briefs, instructions and skills guards against pasting a key by accident. It is not a security
boundary: text can always be encoded in a way the check does not read. A key belongs in a `{ secret: NAME }` slot,
never in a profile's text.

## What never goes in a profile

These belong to each person and stay in their own app. The check refuses each one and says why:

- engine logins and API keys, MCP keys and sign-ins, connected-app accounts, edu-cloud tokens (secret slots name
  them; their values never appear);
- `cwd` (a bot's working folder), `computer` (where it works), `browserProfile`, `visibility`;
- `eduBrain: { mode: folder }`, and any absolute path (`/home/…`, `~/…`, `C:\…`, `file:///…`), anywhere in a value
  such as `--config=/home/…`: paths differ on each computer. A server's `command`, `args` and `env` may not climb with
  `..` either, and `$HOME/…` or `%USERPROFILE%\…` is refused there by the `$` and `%` rule above.

## Checking a folder

```sh
edubot profiles check path/to/folder
edubot profiles check path/to/folder --json
```

It reads the folder on this computer and never reaches a server. Each problem is one sentence naming the file, the line
and the field:

```text
areas/bi/bots/analyst.md, line 9: model must be INSTANCE/MODEL, such as claude/claude-sonnet-5-5
mcp/notion.md, line 8: headers.Authorization holds a credential; put it in a secret slot instead: { secret: NAME }
1 problem found. Nothing was applied: this check only reads the folder.
```

With no problems it prints `OK`, a count of what it found, and one line per bot as its organization and area make it.
Exit codes: `0` fine (warnings allowed), `1` a problem was found, `2` the folder does not exist or was not named. Run it
in the profile repository's CI so a broken file never reaches its main branch.

The check also refuses:

- a link anywhere in the folder's layout (a linked file, bots folder or skill): profiles never follow links. Only the
  folder you name may itself be a link;
- a file over 256 KB, profile files over 4 MB together, or more than 500 of them;
- a file that is not UTF-8 (Windows line ends and a byte order mark are fine);
- YAML aliases (`*name`), a field written twice, a front matter block that never closes;
- a bot whose area has no `area.md`, a `chief` that is not one of the area's bots, two bots with one name, and a
  `skills` entry that is not a SKILL.md in an area's `skills/` folder;
- more than 2,000 files and folders in the layout. At most 200 problems and 200 warnings are listed.

A skill's text is scanned as imported skills are (a download piped into a shell, a long encoded blob, hidden text).
What the scan finds is a warning for a person to read, not a refusal.

## Applying a folder

Applying goes one way, from the files to the app, and always as a plan you look at first. The app never applies a folder
by itself, never writes to it and never runs git: pull the repository yourself, then plan again.

```sh
edubot profiles plan path/to/folder
edubot profiles apply path/to/folder
```

The app reads the folder on its own computer. A plan line is one of:

| Line | |
|---|---|
| Adds | A new area (a department, with its brief) or a new bot. |
| Changes | A field the file changed since the last apply, where this app still has the value it was given. |
| Gives more access | A change that lets a bot do more: a higher approval level, tool selectors it did not have, an MCP server it did not mount, a connected app or tool it was not granted, a tool group switched back on, an Edu brain switched on or moved to a brain others share (an area or edu-cloud brain, or the personal brain beside an area's), or the Edu crew. |
| Conflicts | A field both the file and this app changed. Nothing is applied to it until you choose: keep mine, or take the file. |
| Changed here | A field changed in this app since the profile set it, while the file still says the same. It is kept. |
| No longer in your profiles | A bot or area whose file is gone. It is kept; `--prune` deletes such bots. |
| Left as they are | A bot or area whose file has problems (see the check). A problem anywhere else in an area's folder (a link, an unreadable folder) leaves the whole area as it is, and nothing under a path with a problem is ever called gone or deleted. A broken `org.md`, skill or folder blocks the whole plan, since every bot depends on it. |
| Comes in a later update | Something in the files this version does not apply yet: the servers under `mcp/`. |
| Notes | For example, a model whose engine this app does not have: the bot keeps its current model, or gets this app's default. |

A second apply of the same commit says **No changes**.

### How the app matches files and bots

A bot is matched on its identity, `<area>/<bot>`, which the app keeps on the bot (`profileSource`). Changing `name:`
in the file renames the bot; a new key adds a new bot. For each field the app keeps a short hash of the value it last
applied, and of the value a field the file leaves out had then. Comparing the file, the app and that hash says which
side changed: only the file (applied), only the app (kept, "changed here") or both (a conflict). With
`edubot profiles apply`, a conflict's key is printed beside it: `--take-file KEY` or `--keep-mine KEY` settles it.
Keeping yours records the file's value as seen, so the same conflict is not asked again.

A bot's changes go in separate writes: the plain ones together, then the approval level and each "Gives more access"
change on its own, so the app refusing one (Auto on this computer needs the warning only the bot's settings show) never
drops the others. A new bot is made at its approval level.

An area becomes a department named after its `name:`, found again by its key after a rename. Its brief is the
organization's brief, then the area's.

### Who may give more access

A shared profile folder is someone else's commit, so the file is never the confirmation. "Gives more access" lines
apply only from the desktop app or from a paired device signed in as an admin (`edubot login`), and pass through the
same checks as a change made in a bot's settings. From a program on this computer they are refused, and
`edubot profiles apply --without-access` applies the rest, narrowing included.

### What the app keeps

`<data>/profiles.json` keeps the chosen folder, the commit last applied (read from `.git` without running git, when the
folder is inside a git checkout) and the department each area became; renaming that department in the app is followed
there. The commit is read only from the checkout's own `.git` folder, or a linked worktree's folder in its repository
once git's links back agree; links, pipes and anything else read as no commit. Workspace backups leave `profiles.json`
out, and a restored bot keeps its `profileSource` only when it is one an apply could have written. Where the app keeps an admin activity log
([self-hosting.md](self-hosting.md)), each apply adds a `profile.apply` row: the folder, the commit, and each bot and
field it changed.

The app's routes, for scripts and the Profiles screen:

| Route | |
|---|---|
| `GET /api/profiles` | The chosen folder, what was last applied and each area's department. |
| `PUT /api/profiles/folder` | `{ "folder": "/abs/path" }` chooses the folder; it must exist and must not be inside the app's data folder, through links either way. On Windows it must be on a drive, such as `C:\Profiles`, not a network share. |
| `POST /api/profiles/plan` | `{ "folder"?, "choices"?, "prune"? }` answers the plan, with a `digest`. |
| `POST /api/profiles/apply` | The same, plus `"giveAccess": true` to apply "Gives more access" lines (403 unless from the desktop app or an admin session) and `"expect": DIGEST` to refuse (409, with the new plan) a plan that changed since you saw it: the digest covers every file's bytes, the commit, what each write would send, the choices and `prune`. |

`choices` maps a conflict's key, such as `bi/analyst:title`, to `"mine"` or `"file"`.

## Verify

```sh
pnpm exec vitest run shared/profile-format.test.ts server/profiles/load.test.ts server/headless/profiles.test.ts \
  server/profiles/plan.test.ts server/profiles/apply.e2e.test.ts server/profiles/two-people.e2e.test.ts \
  server/profiles/git-commit.test.ts server/profiles/state.test.ts server/routes/profiles.test.ts
```

`two-people.e2e.test.ts` runs two isolated servers against one temporary git repository of the acme folder: both get
the same bots, a second apply has no changes, a new commit reaches both, and a title changed on one computer is a
conflict there only.

## Area and edu-cloud Edu brains

`eduBrain: { mode: area }` gives every bot of the area on this computer one shared brain, at
`<data folder>/brains/areas/<area key>/.edu`, made on the first turn like a bot's own. Each person's app has its own
copy: an area brain is shared by the bots on one computer, not across computers.

`eduBrain: { mode: cloud, url, token: { secret: NAME } }` shares one [edu-cloud](https://github.com/EduardoMoraga/edu-cloud)
brain across computers. Each person asks the edu-cloud admin for their own token (`edu-cloud token add <email>`) and
saves it in **Settings → Vault** under the name the profile gives (`NAME`). Until then the bot shows **Needs your key**
and has no Edu tools. `{ env: NAME }` reads the token from the app's environment instead; a `{ file: … }` token is for
CI only, and this app then keeps the bot's current brain.

Both are more access: the plan lists them under **Gives more access**, and only the desktop app or a paired admin
device applies them. See [edu-brain.md](edu-brain.md).

