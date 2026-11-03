# The Inbox on every plan

`server/place-inbox.e2e.test.ts` boots this computer's server and My Cloud's with the synthetic Claude CLI, and on each:

1. An empty inbox answers with no rows, not 404.
2. A bot's approval and question, in two threads at once, are listed with count 2, each labelled with its thread.
3. An answer through the row's own conversation reaches the bot, its turn goes on and the count clears. A second answer to
   the same card is refused.
4. `message_person` arrives as one line, one row and one notification, and a reply reaches the bot.

On My Cloud it also checks that nobody connects as a guest, that a bot's shell reads nothing, and that a guest's conversation
left behind reaches the owner labelled, with its news kept away.

```sh
pnpm exec vitest run server/place-inbox.e2e.test.ts
```

## The rail, in a real build

`scripts/verify-place-inbox-rail.mjs` runs the packaged app, production main process and all, on a GitHub macOS runner
(`.github/workflows/inbox-rail-check.yml`, by hand or by a push to `ci/inbox-rail-check`). It refuses to run anywhere else,
because it edits `/etc/hosts` and trusts a throwaway certificate. A synthetic Admin and synthetic Clouds answer at their real
addresses over real TLS, and a bot on the synthetic Claude CLI asks a real question on the real local server.

1. The app signs in, and the rail lists this computer and both Clouds.
2. A Cloud never opened on this computer is asked in the background, with the session the app paired by itself. Nothing waits,
   so its tile stays quiet.
3. Lines waiting there fire "{name}: needs you" and the dot. The dot is gone while that place is on screen, and back on leaving.
4. Once the Admin says a Cloud sleeps it is not asked over a whole poll, and it keeps its last number. Awake again with nothing
   waiting, its label and dot clear.
5. A Cloud asleep from the start receives no request in the whole run.
6. While the window shows a Cloud, this computer's tile fires for the question on the local server.

It proves the app's side of the Admin's word. It has not run against a real Cloud, a real sleep or a real wake. The watch's
own rules are in `electron/place-inbox-watch.node-test.mjs`.
