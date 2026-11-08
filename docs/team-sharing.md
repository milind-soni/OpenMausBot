# Sharing a whole department

The sidebar groups bots into departments. **Share department…** saves one department as a single file (`<team>-<version>.openmaus.json`).
Someone else adds it in **Templates → Import**, or an organization uploads it
in Admin → Packages and its desktops add it from **Templates → From
{Organization}** ([org-library.md](org-library.md)). Open it from the department's menu in the sidebar (right-click
the department name), or from **Templates → Share**.

## What goes in the file

- **Bots.** Each bot's name, title and description, its standing instructions,
  its colour and mascot, and its picture (downscaled to at most 256 × 256 and
  64 KB; the dialog stops adding pictures after about 2 MB of them).
- **Skills.** All skills on the team's bots by default, or the ones you tick.
  The goal is a portable skill directory containing every asset needed to run
  the skill. UTF-8 text files, including HTML, nested references and scripts,
  travel with `SKILL.md`; executable bits on text files are retained. Binary
  companions are left out unless you explicitly choose **Include binary skill
  files**. Binary files cannot be scanned or redacted for secrets or metadata;
  inspect them before sharing. The preview lists included and omitted files and
  identifies scripts and binary files. Links, binary files marked executable,
  unsafe paths, generated folders, unreviewed additions and credential-like file names are left out. Check the list
  before sharing a skill that needs them. Companions are limited to 128 files,
  512 KiB each and 2 MiB total per skill, within the 4 MiB package size limit.
  Package text redaction applies to text companions too, and can change their
  contents. Text companions can be opened in the preview. The app checks an
  expanded bundle against the reviewed preview before saving. A source folder above 512 entries,
  or with reviewed files above 16 MiB total or 2 MiB each, cannot be safely snapshotted and its skill is left out. A file
  holds at most 30 skills per bot and 60 per team, and one skill per name.
  When you have not chosen, the dialog puts in what fits (switched-on skills
  first) and lists the rest under **Left out**, including a name two bots
  hold with different content. The skill boxes then start ticked on what
  went in, less any skill a bot had to leave out over its 30 (even when
  another bot's copy went in), so unticking any box is always a choice that
  fits. When you tick more than fits, it says why and keeps every skill box
  so you can change the choice.
- **Playbooks**, **group chats** (members and who answers by default) and the
  team's **shared instructions**.
- **Routines**, including group chat goals. They always arrive paused.
- **The Chief of Staff.**
- **Connections.** For each remote MCP server a bot uses: its address and the
  names of the values it needs (for example `Authorization`). The values
  themselves never travel. Hosted servers often keep their key in the address
  itself, so an address loses any sign-in part and `#fragment`, and keeps its
  query and `;matrix` parameter names with the values emptied (`?key=`,
  `;key=`, and `key=` inside a path segment). Any path segment, parameter
  name or subdomain label (anything left of the last two host labels) that
  looks like a key is replaced with `redacted`. A part looks like a key when,
  after `%XX` escapes are decoded, it holds a run of 16 or more letters,
  digits, `-` or `_` that mixes letters and digits, or 24 or more letters or
  digits in a row, such as a token, a hex key or a server id. Words joined by
  hyphens with a short number, such as `github-mcp-server-2024`, stay as
  they are. The rule is deliberately broad, so the dialog lists each
  connection's full address before you save and names any address it
  changed.
- **Starter notes.** Each bot's `MEMORY.md` and topic notes. **Include
  starter notes** is ticked, because a team is shared whole; untick it if the
  notes hold private details about you. Daily logs never go in.
- **Connector requirements** (which connected apps the team expects), as
  labels only.
- **Your New bot defaults as a preset**, only when you tick **Include my New
  bot defaults as a preset**: their name, look, standing instructions, skills
  and (with starter notes) notes, never their model, folder, computer,
  approval level or connected apps. See [presets.md](presets.md).

## What never goes in the file

Chat history, model choices, computers, and who can see each bot. The file
format has no credential fields. Local MCP servers that run a command on this
computer are left out, as are routine attachments.

Text can still contain a secret someone typed into it. Before the file is
written, every text part is checked with the same detectors the app uses for
its logs. Anything that looks like a key or password is replaced with a
marker, and the dialog lists which parts were changed. This detection is not
complete; inspect the text before sharing. Binary companions, if you choose
them, are not scanned and can contain secrets or metadata. The Admin upload
runs the same text check again and refuses a file that still contains a match.

The dialog shows, before you save, exactly what the file holds (counted by the
server from the same export), and afterwards what was removed or left out.
There is no confirmation step: **Save file** is the decision.

Markdown-only companions within the original limits use `skills.version: 2`;
expanded folders use `skills.version: 3` inside the existing package envelope.
Older readers reject an unsupported section rather than silently dropping its
files; both the receiving app and an organization's Admin must support it.
Skills without companions keep `skills.version: 1` and their existing stamps. The older
BotMRR export cannot carry companions and refuses such a selection;
use department sharing to review its included and omitted files.

## Versions and identity

The first time a team is shared it gets a package id (from its name) and each
bot, group chat and routine gets a key. Later shares of the same team reuse
them, even after renaming the team or anything in it, and suggest the next
version (1.0.0, then 1.0.1, …). A team first added from a shared file keeps
that file's package id and bot keys, so "import the published release, edit,
share again" produces the next release of the same package. The record lives
in `published-teams.json` in the data folder.

## Adding a shared team

Import is additive: everything becomes new records in a new team (numbered if
the name is taken). Nothing in the file can change a bot, group chat or team
you already have.

- Bots start at the default approval level, **Full access** (Ask on a hosted
  company workspace), with no connected-app access and the installation's
  default model. A suggested approval level in the file is recorded, never
  applied.
- Skills arrive **switched off**; routines arrive **paused**.
- Each connection becomes a new MCP server that is **switched off** with
  empty values, named after the connection (`crm`, or `crm-2` when `crm` is
  already taken, so it can never pick up credentials you already have). Your
  organization's MCP policy still applies; a refused connection is listed and
  the rest of the team is added. Finish connections in **Plugins → MCP
  servers**.
- Starter notes are written once, through the normal memory writer.
- Preset bots in a file appear in **New bot** under **Imported presets**; a
  bot made from one gets the preset's skills switched off
  ([presets.md](presets.md)).
- A preset file (skills and presets, no bots) adds its presets to New bot and
  nothing else. A file with only skills has nothing to add here and is
  refused with a pointer to the organization shelf (**Templates → From
  {Organization}**, see [org-library.md](org-library.md)).

If any step fails, everything the import created is removed again.

## Moving from Grok Bot

**Settings → Import → Move from Grok Bot** opens one dialog. It needs no sign-in
and the import makes no network call. Grok Bot has no export button, so each Bot
writes down its own setup.

1. Copy the message and send it in the Bot's chat. The Bot saves
   `grok-bot-export-<name>.json` or replies with it.
2. Bring that back: paste the whole reply (chat text and code fences are fine),
   drop the file or choose it. In the desktop app, on the computer running
   OpenMausBot, files named `grok-bot-export*` in Downloads are offered in one
   tap; a split or re-saved export joins up.
3. The preview names the Bot and counts its skills, routines and memories. Nothing
   is written yet.
4. Import, then the same counts in the past tense and the one next step: turn each
   routine off in Grok Bot, then on here.

**Move another Bot** goes round again; each Bot exports itself.

Everyone who can add a bot also sees a popup once, after the welcome on a new
install and at the next launch otherwise: the two marks, **Let's start**, which
opens this dialog, and **Not now**. It goes first in the queue of once-only
notices (`GROK_MOVE_NOTICE`) and may interrupt a first chat, though not a turn, a
dialog or a call. It reads nothing on this computer. It stays away from a Team
Cloud, a hosted member, a branded build and a desktop an organization runs.

| In Grok Bot | Here |
| --- | --- |
| Name, title, instructions | A new bot in its own section, through the `openmaus.package` import |
| Skills | That bot's skills, switched on. One the skill scan flags stays off, and the dialog names it |
| Memories and facts about you | That bot's `MEMORY.md`, repeats dropped |
| Routine on a schedule | A routine named `<Bot>: <routine>`, paused, with its schedule and time zone and the skills it uses named in its prompt |
| Routine on an event (Slack, GitHub, Linear, Sentry, PagerDuty, email, webhook) or with a schedule that can't be read | Not created: its trigger and instruction are saved in that bot's `memory/grok-bot-event-routines.md`, and the dialog counts them |
| App with a remote `https` MCP address | That bot's MCP server, switched off, with values stripped |
| Other apps | Not carried: their logins stay in Grok Bot. The dialog counts every app to connect again |

Chat history, app logins and the model never come over.

The export text is untrusted. A document with credential-looking keys is refused
whole; token-shaped text elsewhere is redacted before anything uses it. An
address carrying a key in its query loses it, and one with a key in its path is
not carried at all. Importing grants nothing else: the package path sets every
privilege-bearing field itself. A server name you already have is skipped, and a
Bot already moved is not added twice. One file or item that can't be read costs
the rest nothing.

The earlier `openmaus.grok/1` export still reads.

After the button is pressed, and on the computer running OpenMausBot only, the
desktop app reads through `GET /api/setup-import/grok` (its own window only, never
a paired device, a browser, a bot's shell, a Cloud or a hosted server) those
Downloads files and one slice of the Grok Bot app's UI cache in
`<user data>/sand-client-persistence/`: `roster.last-roster`, for the names of the
Bots on this computer. Nothing else in that folder is opened, nor `~/.grokbot`.

A `cursor-session.json` left in the data folder by an older version is deleted at
start.

The mapping lives in `shared/grok-import.ts`, the local look in
`server/grok-local.ts`, the dialog in `src/components/GrokMoveDialog.tsx`, the
popup in `src/components/GrokMovePopup.tsx`.

## The file format

`openmaus.package` version 2, defined in `shared/package-format.ts`, the one
module the app, the import preview and Admin all validate with. It still
reads version 1 files (JSON and the BotMRR Markdown playbook). Older apps
refuse version 2 files with their existing "not supported" message; Admin can
produce a version 1 download for them. A file is at most 4 MB. Example files
and their expected hashes live in `shared/package-fixtures/`.

The HTTP route is `POST /api/teams/export` with
`{"format":"package","version":2,"team":"Sales desk"}` (admin scope). Optional
fields: `name`, `tagline`, `summary`, `release`, `notes`, `skills` (`"all"` or
names), `includeMemory` (default `false` over the API), `avatars` (data URLs
by bot id) and `dryRun` (count without recording keys). The response is
`{document, filename, redacted, skipped, summary, choices}`. With
`skills: "all"` the export puts in the skills that fit and lists the rest in
`skipped`; a list of names is shared exactly or refused. Expanded skill
folders return `skillReviewHash` on a dry run. Send it as `reviewedSkillHash`
when saving; a changed folder or missing hash returns `409` without saving.
Set `includeBinarySkillFiles: true` only after choosing to share unscanned
binary files. Every `400` from a
version 2 body also carries `choices: {skills}` (every skill name on the
team's bots), so a client can offer a different choice. `includeDefaultsPreset:
true` adds the New bot defaults preset, and `kind: "library"` (instead of
`team`) saves a preset file; both are described in [presets.md](presets.md).
A body without `version: 2` keeps the original whole-installation Markdown
export.
