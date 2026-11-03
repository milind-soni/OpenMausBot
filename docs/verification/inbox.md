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

The rail's count comes from `electron/place-inbox-watch.mjs`, tested in `electron/place-inbox-watch.node-test.mjs`. It never
asks a Cloud the Admin says is asleep. It has not been watched against a real sleeping Cloud.
