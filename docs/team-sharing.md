# Sharing a whole team

**Share team…** saves one team as a single file (`<team>-<version>.openmaus.json`).
Someone else adds it in **Templates → Import**, or an organization uploads it
in Admin → Packages. Open it from the team's menu in the sidebar (right-click
the team name), or from **Templates → Share**.

## What goes in the file

- **Bots.** Each bot's name, title and description, its standing instructions,
  its colour and mascot, and its picture (downscaled to at most 256 × 256 and
  64 KB; the dialog stops adding pictures after about 2 MB of them).
- **Skills.** All skills on the team's bots by default, or the ones you tick.
  Only the `SKILL.md` text travels, never scripts or other files.
- **Playbooks**, **group chats** (members and who answers by default) and the
  team's **shared instructions**.
- **Routines**, including group chat goals. They always arrive paused.
- **The Chief of Staff.**
- **Connections.** For each remote MCP server a bot uses: its address and the
  names of the values it needs (for example `Authorization`). The values
  themselves never travel.
- **Starter notes.** Each bot's `MEMORY.md` and topic notes. The dialog
  includes them unless you switch them off; daily logs never go in.
- **Connector requirements** (which connected apps the team expects), as
  labels only.

## What never goes in the file

Chat history, keys and passwords, model choices, computers, and who can see
each bot. The file format has no field for any of them. Local MCP servers
that run a command on this computer are left out, as are routine attachments.

Text can still contain a secret someone typed into it. Before the file is
written, every text part is checked with the same detectors the app uses for
its logs. Anything that looks like a key or password is replaced with a
marker, and the dialog lists which parts were changed. The Admin upload runs
the same check again and refuses a file that still contains one.

The dialog shows, before you save, exactly what the file holds (counted by the
server from the same export), and afterwards what was removed or left out.
There is no confirmation step: **Save file** is the decision.

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

- Bots start on **Ask**, with no connected-app access and the installation's
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
- Preset bots in a file are listed but not added yet.
- A package with no bots (skills and presets only) is refused with a pointer
  to the organization shelf, which arrives in a later version.

If any step fails, everything the import created is removed again.

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
`{document, filename, redacted, skipped, summary, choices}`. A body without
`version: 2` keeps the original whole-installation Markdown export.
