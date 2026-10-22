# Proactive routines and the brief

What [Proactive routines](../proactive-routines.md) promises, and how to see it
without a real Google account, a model or the Electron app.

## The end-to-end scenario

```sh
pnpm exec vitest run server/proactive-routines.e2e.test.ts
```

It launches the same isolated fixture as `control-omb launch`: a temporary home
and data directory and the fake Claude CLI. It points the fixture at
`server/testing/fake-connected-apps.ts`, a loopback stand-in for the
connected-apps service that answers Composio's Gmail and Calendar tools from
`server/testing/fixtures/`. The fake CLI answers the watch with a scripted JSON
result picked by a marker in its prompt (`FAKE_CLAUDE_MARKER_REPLIES`).

Expected:

- The Chief has one default routine, "Keep an eye on my day", with checks,
  `read-and-draft` and `deliver: brief`.
- The first open of the day, with nothing for the person yet, posts no brief,
  opens nothing and starts no AI turn. The first brief, posted by the watch's
  run, carries the intro line, and every later change edits it in place.
- With nothing connected, a check reads nothing and starts no turn.
- New mail and a meeting with other people become **one** run. Its prompt
  holds the mail and the invite in records blocks, and forged markers are
  defused. It runs at `--permission-mode default`, and its system prompt has no
  recent work. Only Gmail and Calendar reads reach the service, and none names
  an account.
- The 10-minute reminder, the prep card and the brief rows appear. The brief is
  edited in place, not posted twice.
- The same mail again is nothing new: there is no second turn.
- Dismiss removes the row with no turn, and the next sort's prompt holds the
  dismissed sender as records.
- A Gmail error is a failed check, never "nothing new": the routine shows
  `checkTrouble` and the brief says to reconnect Gmail.
- A routine of the person's own runs as before: at the bot's own level, as a
  line in the chat.
- In a read-and-draft run, the fake CLI tries to send, post to another app,
  draft to a stranger, draft twice and read. Only one reply draft to the
  thread's sender and the read reach the service. No card is shown, and the
  refusals are in the decision log. The run mounts only `agents`, `composio`
  and OpenMausBot's answerer, and Gmail's answer reaches it as records. A later
  ordinary turn's conversation search does not find the run.

## Unit tests

`server/routine-checks-engine.test.ts` covers the routine engine with checks:
quiet ticks, one batched run, overlap, catch-up, wake times, backoff, the daily
cap, busy bots, and Run now. The others:

- `server/host/routine-checks.test.ts`, `server/host/check-plan.test.ts` and
  `server/host/check-prompts.test.ts`: the checks, planner and prompts;
- `server/host/brief.test.ts` and `server/host/proactive.test.ts`: the brief and
  the default routine;
- `server/connected-reads.test.ts` and `server/records-block.test.ts`: the
  readers and the sanitiser;
- `server/read-and-draft.test.ts`: the fence;
- `server/routes/bot-messages.test.ts` and `server/routes/presence.test.ts`: the
  press fences and presence;
- `src/lib/automations.test.ts`: the Automations row.

## Looking at it in the real renderer

1. Start the fixture from a script that starts the fake connected-apps service
   and calls `launchVerificationServer` with `OMB_COMPOSIO_BROKER_URL` and
   `OMB_COMPOSIO_BROKER_TOKEN` set to it (the launcher passes a loopback
   `http://127.0.0.1:PORT` through). Drive it as the end-to-end test does:
   `POST /api/presence/active`, then `POST /api/routines/<watch>/run`.
2. Serve the renderer against it:
   `OMB_PORT=<fixture port> pnpm exec vite --port 19872 --strictPort`.
3. Open `http://127.0.0.1:19872/` in a headless Chromium. Dismiss the welcome
   tour, then open the Chief's chat and Automations. In the chat, the cards are
   `[data-widget]` elements.

Not verified this way: a real Google account. The Composio slugs and answer
shapes follow its documentation and the fixtures.
