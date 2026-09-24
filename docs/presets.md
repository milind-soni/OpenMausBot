# Preset bots

A preset is a named starting point in **New bot**. Choosing one fills in the
new bot's name, title, description, standing instructions and look, and when
you press **Create bot** it also brings the preset's skills, playbooks and
starter notes. You can change every field before creating the bot.

Presets come from a shared file (a team file or a preset file someone sent
you) or from your organization's shelf (**Templates → From {Organization}**,
see [org-library.md](org-library.md)). In New bot's **Starting role** list,
your organization's presets come first under **From {Organization}**, then
**Imported presets**, then the built-in roles.

## What a preset holds

A preset is an allowlist. It can carry only:

- a name and a short description;
- the new bot's name, title, description and standing instructions;
- its look: colour, mascot and picture;
- playbooks;
- skills (the `SKILL.md` text only, never scripts);
- starter notes (`MEMORY.md` and topic notes).

It has no field for a model, a folder, a computer, an approval level,
connected apps, MCP servers, a browser, peers or routines. Whatever you have
chosen for those in New bot (or in your New bot defaults) stays as it is, so
a preset can never widen what a bot may do. Every stored preset is read
through the same package parser as every import, so a hand-edited preset
still says only what a file may.

## Where it came from decides the skills

- **From a file:** the preset's skills are added **switched off**, like every
  skill in a shared file. Switch them on in the bot's Skills settings after
  reading them.
- **From your organization:** the skills are added **switched on**, because
  your organization's Admin published them.

The New bot dialog says which applies before you create the bot. A preset's
skills and starter notes win over your New bot defaults' own skill or note of
the same name. The bot records where it came from (`installedPackage` with
`presetKey`).

A preset from an organization release that was withdrawn, or from a package
your organization removed, is no longer offered, and a bot already made from
a withdrawn one has that release's skills switched off (once; switching them
back on is yours). Adding the same organization package again, for example a
team you deleted, refreshes its presets in place rather than adding copies. Organization presets are
managed in Admin; an imported preset can be removed with **Remove from New
bot** under the Starting role list (no confirmation step).

## Sharing presets

Two ways, both saving the same file format ([team-sharing.md](team-sharing.md)):

- **With a team.** In **Share team…**, tick **Include my New bot defaults as
  a preset**. It is off unless you tick it: your New bot defaults are yours
  until you share them. The team's **Include starter notes** box also decides
  whether the preset's notes go in.
- **On their own.** **Settings → General → Defaults for new bots → Share as
  preset…** saves a preset file: the preset and its skills, no team, no bots.
  Choose the preset's name, a description, the version and whether to include
  the picture and starter notes.

Either way the preset is made from your saved New bot defaults through the
allowlist above, and every text part passes through the same secret redaction
as a team file. The dialog lists what was removed or left out. There is no
confirmation step: **Save file** is the decision.

A preset file is added in **Templates → Import** like a team file. The
preview shows the preset bots and any skills the file only offers; **Add
presets** puts the presets in New bot and changes nothing else. A file with
skills but no bots or presets has nothing to add here and is refused with a
sentence. Adding the same file twice offers its presets once.

## Where presets are kept

`org-library/presets.json` in the data folder: one row per preset (where it
came from, which install it belongs to, the package name and version, and the
preset exactly as the file carried it), plus the skill and playbook
definitions those presets use, so a bot can be made from a preset after the
file or the organization's release is gone. What this installation last
shared as a preset file (its package id and version) is kept in
`published-library.json`, so the next share suggests the next version.

## HTTP

All admin scope.

- `GET /api/bot-presets` → `{presets: [{id, source: "file"|"org", key, name,
  description?, packageName, release, publisherName?, bot, skills: [{name,
  description}], skillsEnabled, playbooks, notes}]}`.
- `DELETE /api/bot-presets/:id` removes an imported preset; an organization's
  answers `409`.
- `POST /api/bots` with `preset: "<id>"` adds the preset's playbooks, skills
  and starter notes to the new bot and stamps it. Name, look and instructions
  are the request's own fields, as for any bot.
- `POST /api/teams/export` with `includeDefaultsPreset: true` (and optionally
  `presetName`, `presetDescription`, `presetAvatar` as a data URL) adds the
  New bot defaults preset to a team file. With `kind: "library"` instead of
  `team`, it saves a preset file (`name`, `release`, `notes`, `includeMemory`,
  `dryRun` as for a team).
- `POST /api/teams/import` adds a preset file's presets and answers
  `{presets: [{id, key, name}], offeredSkills, bots: [], section: ""}`.
  `POST /api/org-library/add` answers with the same `presets` list, and the
  install's entry in `org-library/state.json` records them under `presets`
  (`{<key>: {presetId, r}}`, `r` the release-side hash of contract §1.6).

See [verification/presets.md](verification/presets.md) for how this is tested.
