# Bot settings

Launch the isolated renderer fixture directly:

```sh
node --experimental-strip-types scripts/verify-bot-settings.ts
```

Open its printed `previewUrl`. It mounts the real settings dialog and
StoreProvider against a temporary fake-engine server with two named test
bots and one local test skill. No real engine, account, or GitHub import is
used. Ctrl-C stops both servers and removes only the temporary data; the
printed server log remains.

Check these user paths:

1. Open Identity, edit the blurb, then immediately open Overview. The
   changed blurb must appear. Edit Soul, then immediately open History;
   the new row must be present. Close settings and Read saved profiles to
   confirm both values reached the server.
2. Duplicate the selected bot and Read saved profiles. Its SOUL instructions
   must match the source, not just its blurb.
3. Open Memory, expand it, type an unsaved note, visit another section,
   and return. The draft must remain. Save, return to Overview, and expand
   Prompt preview → Memory; it must contain the new note.
4. In Atlas's Skills, disable fixture-check and return to Overview. Its
   Does line and prompt index must disappear. Re-enable it after reviewing
   the full text; both must return on revisiting Overview.
5. Open a skill's full text or its enable-review dialog. Tab must remain
   inside that layer and Escape must close only it. Identity → View full
   must also close without closing settings. Shift-Tab from the initial
   settings focus must remain inside settings.
6. Change Soul twice, then Undo this change from History. Cancel must be
   focused by default, and cancelling must leave the profile unchanged.
   Confirm Restore instructions. The appropriate
   prior text must return and the action must record a new history row.
   Concurrent profile changes must reject a stale undo rather than erase
   newer work.
7. Close settings, Edit SOUL file outside app, then open Soul. Review and
   use/discard the displayed file. The server must apply only that exact
   file and profile revision; concurrent changes must request a re-read.
8. Enable Delay profile reads before opening settings, open History, then
   use Alt+1/Alt+2 to switch bots while that read is pending. Never show one bot's
   history or memory under the other's name.
9. For the same-bot race, set Read delay (ms) to 20000, enable delayed
   reads, and open History. While it is loading, change that fixture bot's
   SOUL through the printed isolated API URL (or the Soul editor). Press
   Alt+D to disable delays without closing settings, visit Identity, then
   return to History. The new row must appear immediately and remain after
   the older 20-second response arrives. Undo that new row and confirm;
   it must use the new history revision and restore the exact prior text.
10. On the isolated fixture only, save a clearly fake key-shaped SOUL
    value, then replace it with ordinary instructions. History must explain
    why the redacted previous version cannot be restored, without an Undo
    button on that row. Exact safe rows must still offer Undo.

This browser fixture verifies renderer interaction and persistence, not
packaged Electron privileges, actual operating-system access, or the
provider-specific execution of elevated approval modes.

## Last exercised

The isolated browser run on 2026-09-06 confirmed immediate Identity/Soul
saves on section changes, SOUL duplication, memory draft retention and
preview refresh, skill disable/review-enable overview refresh, nested
review/blurb dialog keyboard behavior, exact history undo, stale undo
rejection with the newer SOUL retained, and external-file apply/discard.
The restore confirmation defaulted to Cancel; cancellation made no change,
confirmation restored the prior version, and an edit arriving while the
confirmation was open caused a safe rejection with the newer text retained.
With 1.5-second read delays enabled, switching Atlas → Juniper during a
pending History read showed only Juniper's rows when both requests settled.
The overview was also inspected visually. Native Full-access permissions
were not exercised by this browser run.

A second isolated run in Safari on 2026-09-06 used a visibly confirmed
20,000ms delay for the same-bot History race. A new SOUL revision was saved
while the old read was pending; reopening History with delays off showed
the new row, which remained after the old response settled. Confirming
Undo then succeeded and recorded the exact prior text, proving the current
history revision was retained too. A fake key-shaped prior version showed
the unavailable-restore explanation without an Undo button; safe rows kept
their buttons. The dedicated tab and fixture were closed afterward.
