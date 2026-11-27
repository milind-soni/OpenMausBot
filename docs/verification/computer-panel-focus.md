# Computer panel focus hand-off

The chat header's computer button and the side panel it opens are one keyboard
round trip: a keyboard open lands on the panel's own entry point — its active
tab, or its close button when the panel has no tab row — and closing from the
panel puts focus back on the button that opened it.

```sh
OMB_UI_E2E=1 node node_modules/vitest/vitest.mjs run scripts/testing/computer-panel-focus-ui.e2e.test.ts
```

The regression drives the real app through the standard isolated
`scripts/control-omb.ts ui launch` harness and reads `document.activeElement`
after real key presses and a real pointer click:

1. **Enter** on the focused chat header computer button opens the panel with the
   selected tab focused, and that tab matches `:focus-visible`. The panel may
   have moved its own tab by then (an Auto bot's surface resolves after the
   panel is up), so the ring follows the selection until the keyboard user
   leaves the tab row.
2. **Enter** on the panel's own close button closes the panel and focus returns
   to the chat header button.
3. `ui click --name "Bot's computer"` — a pointer click, so the panel carries no
   keyboard intent — opens the panel without moving focus.

Keyboard entry and the close hand-off both need the panel opened from a button,
so the same checks run against `scripts/testing/cloud-preview.tsx`, whose
opener button stays mounted while its panel is up:

```sh
OMB_UI_E2E=1 node node_modules/vitest/vitest.mjs run scripts/testing/cloud-preview.e2e.test.ts
```

There the Computer panel lands on its active tab, and the remote-client panel —
which has no tab row (`src/components/remote-desktop-panel.tsx`) — lands on its
close button; closing either with **Enter** on the focused X returns focus to
the fixture's opener button.

`src/lib/computer-panel-focus.ts` holds the whole rule: the chat header records
where the open came from and whether the keyboard asked for it, the panel takes
that one-shot intent on its first render and defers the focus by one animation
frame (the panel resolves its own tab after mount, and the panel is a lazy
screen), and a close control hands focus back before the close is dispatched —
by the time an unmount cleanup runs, React has already removed the panel and the
browser has dropped focus to the body. Unit coverage lives in
`src/lib/computer-panel-focus.test.ts`, `src/components/ComputerPanel.focus.test.ts`
and `src/components/remote-desktop-panel.focus.test.ts`.

What this does not prove:

- The remote-client panel is proven against that fixture, not through a paired
  phone's real bridge. Run that file's regression with `OMB_UI_E2E=1`, or follow
  item 14 of the cloud preview recipe by hand.
- Escape does not close this panel; only its own X and the gear that hands over
  to bot settings return focus.
- A close with no opener to return to — a bot deletion, the guided tour, another
  panel taking the slot — leaves focus wherever the browser puts it.
- Which tab a bot's panel shows is its own rule; these checks only assert that
  the tab it did select is the one holding focus.
