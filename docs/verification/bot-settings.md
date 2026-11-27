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
    must also close without closing settings. The settings sidebar itself is
    non-modal: Tab may return to chat, while nested dialogs retain focus.
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
11. After a fixture chat turn has usage, open the bot's settings, then click
    the chat header's usage chip. Usage must expand without closing the panel.
    Collapse Usage and click the header chip again; repeat after searching
    for another section. The requested section must open and clear the search.

The full-app automated regression covers those repeated external opens, plus
role creation, optional setup, connected-app settings and failure recovery:

```sh
pnpm exec vitest run scripts/testing/bot-tools-ui.e2e.test.ts src/state/store.test.ts
```

It uses the disposable `control-omb ui` launcher, not the running app. Set
`OMB_UI_E2E=1` to install the pinned browser if unavailable.

This browser fixture verifies renderer interaction and persistence, not
packaged Electron privileges, actual operating-system access, or the
provider-specific execution of elevated approval modes.

The [hosted Slack management fixture](hosted-slack-management.md) separately
checks Slack → Manage in Admin: the row exists only on a hosted workspace,
admins and members read the same link, and switching agents during a pending
load never shows another agent's link.

## Creation drafts and defaults

The same isolated fixture also exposes **New bot** and **New bot defaults →
Edit**. **New bot** makes a bot at once from the saved defaults, with no
dialog. The defaults editor must open immediately, keep a fixed size while
switching sections, and retain edits between sections. Identity → View full
must appear above it; Escape closes only that inner layer.

In the defaults editor, click both random-name buttons repeatedly. Each
suggestion must replace the editable name, avoid an immediate repeat and
existing names, and survive switching away from Identity and back. Type a
custom name, then randomize again. Cancelling must leave the server
unchanged. These buttons also appear in a ready-made bot's review (Templates →
Add) but not in an existing bot's profile. Dataset provenance
and licenses are in `src/data/given-names/`; `src/lib/random-bot-name.test.ts`
checks the pools and selection behavior without a network or model request.

Save defaults containing a title, model, memory topic, skill, and paused
routine. Read the fixture API to confirm no bot or live routine was created.
Press **New bot** and confirm the new bot carries those settings and files
and its routine stays paused. Edit the bot afterward to verify that its
settings still save normally.
Use only the fixture's harmless skills and routines.

Automated coverage:

```sh
pnpm exec vitest run server/new-bot-defaults.test.ts server/new-bot-defaults.e2e.test.ts src/lib/bot-creation-draft.test.ts src/lib/create-configured-bot.test.ts src/lib/new-bot.test.ts src/state/bot-creation.test.ts src/components/NewBotDialog.test.ts
node --test electron/approval-trusted-mode.node-test.mjs
```

The HTTP tests launch a fresh temporary server. They cover defaults persistence,
explicit empty overrides, opt-out, malformed preview requests returning 400,
removed browser-profile references, strict validation, and rejected untrusted
privileged creation. The client tests cover Ask/Auto/Full/Custom creation,
native permission rejection, cleanup, and post-creation activation warnings.
Browser fixtures do not prove packaged operating-system grants or real model
execution; those require the native approval verification separately.

Companion connections make the bot with a single request: they cannot read
host defaults or patch host settings, so the host applies its defaults.
`companion/test/proxy.test.ts` checks creation succeeds while those routes
remain blocked, and `src/lib/new-bot.test.ts` that a paired device sends only
that request. The dialog tests also check that a caller's synchronous
exception or rejected promise after creation is reported without leaving a
retryable creation dialog open.

In the renderer fixture, open **App settings → General → Defaults for new bots → Edit**.
A ready-made bot's review (Templates → Add) retains upstream's **Who can see
it** selection for browser admins; **New bot** makes a bot everyone sees,
changed later in its settings. `scripts/testing/bot-draft-visibility-ui.e2e.test.ts`
selects **Admins only** in that review, creates the bot, and verifies its
stored audience. The initial
POST carries that audience; it is not widened temporarily during later setup.
The fixture injects the native select's change event for cross-platform
headless reliability; it does not verify the operating system's select popup.
Desktop, companion, and default-template editors do not expose that control.

In the defaults editor:
Open **Identity → View full**. Three successive Escape presses must close only
the instruction preview, then the defaults editor, then Settings. Tab navigation
must remain inside the active editor.

`scripts/testing/bot-tools-ui.e2e.test.ts` holds the creation request in the
isolated renderer, verifies that choosing a role alone creates nothing, then
closes and reopens the dialog while saving. Escape and Close remain usable;
the shared pending state prevents a second creation. Completion must not close
a newer dialog. A rejected profile save must roll back the partial bot, retain
the draft, and permit one successful retry. The launcher uses a test-only IPC
stop request so Windows executes the same orderly cleanup as other platforms.

## The Simple panel

The steps above cover the full fold-out view. A fresh install opens the short
tabbed panel instead, and that one is driven through
[Chat UI, driven headlessly](chat-ui.md):

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json
# The preview reads as an existing install, so it starts in Advanced mode.
pnpm control:omb ui eval --ui $H --js "localStorage.setItem('omb-advanced-mode','0'); location.reload(); 'simple'"
pnpm control:omb ui click --ui $H --name "Open Pepper's profile"
pnpm control:omb ui snapshot --ui $H --interactive
```

Expected: six tabs (Details, Memory, Library, Skills, Routines, Vault), and on
Details one row each for Look, Name and job, Instructions, Default model,
Thinking, Before Pepper acts, Where Pepper works, Uses, Phone and Email. Each row's
button says what it acts on (`Edit: Instructions`, `Open: Vault`), so every
name in the snapshot is unique.

Check these user paths:

1. `ui click --name "Edit: Instructions"` opens the box in place; Done closes
   it. Name and job opens its two fields the same way, and opening one row
   closes the other. `ui click --name "Change how Pepper looks"` (the mascot
   itself) opens the look editor from any tab: pick a color and a body, then
   `GET /api/bots` reports that `color` and `mascotBody`.
2. Pick a Thinking step, then `GET /api/bots` on the printed fixture URL: the
   bot's `modelSelection.effort` is that step. Expand Default model: the
   picker shows no second copy of the steps.
3. Where Pepper works offers Auto, this computer and Cloud computer. Pick
   one and read the bot back: `computer` is that place, and Auto clears it.
   A place that cannot be used is held, with its reason on hover. Open the
   Computer panel at its narrowest (360px) and widest: its tabs stay on one
   row, without their icons while the panel is narrow.
4. Create a routine for the bot (`POST /api/routines`), then click its
   `Run … on its schedule` switch on Details. `GET /api/routines` reports
   `enabled: false`, the row reads Paused, and a second click resumes it. The
   Routines tab and the Routines page list carry the same switch.
5. `ui click --name "Open: Vault"`. With no apps connected it offers
   `Let Pepper use apps`, Add app and Add login, and says no app is connected.
   With apps connected, switching one off writes the bot's `connectorScopes`
   with every other connected app still on.

Not proven by this run: real connected apps and real signed-in sites need a
Composio account and a signed-in browser, which the fixture does not have.
Their rows are covered by `src/components/BotSettingsDialog.simple.test.ts` and
`src/lib/bot-app-access.test.ts`.

## Earlier settings verification

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
