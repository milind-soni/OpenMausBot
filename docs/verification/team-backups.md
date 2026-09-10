# Team backups

## User path

Sidebar menu → **Export backup** → a dated `.mausbackup.json` file.
Teams → Import → choose the file → review → **Import backup**.
Import always adds independent copies; existing bots, Chiefs, rooms and chats
are never archived, overwritten or merged. Repeated imports number copies.

The private portable backup includes active and archived bot profiles,
instructions (SOUL.md), sections, room membership, Chiefs, playbooks, paused
routine definitions, each bot's memory (`MEMORY.md`, `memory/<topic>.md` and
the `memory/log/` daily logs, with secrets removed on the way out), and
conversation text from every task and branch. Action cards become inert
text. It does not include files, screenshots, custom avatars, account
connections, model settings or permissions. Imported memory is written with
the same private modes as memory the bot wrote itself (0700 folders, 0600
files). This is not a whole-computer backup. Store the file privately: chat text can
contain sensitive information. The size limit is 50 MB; export fails clearly
instead of producing a truncated or unimportable file.

Rooms referencing previously deleted bots retain their conversation and
remaining members; orphaned direct messages become ordinary rooms. Routines
whose bot/room/coordinator was deleted are omitted. These cases produce
explicit notes in the backup, download confirmation and import preview.

Existing `.mausteam.json` and BotMRR Markdown templates remain importable;
they contain setup only, not conversation history. Old clients attempting
`mode=replace` receive a clear error and change nothing.

## Drive and evidence

```sh
node --experimental-strip-types scripts/verify-team-backup.ts
```

This mapped regression command uses `launchVerificationServer` and the shared
MCP/control request core. It accepts no live URL, owns a temporary fake-engine
server, prints its URL/PID/data directory/log path, and closes that exact
fixture in `finally`. Its steps are covered by
`server/team-backup-workflow.test.ts`.

The output records doctor, new-bot, send, wait and messages; the export/import
counts; exact original-record and transcript comparisons; rejection of old
replace mode and malformed files; and a settled new turn on the imported bot.
Keep that JSON output and the printed persistent server log as evidence.

`server/team-backup.test.ts` additionally covers all-task/branch restoration,
multi-section Chiefs, room-goal routines, repeat imports, restart persistence,
malformed reference graphs, permission injection and rollback on failure.
The scripted fixture does not by itself prove the native file picker or
download UI; verify those separately in a renderer connected to a fixture.

## Explicit skills in setup packages

The existing package export API accepts an explicit list of imported skill names:
`POST /api/teams/export` with
`{"format":"package","skillIds":["source-check"]}`. It exports those names from
visible bots only. Omitting `skillIds` or using `[]` includes no skills.
The regular **Export backup** download is unchanged and does not include skills.

Packages carry only `SKILL.md`, never supporting files, enabled state or local
attachment paths. At most 20 skill definitions are accepted, with the existing
256 KiB per-file limit; Markdown exports must also fit the 1 MB import limit.
Names and frontmatter must agree, references must resolve, and conflicting
copies of a named skill are rejected. Teams → Import lists the included names;
imported skills stay disabled until individually reviewed and enabled in the
bot profile. Existing scheduled routines still arrive paused.

```sh
pnpm exec vitest run server/team-package-skills.e2e.test.ts --silent=false
```

This launches and cleans its own fake-engine fixture. It verifies explicit-only
export, disabled imports, unchanged original bots and backup behavior, and
rollback after an induced skill-storage failure. It also checks a real copied
bot turn does not receive disabled instructions. Its JSON output includes the
fixture details and persistent log path. The test does not prove the import
preview's appearance; check that separately in a fixture renderer.

## Recovering bots hidden by older imports

Open **Archived bots** in the sidebar menu and restore the original bots.
Their existing conversations remain attached. No automatic unarchive is
performed: intentionally archived bots must stay archived.
