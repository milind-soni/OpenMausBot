# Chat widgets

A bot shows a widget with `show_widget`, the person presses a button on it, and
the press reaches the bot as their next message. Design:
[`docs/superpowers/specs/2026-10-13-chat-widgets-design.md`](../superpowers/specs/2026-10-13-chat-widgets-design.md).

To see widgets with a real bot, paste the prompts in
[Chat widgets: prompts to try with a real bot](widget-prompts.md).

## Server

Run the launcher-managed fake-engine fixture:

```sh
pnpm exec vitest run server/chat-widgets.e2e.test.ts
```

The test starts a disposable server and obtains a real turn capability from
its fake engine. With it, it shows a widget on the internal card route,
replaces it with `update_widget`, and is refused for an unknown node type, a
password field and an unknown widget id. It then presses `confirm` through
`POST /api/bots/ID/messages` with a `widgetAction` and checks that the engine
is given the widget's text, the pressed action and its payload, that the
person's message replies to the widget row, that the row is settled with the
values that were sent, and that a retry with the same `sendId` neither sends
nor settles twice. `messages` shows the `widget` field.

The fixture retains action and response evidence in
`<server-log>.chat-widgets.json`, then stops its child and removes its
temporary data. It records no internal bearer token.

## Renderer

Launch the headless chat UI with a slow fake engine, as in
[Chat UI, driven headlessly](chat-ui.md):

```sh
FAKE_CLAUDE_SLOW_FINISH_GATE=/tmp/widget-gate \
  node --experimental-strip-types scripts/control-omb.ts ui launch --mode slow
```

Send Pepper a message so a turn is open, read that turn's `OMB_COMMS_TOKEN`
from `fake-claude-dump.json` in the printed data directory, and post two of
the samples in `shared/widget-samples.ts` to `/api/internal/options-card` as
`{"tool":"show_widget","widget":…}` with that bearer token. Create the gate
file to let the turn finish, then:

```sh
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json
pnpm control:omb ui snapshot --ui $H
pnpm control:omb ui click --ui $H --name "Create routine"
pnpm control:omb ui wait-settle --ui $H --timeout 60
pnpm control:omb ui click --ui $H --name "Details"
pnpm control:omb ui screenshot --ui $H --out .omb-scratch/verify-evidence/widgets.png
pnpm control:omb ui console --ui $H
```

Expected: the snapshot holds a `Pull requests` list with three rows and the
buttons `Merge the two ready` and `Fix #719 first`, and a `New routine: release
check` form with `Create routine` and `Discard`. After the click the form is
one line, a tick and `Create routine`, and the person's message reads
`Create routine` followed by one `Field: value` line per field. `Details`
shows the form again, read-only, with the values that were sent. The console
has no `error` entries.

What it looks like when the recipe passes: the list in Midnight
(`evidence/widgets/list-midnight.png`), the form before the press
(`evidence/widgets/form-midnight.png`), and the settled form's Details in
Meadow (`evidence/widgets/settled-details-meadow.png`).

![A pull-request list widget with two buttons under it](evidence/widgets/list-midnight.png)

![The settled routine form, opened read-only with the values that were sent](evidence/widgets/settled-details-meadow.png)
