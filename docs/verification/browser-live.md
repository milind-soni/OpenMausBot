# Live browser and profiles

Use installed native engine and Chrome binaries explicitly; the fixture never
uses the operator's browser profiles, OMB home, provider logins, or API keys.

```sh
OMB_VERIFY_BROWSER_BINARY=/absolute/path/to/agent-browser \
OMB_VERIFY_BROWSER_CHROME=/absolute/path/to/chrome-headless-shell \
node --experimental-strip-types scripts/verify-browser-live.ts
```

The launcher uses `launchVerificationServer` with a temporary home and fake
model CLI, creates Pepper, and prints the backend, preview, and local test-page
URLs. Open **only** the printed preview URL. Ctrl-C closes its native browsers,
UI and harness, then removes its temporary data; the server log remains.

1. The panel contains two browser-chrome rows and a live blank page. There is
   no “coming next” card. Navigation/input are disabled while just watching.
2. Click **Take control**, enter the printed test-page URL, and press Enter.
   In the name field, type `AdaX`, press Backspace, then Enter. The streamed
   page must show `Hello, Ada`. Check arrows and Delete, Tab into the notes
   field and enter multiple lines, then open the dialog and close it with
   Escape. These must affect the remote page, not only the surrounding UI.
   Shift+Escape returns focus to the address field without sending Escape to
   the page; keyboard-only users must still be able to reach the toolbar.
3. Return to bot. Reconnect the view, then leave it connected for at least
   30 seconds on the same static image. It must not stall waiting for an ACK.
   The page remains intact and watch-only; take control again and confirm
   editing and Enter still work after reconnecting.
4. The single profile button opens the switcher. Create a shared profile,
   switch to it (a clean browser), then back to Own browser. The previous page
   remains. Rename a shared profile without changing its identity. Confirmed
   deletion clears its bot references without deleting another profile's data.
5. Open a second isolated browser tab on the preview. Take control in one;
   the other must not receive new page frames or accept input. Hand-back and
   disconnect must never release another viewer's control lease.
6. Test narrow (390 px) and desktop widths, fullscreen, tabs, overflow typing,
   and explicit browser restart. No horizontal document overflow or permanent
   settings panels should appear. Profile changes are disabled during control.

Focused automated coverage:

```sh
pnpm exec vitest run server/browser-engine.test.ts server/browser-runtime.test.ts \
  server/browser-proxy.test.ts server/browser-live.test.ts \
  server/browser-live-routes.test.ts server/browser-codex-path.integration.test.ts \
  src/lib/browser-input-queue.test.ts src/lib/browser-profiles.test.ts \
  src/components/BrowserProfilesManager.test.ts src/components/BrowserViewport.test.ts \
  src/components/BrowserPanel.test.ts
```

Those tests cover native transport lifecycle, owner/session scoping, gate races,
stale list/stream events, native key routing, bounded input/backpressure,
revoked capabilities, and exact saved-state cleanup. Native workflow testing
is still required: a green mocked
frame test alone does not prove browser input or restoration works.
