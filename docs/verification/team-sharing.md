# Sharing a whole team

What it covers: **Share team…** (package format v2), the file it saves, and
adding that file back through **Templates → Import**. The product behaviour
is described in [../team-sharing.md](../team-sharing.md).

## HTTP round trip

```sh
pnpm exec vitest run server/team-share.e2e.test.ts --silent=false
```

This launches and cleans its own fake-engine fixture through
`launchVerificationServer` (no live URL, no user data). Through the public API
it builds a team with a Chief, a standing instruction containing a
password-shaped string, shared instructions, a skill, a remote MCP server with
a header value and a local command server, starter notes, a group chat and a
bot routine plus a group chat goal. It then checks:

- a dry run (`dryRun: true`) counts every part and writes no
  `published-teams.json`;
- the saved file is `sales-desk-1.0.0.openmaus.json`, reports the redacted
  standing instruction and the skipped command server, and contains no
  secret, header value, other team's bot, model or thread id;
- after renaming the team and a bot, the next save keeps the package id and
  every key and suggests `1.0.1`;
- importing the file with `?trust=org` and a body claiming `trust`, `org` and
  a publisher still imports it as a file: skills off, routines paused, no
  publisher stamp, the slot created as `crm-2` (switched off, empty header
  value) and bound only to the new bot, the brief, notes, Chief, picture and
  group chat default responder restored;
- a library-only package adds its preset to New bot and no bot
  ([presets.md](presets.md) covers presets), and a version 3 file is refused
  with the "update the app" sentence, creating nothing.

A second test in the same file builds a team whose skills cannot all go in
one file (a bot with 31 skills, and a name two bots hold with different
content) and a connection whose address carries a key. It checks that the
first look (`skills: "all"`) still answers with counts, every skill name and
the parts left out; that an exact choice over 30 per bot, a conflicting name
or an unknown name is a `400` sentence that still carries
`choices.skills` (never a `500`); and that the address goes out as
`…/s/redacted/mcp`, reported under `redacted`. Finally Scout also gets the
lead's `step-31` (same content) and `z-only`: the dialog's starting ticks
leave `step-31` out, and unticking `z-only` from them is a `200`, where
unticking it from everything "all" put in the file is a `400`.

The printed JSON line names the fixture's data directory and server log.

## Format, export and import units

```sh
pnpm exec vitest run shared/package-format.test.ts server/package-export.test.ts server/package-import.test.ts server/bot-package.test.ts
```

- `shared/package-format.test.ts` parses every file in
  `shared/package-fixtures/` to the sha256, keys, summary, secret findings and
  v1 downgrade recorded in `manifest.json` (Admin reads the same files), and
  covers the 4 MiB boundary, stripped authority fields, the publisher rule,
  each refusal sentence, redaction and the canonical form.
- `server/package-export.test.ts` covers team scoping, starter-note caps,
  redaction, picture and connection skips, key stability across renames,
  what "all" leaves out (30 per bot with switched-on skills first, 60 per
  team, conflicting names), exact choices refused with `TeamExportError`,
  the dialog's starting ticks always being a choice that fits (and still
  fitting with any one box unticked), and connection addresses: one table of
  keys that must not travel (sign-in part, fragment, query and matrix values,
  a key in a subdomain, short hex keys, 24 letters or digits in a row, a key
  after `: @ ! $ ' ( ) * ,` inside a segment, a key as a query or matrix
  name, a percent-escaped key) and one of plain addresses that must stay
  byte for byte (`github-mcp-server-2024`, `acme-corp-2025-sales`,
  `path%20with%20spaces`, localhost).
- `server/package-import.test.ts` imports into a real store, routine manager,
  skill store and memory in a throwaway home: every part, repeat imports,
  MCP policy refusal, full rollback when the last step fails, the library
  refusal, run-limit adjustment, and the organization path (skills on,
  provenance stamps, "already added", refused mismatches).

## Renderer

```sh
pnpm exec vitest run src/components/ShareTeamDialog.test.ts src/lib/team-share.test.ts src/lib/team-import.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-share-ui.e2e.test.ts --silent=false
```

The first command renders the team menu, the dialog's contents list (with
each connection's full address), the skill boxes drawn from a refused
31-skill choice, and the import preview to markup, and checks the saved file.
`src/lib/team-share.test.ts` also covers the dialog's state as pure
functions: starter notes and pictures ticked by default with the matching
line, an answer setting the starting ticks only on the first look, and a
refusal dropping the counts (so Save is off) while keeping every skill box.
The second command also runs in CI, in the advisory `ui-smoke` job.
The second owns a disposable `control-omb ui` app whose Scout has 31 skills,
17 of them long enough that the file passes 4 MB: Templates → Share →
**Share the Sales desk team** shows the refusal with every skill box and Save
disabled; unticking one long skill brings the counts back; starter notes are
in by default and unticking takes them out; ticking a 31st skill is refused with the per-bot sentence
and unticking another fits again. Then **Save file** (the download is
captured in the page), and the captured file is imported through the Import
tab's file input as "Sales desk 2" with skills off. Screenshots go to
`.omb-scratch/verify-evidence/share-team-*.png`.

## 2026-09-24: what was actually run

On macOS (arm64) against disposable fixtures only: all commands above passed,
including the headless-renderer run with the pinned agent-browser. Each of
these was also mutation-checked (the fix broken, the named test seen failing,
the fix restored): stable keys and package id ignoring the publish record,
export without redaction, a file keeping its claimed publisher, the 4 MiB
check off by one, daily logs or command servers accepted by the format, file
imports switching skills on or honouring `enabledAfterInstall`, a slot
binding to an existing server name, rollback forgetting created servers, the
library refusal and organization idempotency removed, the route honouring a
`trust` field, a dry run recording keys, the rename hook removed, the preview
hiding connections, and the Share team menu item missing.

Not production qualification: no real organization, Admin upload, native
save dialog or packaged app was involved, and the organization channel
(`trust: "org"`) was exercised only through the importer function.

## 2026-09-24 (review fixes): what was actually run

On macOS (arm64) against disposable fixtures only: `pnpm typecheck`,
`pnpm lint`, `pnpm i18n:check`, the commands above (including the
headless-renderer run with `OMB_UI_E2E=1`), `server/index.test.ts`, and the
neighbouring team, package, backup, visibility, store and sign-in test files
all passed. Each of these was mutation-checked (broken, the named test seen
failing, restored): the route never asking for "all"; the per-bot fit
ignoring switched-on skills; the fit keeping conflicting names; the team cap
not fitted; a conflicting exact choice thrown as a plain error; either
refusal dropping `choices.skills`; `api()` dropping the refusal body; the
dialog ignoring a refusal's choices or keeping a stale preview (Save
enabled); ticks ignoring what "all" put in the file; a request sending a
skill the team no longer has; an address keeping its query values, key-shaped
path segments or sign-in part; a changed address not reported; addresses not
listed before Save; and starter notes off by default.

Not production qualification: no real hosted MCP server, organization, Admin
upload or packaged app was involved. The key-shaped segment rule is a
heuristic (long, letters and digits mixed) and can also replace a harmless
id; the dialog shows the address it will write.

## 2026-09-24 (second review): what was actually run

On macOS (arm64) against disposable fixtures only: `pnpm typecheck`,
`pnpm lint`, `pnpm i18n:check`, `server/package-export.test.ts`,
`server/team-share.e2e.test.ts`, `src/components/ShareTeamDialog.test.ts`,
`src/lib/team-share.test.ts`, `src/state/store.test.ts`, and the
headless-renderer run with `OMB_UI_E2E=1` all passed. Each of these was
mutation-checked (broken, the named test seen failing, restored): host labels
not tested; whole segments matched instead of runs inside them; the
words-with-a-year exemption removed; `%XX` not decoded; the 24-in-a-row rule
removed; matrix and `name=value` values kept; query names not tested; a
changed address not reported; the team cap ranked by name only; the starting
ticks keeping a name over a bot's limit; the dialog's answer ignoring the
starting ticks or overwriting a choice; a refusal dropping its skill names,
keeping the stale preview or ignoring the error body; starter notes off by
default or the notes line swapped; and, in the real renderer, the dialog
starting with notes off and a refusal bypassing the refusal state.

Not production qualification: no real hosted MCP server was involved. The
address rule is still a heuristic: a harmless id with letters and digits
mixed (a deployment hash in a subdomain, say) is also replaced, and a key
made only of words and short numbers would pass. The dialog shows the
address it will write.
