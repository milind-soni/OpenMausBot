# Page health and recorded browser steps

What a bot's page reports (console errors, uncaught errors, failed requests)
reaches the bot in its browser tool results, and a bot set to **Record browser
steps** leaves a screenshot and a short note of each browser action with the
conversation. Design: [the browser engine plan](../plans/browser-engine.md#7-page-health-and-recorded-browser-steps-implemented).

## The automated check

`scripts/testing/browser-evidence.e2e.test.ts` drives the pinned agent-browser
and its Chrome (Chrome for Testing in CI's ui-smoke job, which reproduces the
1280x577 page) against a local fixture page with a load-time console error, a
500 endpoint, a dead port and a flood of 1,100 errors:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/browser-evidence.e2e.test.ts
```

Locally, `OMB_AGENT_BROWSER_PATH` and `AGENT_BROWSER_EXECUTABLE_PATH` pick an
installed engine and Chrome instead of the download. It checks, through the
real `BrowserRuntime` and then through the real server and a scripted turn:

1. The click whose POST answers 500 and whose page then throws reports both in
   that one result, quoted as page output; a bot that does not record hears
   the late 500 on its next call, and nothing is written for it.
2. Every recorded step has a 1280x720 JPEG, its page, its target and what the
   page reported; a fill records where the typing landed (never the value),
   and the request's body never reaches a record. A password shown in plain
   text inside an open shadow root keeps the step's picture out
   (`secret-on-screen`) until it is masked again.
3. A POST to a dead port is recorded as pending, and the recording bot hears
   it had no answer after 1.5 s.
4. After the engine's error list rotates at 1,000, the next error is still news
   (full Chrome only: the bundled headless shell stalls on such a flood, as
   the plan's upstream notes say).
5. Killing Chrome: a preview frame starts nothing; the bot's next call starts
   it again at 1280x720, and the bot is told its pages are gone. (A frame or
   read that races a dying Chrome and starts it is noted the same way:
   `server/browser-steps.test.ts`.)
6. `GET /api/threads/ID/evidence`, the screenshot under
   `/api/threads/ID/evidence/GENERATION/step-NNNNNN.jpg` and
   `GET /api/threads/ID/evidence.tar` answer for the conversation, and
   deleting the bot deletes its steps.

`scripts/smoke-browser-bundle.mjs` checks the relay contract on each packaged
engine (macOS, Linux, the Windows build): relayed console, errors, failed
requests, a ref's box and a screenshot after an MCP open.

## By hand

1. Launch the [live browser fixture](browser-live.md). In Pepper's settings,
   Access → Browser, turn on **Record browser steps**. The row says the steps
   stay with the conversation for 30 days; with the browser off it asks for the
   browser first.
2. Script a turn that opens the printed test page and clicks a button (the
   fake engine's scripted steps take `"server": "browser"`), or drive the
   browser yourself and let the bot act. Each browser tool result that changed
   the page ends with `Recorded as step N.`; a page error adds one
   `Page reported …` line.
3. Read the steps back:

   ```sh
   curl -s "$URL/api/threads/$THREAD/evidence" | jq '.steps[] | {step, action, imageUrl, imageSkipped}'
   curl -s -o steps.tar "$URL/api/threads/$THREAD/evidence.tar" && tar tf steps.tar
   ```

4. Take control of the browser during a bot action: that step has no image
   (`person-took-control`), and what the page reported while you held it
   (a failed sign-in, a console error) never reaches the bot or a step. Show
   a password in plain text on a page and act:
   no image (`secret-on-screen`); the same on a checkout page after the bot
   types a card number into the payment provider's card frame, until the page
   moves on. After fill_login fills a one-time code, the steps on that page
   have no image (`code-recently-typed`) until the page moves on or a minute
   passes.
5. Delete the conversation: `DATA_DIR/evidence/<thread>` is gone.
