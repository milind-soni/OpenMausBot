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
   The complete browser image must fit the panel without changing the remote
   page's resolution. Click the same test-page controls at each size: input
   must follow the contained image, not its surrounding letterboxing. Empty
   margins must not click the page; a drag begun on the image can finish there.
7. Reconnect while a restart is still finishing, or change profiles before an
   earlier command finishes. A late response must not disconnect the new view,
   change its error state, or acknowledge an old frame as the new viewer.

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

## One-minute idle and reconnect regression

With an installed Playwright module, the same isolated launcher can run an
automatic native acceptance pass, close its browsers and exit:

```sh
OMB_VERIFY_BROWSER_BINARY=/absolute/path/to/agent-browser \
OMB_VERIFY_BROWSER_CHROME=/absolute/path/to/chrome-headless-shell \
OMB_VERIFY_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs \
node --experimental-strip-types scripts/verify-browser-live.ts --recovery
```

This leaves a native document and unsaved form idle for 65 seconds using the
production runtime timeout, verifies the document identity did not change,
then submits the form through the next agent tool call. In parallel it mounts
the real Browser panel against the isolated server, interrupts its live
EventSource, and verifies automatic reconnect, retained navigation, no replayed
commands, and watch-only control. The interruption is injected; Chrome and the
replacement server stream are real. Narrow/desktop overflow is checked and a
preview screenshot is retained beside the fixture log.

The runtime regression also models a browser descendant that must outlive its
MCP parent, including an MCP parent that ignores EOF. Run those tests on Windows
as well: native macOS acceptance alone does not prove Windows process behavior.

### Lifecycle references

- [agent-browser's MCP loop](https://github.com/vercel-labs/agent-browser/blob/v0.37.0/cli/src/mcp.rs)
  exits on stdin EOF; idle transport retirement must not kill the profile's daemon.
- [agent-browser daemon startup](https://github.com/vercel-labs/agent-browser/blob/v0.37.0/cli/src/connection.rs)
  detaches the daemon. Losing the MCP transport does not prove an accepted
  browser action stopped; interruption still requires an explicit restart.
- [Pi author's browser tools](https://github.com/badlogic/agent-tools/blob/main/browser-tools/browser-nav.js)
  disconnect the automation client instead of closing Chrome after navigation.
- [OpenClaw's CDP connection](https://github.com/openclaw/openclaw/blob/main/extensions/browser/src/browser/cdp-websocket.ts)
  bounds connection retries before commands have side effects. OMB similarly
  retries observation only, never clicks, text, navigation or submissions.

No upstream implementation was copied; OMB already ships agent-browser and
keeps its existing license notices and profile/control boundaries.

Verified 2026-09-19 on macOS arm64 with agent-browser 0.37.0 and the packaged
Chrome Headless Shell: 214 focused checks, typecheck and scoped lint passed.
Two isolated native acceptance runs preserved document identity and the unsaved
form across 65 seconds of idle time, then completed the next tool action. The
real preview recovered its injected stream failure without replaying actions
or restoring a human lease. Windows native acceptance remains outstanding.
Final fixture evidence: `server-1789811974163-38144.log` and
`server-1789811974163-38144-browser.png` in the launcher's printed
`openmausbot-verification-evidence` directory.

## Real Codex chat-to-action acceptance (opt-in)

This uses real model quota. Supply the installed CLI, sign-in file and model
explicitly; the recipe copies only that sign-in into a disposable home. It
does not import personal chats, provider settings, skills or browser profiles.
Never point its requests at the user's running app.

```sh
OMB_VERIFY_CODEX_CLI=/absolute/path/to/codex \
OMB_VERIFY_CODEX_AUTH=/absolute/path/to/auth.json \
OMB_VERIFY_CODEX_MODEL=your-supported-model \
node --experimental-strip-types scripts/verify-codex-surface-live.ts
```

Open the printed preview, select Ziggy, and send ordinary requests without tool
names: open the printed test page, fill the name, click Say hello and verify
the greeting. Confirm the actual screenshot, not just the model's answer.
Use the composer to select **Approve for me**, then ask it to change the name
and open/read the dialog. Routine tool actions should not produce repeated
approval cards; provider review may still ask about other actions.

Ask for Chrome on an unconfigured cloud computer. It must inspect real choices
and report the blocker, not act on a host and claim that it is a VM. The
composer and panel must keep the real destination highlighted during sends.

Ctrl-C closes the exact fixture and removes the copied sign-in and browser
data. VM/cloud transport and turn-bound switching are separately covered by
`server/group-local-vm.e2e.test.ts`, `server/vps-routing.test.ts` and
`server/index.test.ts` with
isolated providers. These are not evidence of real cloud provisioning. Native
Box currently does not expose the agents selector tool, so switching away
from an active native Box destination still requires the composer selector.
