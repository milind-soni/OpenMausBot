# Preset bots

What it covers: presets in **New bot** (from imported files and from the
organization's shelf), **Include my New bot defaults as a preset** in Share
team, **Share as preset…** (a preset file: skills and presets, no team), and
adding a preset file back through **Templates → Import**. The product
behaviour is described in [../presets.md](../presets.md).

## HTTP round trip

```sh
pnpm exec vitest run server/presets.e2e.test.ts --silent=false
```

This launches and cleans its own fake-engine fixture through
`launchVerificationServer` (no live URL, no user data). Through the public API
it saves New bot defaults that carry things a preset must never hold (Auto
approval, connected apps, a command allowlist, a routine) plus a password in
the standing instructions, then checks:

- `POST /api/teams/export` with `kind: "library"`: a dry run counts one
  preset and one skill and writes no `published-library.json`; saving writes
  `support-agent-1.0.0.openmaus.json` with the preset (name, look, picture,
  standing instructions, skill, starter notes), reports the redacted
  instructions, contains no password, approval, connected-app, model or
  routine field, and the next save suggests `1.0.1`;
- a team export includes the defaults preset only with
  `includeDefaultsPreset: true`;
- importing the preset file (the body claims organization trust) adds a
  file preset and no bot or team, and `GET /api/bot-presets` lists it with
  `skillsEnabled: false`;
- `POST /api/bots` with that `preset` adds its skill switched off, its
  starter notes and the `installedPackage.presetKey` stamp, on Ask; with the
  saved defaults applied too, the preset's skill wins over the defaults';
- an organization preset (written into `org-library/presets.json` as the
  organization library stores one) is listed first under its publisher and
  its skill is added switched on under the organization's own source; once
  `org-library/state.json` marks the install withdrawn, it is neither listed
  nor usable;
- an unknown or malformed preset, and a file with skills but no presets, are
  refused without creating anything; an imported preset can be removed, an
  organization's cannot (`409`).

A second test in the same file goes through the organization library itself
(`OMB_TEST_ORG_LIBRARY_KEY` and `POST /api/testing/org-library`, as in
[org-library.md](org-library.md)): the library fixture relayed in a catalog
and added from the shelf answers with its preset, `state.json` records it
under the install's `presets` with its release hash, New bot offers it under
Acme Partners with skills on, adding the package again is a no-op, and once
the catalog lists the release as withdrawn the preset is neither offered
nor usable while the bot made from it stays, with its skill switched off.

The printed JSON line names the fixture's data directory and server log.

## Units

```sh
pnpm exec vitest run server/presets.test.ts server/routes/bot-presets.test.ts server/package-import.test.ts server/package-export.test.ts shared/package-format.test.ts
```

- `server/presets.test.ts` imports into a real store, skill store and memory
  in a throwaway home: team and library files store their presets (once per
  identical file), a failure after the presets were stored removes them, an
  organization library is added once and keeps its provenance, organization
  presets come first and withdrawn or removed installs are hidden, a
  hand-edited row cannot add an approval level or model and a row with a
  daily log is refused; bots made from file and organization presets get
  their skills off and on respectively; the defaults preset keeps only the
  allowlist; a team file's preset never pushes out a team skill of the same
  name; the preset file round-trips.
- `server/routes/bot-presets.test.ts` drives the two routes through the
  route table.

## Renderer

```sh
pnpm exec vitest run src/lib/bot-presets.test.ts src/components/SharePresetDialog.test.ts src/lib/team-import.test.ts src/lib/team-share.test.ts src/components/ShareTeamDialog.test.ts src/components/NewBotDialog.test.ts src/lib/create-configured-bot.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/presets-ui.e2e.test.ts --silent=false
```

The first command covers the New bot grouping, the draft fields a preset
fills (never the model, computer, approval or connected apps), the picture,
the summary lines, creation passing the preset and leaving its skills and
notes to the server, the share request, part names, the preset file's
contents list and its import preview. The second owns a disposable
`control-omb ui` app: **Settings → Share as preset…** shows the counts and
saves `sky-1.0.0.openmaus.json` (captured in the page); **Templates →
Import** of that file shows "Preset bots and skills · no team" and **Add
presets** adds it; **Share team** shows no preset until **Include my New bot
defaults as a preset** is ticked; then **New bot** lists **From Acme
Partners**, **Imported presets** and **Built-in roles**, and a bot made from
the file preset gets its skill off and its notes, one made from the
organization preset its skill on. Screenshots go to
`.omb-scratch/verify-evidence/presets-*.png`. CI runs it in the advisory
renderer smoke job next to the Share team recipe.

## 2026-09-24: what was actually run

On macOS (arm64) against disposable fixtures only: `pnpm typecheck`,
`pnpm lint`, `pnpm i18n:check`, every command above (including the
headless-renderer run with `OMB_UI_E2E=1`), `server/team-share.e2e.test.ts`,
`server/team-package-skills.e2e.test.ts`, `server/bot-package.test.ts`,
`server/index.test.ts`, `server/request-auth.test.ts`,
`server/new-bot-defaults.test.ts`, `server/new-bot-defaults.e2e.test.ts`,
`server/bot-setup.e2e.test.ts`, `src/state/bot-creation.test.ts`,
`server/org-library.test.ts`, `server/org-library.e2e.test.ts`,
`src/lib/org-library.test.ts` and the Share team, organization library and
New bot headless-renderer recipes passed; the presets
headless recipe passed six runs in a row after its sidebar clicks learned to
wait for a closing panel.
Each of these was mutation-checked (broken, the named test seen failing,
restored): file-preset skills switched on; the defaults preset leaking a
profile field; a failed import keeping its presets; an organization preset
deduplicated against a file's; withdrawn installs still offered, or still
usable at creation; a stored row used without re-parsing; a skills-only
file accepted; an organization library added twice; a preset's skill
replacing a team skill of the same name; the saved defaults' skill winning
over the preset's; an organization preset removable; the renderer dropping
the preset id or writing over the preset's notes; the preview refusing a
preset file; the share request always asking for the preset; the draft
taking an approval level from a preset; the Share team box ticked by
default; the New bot picker forgetting the chosen preset; an organization
library add skipping its presets; `state.json` leaving an install's
`presets` empty.

## 2026-09-24: review fixes (PR #1773)

`server/org-library.test.ts` now wires the preset store into both the
importer and the organization library, as `server/index.ts` does, so its
existing re-add and lost-`state.json` tests run with presets. Added: a
removed team is added again although a bot was made from its preset (one
preset row, same id); a presets package whose `state.json` became
unreadable is adopted from its preset rows (Add stays a no-op, its skills
stay offered), and its withdrawal hides the preset and switches off the
skill on the bot made from it but not a same-named skill of the person's
own; an adopted team gets its `presets` back. `server/presets.test.ts`
covers an organization install's rows refreshed in place across releases.
Mutation-checked (each broken, the named test seen failing, restored): a
preset-made bot blocking re-add; preset rows blocking re-add (the old
check); no in-place refresh; no preset indexing in the rebuild; withdrawal
skipping preset-made bots (unit and HTTP); withdrawal matching skills by
name instead of source.

Not production qualification: no real organization, Admin upload or
organization library was involved. Organization presets were written into
`org-library/presets.json` the way the organization library stores them,
and withdrawal was simulated by writing `org-library/state.json`.
