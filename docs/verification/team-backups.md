# Team backups

## User path

Sidebar menu → **Export backup** → a dated `.mausbackup.json` file.
Teams → Import → choose the file → review → **Import backup**.
Import always adds independent copies; existing bots, Chiefs, rooms and chats
are never archived, overwritten or merged. Repeated imports number copies.

The private portable backup includes active and archived bot profiles,
instructions, sections, room membership, Chiefs, playbooks, paused routine
definitions, and conversation text from every task and branch. Action cards
become inert text. It does not include files, screenshots, custom avatars,
workspace memory, account connections, model settings or permissions. This
is not a whole-computer backup. Store the file privately: chat text can
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

## Recovering bots hidden by older imports

Open **Archived bots** in the sidebar menu and restore the original bots.
Their existing conversations remain attached. No automatic unarchive is
performed: intentionally archived bots must stay archived.
