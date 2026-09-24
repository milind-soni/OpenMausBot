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
- a library-only package is refused with the shelf pointer and a version 3
  file with the "update the app" sentence, creating nothing.

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
  redaction, picture and connection skips and key stability across renames.
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

The first command renders the team menu, the dialog's contents list and the
import preview to markup and checks the saved file. The second owns a
disposable `control-omb ui` app: Templates → Share → **Share the Sales desk
team**, checks the live counts and the redaction list, **Save file** (the
download is captured in the page), then imports the captured file through
the Import tab's file input and adds it as "Sales desk 2" with skills off.
Screenshots go to `.omb-scratch/verify-evidence/share-team-*.png`.

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
